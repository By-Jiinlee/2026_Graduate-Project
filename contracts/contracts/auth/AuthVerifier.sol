// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract AuthVerifier {
    // 사용자 지갑 주소 등록 여부
    mapping(address => bool) public registeredWallets;
    
    // 로그인 인증 nonce
    mapping(address => uint256) public authNonces;
    
    // 거래 인증 nonce
    mapping(address => uint256) public tradeNonces;

    // 이벤트
    event WalletRegistered(address indexed wallet);
    event AuthVerified(address indexed wallet, uint256 nonce);
    event TradeVerified(address indexed wallet, uint256 nonce, uint256 amount, string stockCode);

    // 지갑 주소 등록
    function registerWallet() external {
        require(!registeredWallets[msg.sender], "Already registered");
        registeredWallets[msg.sender] = true;
        authNonces[msg.sender] = 0;
        tradeNonces[msg.sender] = 0;
        emit WalletRegistered(msg.sender);
    }

    // 로그인 nonce 조회
    function getAuthNonce(address wallet) external view returns (uint256) {
        return authNonces[wallet];
    }

    // 거래 nonce 조회
    function getTradeNonce(address wallet) external view returns (uint256) {
        return tradeNonces[wallet];
    }

    // 로그인 2차 인증 서명 검증
    function verifySignature(
        address wallet,
        uint256 nonce,
        bytes memory signature
    ) external returns (bool) {
        require(registeredWallets[wallet], "Wallet not registered");
        require(authNonces[wallet] == nonce, "Invalid nonce");

        bytes32 message = keccak256(
            abi.encodePacked(
                "\x19Ethereum Signed Message:\n32",
                keccak256(abi.encodePacked(wallet, nonce))
            )
        );

        address recovered = recoverSigner(message, signature);
        require(recovered == wallet, "Invalid signature");

        authNonces[wallet]++;

        emit AuthVerified(wallet, nonce);
        return true;
    }

    // 실거래 주문 서명 검증
    function verifyTradeSignature(
        address wallet,
        uint256 nonce,
        uint256 amount,
        string memory stockCode,
        bytes memory signature
    ) external returns (bool) {
        require(registeredWallets[wallet], "Wallet not registered");
        require(tradeNonces[wallet] == nonce, "Invalid nonce");

        bytes32 message = keccak256(
            abi.encodePacked(
                "\x19Ethereum Signed Message:\n32",
                keccak256(abi.encodePacked(wallet, nonce, amount, stockCode))
            )
        );

        address recovered = recoverSigner(message, signature);
        require(recovered == wallet, "Invalid signature");

        tradeNonces[wallet]++;

        emit TradeVerified(wallet, nonce, amount, stockCode);
        return true;
    }

    // 서명 복원 함수
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

        return ecrecover(message, v, r, s);
    }

    // 지갑 등록 여부 확인
    function isRegistered(address wallet) external view returns (bool) {
        return registeredWallets[wallet];
    }
}