// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockTrade {
    address public owner;
    address public pendingOwner;

    struct SeedRecord {
        address wallet;
        uint256 amount;
        uint256 timestamp;
    }

    struct TradeLog {
        address wallet;
        string  stockCode;
        string  side;       // "buy" | "sell"
        uint256 amount;
        uint256 tradeNonce;
        uint256 timestamp;
    }

    SeedRecord[] public seedRecords;
    TradeLog[]   public tradeLogs;

    mapping(address => bool) public hasSeed;

    // 장부 잎의 원본 — 서버 ledgerMerkle.orderLeaf 와 같은 필드·순서·타입이어야 한다.
    // 금액은 원 단위 ×100(전), 체결 시각은 UNIX 초.
    struct LedgerOrder {
        uint256 orderId;
        uint256 userId;
        uint256 stockId;
        uint8   side;       // 0 매수, 1 매도
        uint8   orderType;  // 0 시장가, 1 지정가
        uint256 quantity;
        uint256 price;
        uint256 totalAmount;
        uint64  filledAt;
    }

    // ─── 일별 거래 장부 고정 ───────────────────────────────────
    // 하루치 체결 내역 전체의 머클 루트. 키는 KST 날짜(yyyymmdd).
    // 건마다 기록(logTrade)하면 거래 수에 비례해 비용이 들고 재인증 주문만 남지만,
    // 루트 하나를 고정하면 하루 한 번의 비용으로 그날의 모든 체결을 위·변조 탐지 대상에 넣는다.
    mapping(uint32 => bytes32) public ledgerRoots;
    mapping(uint32 => uint32)  public ledgerCounts;

    event SeedIssued(address indexed wallet, uint256 amount, uint256 timestamp);
    event TradeLogged(address indexed wallet, string stockCode, string side, uint256 amount, uint256 tradeNonce, uint256 timestamp);
    event LedgerAnchored(uint32 indexed day, bytes32 root, uint32 count, uint256 timestamp);
    event OwnershipTransferInitiated(address indexed currentOwner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not authorized");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    // ─── 버짓 지급 기록 ───────────────────────────────────────
    function recordSeed(address wallet, uint256 amount) external onlyOwner {
        require(wallet != address(0), "Invalid address");
        require(!hasSeed[wallet], "Seed already issued");

        hasSeed[wallet] = true;
        seedRecords.push(SeedRecord(wallet, amount, block.timestamp));

        emit SeedIssued(wallet, amount, block.timestamp);
    }

    // ─── 고액 거래 감사 로그 ──────────────────────────────────
    function logTrade(
        address wallet,
        string memory stockCode,
        string memory side,
        uint256 amount,
        uint256 tradeNonce
    ) external onlyOwner {
        require(wallet != address(0), "Invalid address");

        tradeLogs.push(TradeLog(wallet, stockCode, side, amount, tradeNonce, block.timestamp));

        emit TradeLogged(wallet, stockCode, side, amount, tradeNonce, block.timestamp);
    }

    // ─── 일별 장부 루트 고정 ──────────────────────────────────
    // 한 번 고정한 날짜는 다시 쓸 수 없다. 서버 키가 탈취되어도 이미 고정된 과거 장부는
    // 고칠 수 없고, 공격자가 할 수 있는 일은 아직 고정되지 않은 날짜를 먼저 채우는 것뿐이다.
    function anchorLedger(uint32 day, bytes32 root, uint32 count) external onlyOwner {
        require(day >= 20000101 && day <= 29991231, "Invalid day");
        require(root != bytes32(0) && count > 0, "Empty ledger");
        require(ledgerRoots[day] == bytes32(0), "Already anchored");

        ledgerRoots[day] = root;
        ledgerCounts[day] = count;
        emit LedgerAnchored(day, root, count, block.timestamp);
    }

    // 주문 한 건이 그날의 고정된 장부에 포함되어 있는지 누구나 확인할 수 있다(가스 없는 조회).
    // 서버를 신뢰하지 않는 제3자도 주문 내용과 서버가 내준 증명만으로 검증한다.
    // 잎을 호출자에게 받지 않고 주문 내용으로 여기서 계산한다 — 해시 값을 그대로 받으면
    // 트리의 내부 노드를 "주문"인 것처럼 제출해도 통과하기 때문이다.
    // 잎 = keccak256(keccak256(abi.encode(order))) 이중 해시, 내부 노드 = 정렬 쌍 해시.
    function verifyOrderInclusion(
        uint32 day,
        LedgerOrder calldata order,
        bytes32[] calldata proof
    ) external view returns (bool) {
        bytes32 root = ledgerRoots[day];
        if (root == bytes32(0)) return false;
        bytes32 h = keccak256(bytes.concat(keccak256(abi.encode(order))));
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 p = proof[i];
            h = h < p ? keccak256(abi.encodePacked(h, p)) : keccak256(abi.encodePacked(p, h));
        }
        return h == root;
    }

    // ─── 조회 ─────────────────────────────────────────────────
    function getSeedCount() external view returns (uint256) {
        return seedRecords.length;
    }

    function getTradeLogCount() external view returns (uint256) {
        return tradeLogs.length;
    }

    // ─── 2단계 ownership 이전 ─────────────────────────────────
    // 이전 버전에는 이전 기능이 없어, 서버 키를 교체하려면 컨트랙트를 새로 배포해야 했고
    // 그 순간 지금까지의 기록과 주소가 끊어졌다.
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Invalid address");
        require(newOwner != owner, "Already owner");
        pendingOwner = newOwner;
        emit OwnershipTransferInitiated(owner, newOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "Not pending owner");
        emit OwnershipTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }
}
