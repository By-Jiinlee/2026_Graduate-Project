// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract AuthVerifier {
    address public owner;
    address public pendingOwner;

    mapping(address => bool) public registeredWallets;
    mapping(address => uint256) public authNonces;
    mapping(address => uint256) public tradeNonces;

    event WalletRegistered(address indexed wallet);
    event WalletUnregistered(address indexed wallet);
    event AuthVerified(address indexed wallet, uint256 nonce);
    event TradeVerified(address indexed wallet, uint256 nonce, uint256 amount, string stockCode);
    event OwnershipTransferInitiated(address indexed currentOwner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not authorized");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    // ─── 서버 전용 대리 등록 ───────────────────────────────────────
    function registerWalletFor(address wallet) external onlyOwner {
        require(wallet != address(0), "Invalid address");
        require(!registeredWallets[wallet], "Already registered");
        registeredWallets[wallet] = true;
        authNonces[wallet] = 0;
        tradeNonces[wallet] = 0;
        emit WalletRegistered(wallet);
    }

    // ─── 서버 전용 지갑 등록 취소 (탈퇴 처리) ──────────────────────
    function unregisterWallet(address wallet) external onlyOwner {
        require(registeredWallets[wallet], "Not registered");
        registeredWallets[wallet] = false;
        authNonces[wallet] = 0;
        tradeNonces[wallet] = 0;
        emit WalletUnregistered(wallet);
    }

    // ─── nonce 조회 ────────────────────────────────────────────────
    function getAuthNonce(address wallet) external view returns (uint256) {
        return authNonces[wallet];
    }

    function getTradeNonce(address wallet) external view returns (uint256) {
        return tradeNonces[wallet];
    }

    // ─── 로그인 2차 인증 서명 검증 (onlyOwner) ────────────────────
    function verifySignature(
        address wallet,
        uint256 nonce,
        bytes memory signature
    ) external onlyOwner returns (bool) {
        require(registeredWallets[wallet], "Wallet not registered");
        require(authNonces[wallet] == nonce, "Invalid nonce");

        bytes32 message = keccak256(
            abi.encodePacked(
                "\x19Ethereum Signed Message:\n32",
                keccak256(abi.encodePacked(
                    block.chainid,
                    address(this),
                    wallet,
                    nonce
                ))
            )
        );

        address recovered = recoverSigner(message, signature);
        require(recovered == wallet, "Invalid signature");

        authNonces[wallet]++;
        emit AuthVerified(wallet, nonce);
        return true;
    }

    // ─── 실거래 주문 서명 검증 (onlyOwner) ────────────────────────
    function verifyTradeSignature(
        address wallet,
        uint256 nonce,
        uint256 amount,
        string memory stockCode,
        bytes memory signature
    ) external onlyOwner returns (bool) {
        require(registeredWallets[wallet], "Wallet not registered");
        require(tradeNonces[wallet] == nonce, "Invalid nonce");

        bytes32 message = keccak256(
            abi.encodePacked(
                "\x19Ethereum Signed Message:\n32",
                keccak256(abi.encodePacked(
                    block.chainid,
                    address(this),
                    wallet,
                    nonce,
                    amount,
                    stockCode
                ))
            )
        );

        address recovered = recoverSigner(message, signature);
        require(recovered == wallet, "Invalid signature");

        tradeNonces[wallet]++;
        emit TradeVerified(wallet, nonce, amount, stockCode);
        return true;
    }

    // ─── 서명 복원 ────────────────────────────────────────────────
    function recoverSigner(
        bytes32 message,
        bytes memory signature
    ) internal pure returns (address) {
        require(signature.length == 65, "Invalid signature length");

        bytes32 r;
        bytes32 s;
        uint8 v;

        assembly {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }

        if (v < 27) v += 27;
        require(v == 27 || v == 28, "Invalid signature v value");

        address recovered = ecrecover(message, v, r, s);
        require(recovered != address(0), "Invalid signature");

        return recovered;
    }

    // ─── 지갑 등록 여부 확인 ──────────────────────────────────────
    function isRegistered(address wallet) external view returns (bool) {
        return registeredWallets[wallet];
    }

    // ─── 2단계 ownership 이전 ─────────────────────────────────────
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
