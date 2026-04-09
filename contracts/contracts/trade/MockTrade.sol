// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockTrade {
    address public owner;

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

    event SeedIssued(address indexed wallet, uint256 amount, uint256 timestamp);
    event TradeLogged(address indexed wallet, string stockCode, string side, uint256 amount, uint256 tradeNonce, uint256 timestamp);

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

    // ─── 조회 ─────────────────────────────────────────────────
    function getSeedCount() external view returns (uint256) {
        return seedRecords.length;
    }

    function getTradeLogCount() external view returns (uint256) {
        return tradeLogs.length;
    }
}
