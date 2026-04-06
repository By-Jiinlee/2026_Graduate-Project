# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 언어 설정

사용자에게 확인 요청, 내용 설명, 결과 보고 등 모든 커뮤니케이션은 **한국어**로 제공한다.

## Commands

### Client (React frontend)
```bash
cd client
npm run dev        # Start Vite dev server on http://localhost:5173
npm run build      # TypeScript check + Vite production build
npm run lint       # ESLint
npm run preview    # Preview production build
```

### Server (Express backend)
```bash
cd server
npm run dev        # Nodemon with hot reload
npm run build      # TypeScript compilation to ./dist
npm start          # Run compiled dist/index.js
```

### Smart Contracts (Hardhat)
```bash
cd contracts
npx hardhat compile
npx hardhat test
npx hardhat run scripts/deploy.ts --network sepolia
```

## Architecture Overview

This is a **full-stack stock trading platform** with Web3 authentication.

- **`/client`** — React 19 + Vite + TypeScript frontend, Tailwind CSS, connects to backend at `http://localhost:3000`
- **`/server`** — Express 5 + Sequelize + MySQL backend, serves all APIs under `/api/*`
- **`/contracts`** — Hardhat project with a Solidity `AuthVerifier` contract deployed on Ethereum Sepolia testnet

### Authentication Flow

Two-step Web3 login (non-trusted device):
1. **Step 1** (`POST /api/auth/login/step1`): Email + password validation → returns `userId`, `walletAddress`, `nonce`
2. **Step 2** (`POST /api/auth/login/step2`): Client signs a message with MetaMask → server verifies signature on-chain via `AuthVerifier.sol` → issues JWT cookies

Trusted device login skips step 2 and issues JWT directly after step 1. Registration requires email verification and MetaMask wallet connection.

### Smart Contract Integration

`AuthVerifier.sol` on Sepolia handles wallet registration and nonce-based signature verification. The server uses Viem (`/server/src/services/web3/contractService.ts`) to interact with the contract. Auth message is a keccak256 hash of `(chainId, contractAddress, walletAddress, nonce)`. Contract ABI is read from `/contracts/abi/AuthVerifier.abi.json`.

### Database

MySQL via Sequelize ORM. Local dev config: `127.0.0.1:3306`, user `labuser`, password `labpassword`, database `lab_db`. Supports Railway (via `DATABASE_URL` env var) for production.

Key model groups:
- **`/server/src/models/user/`** — `User`, `Wallet` (1:1 with User), `UserDevice`, `EmailVerificationToken`
- **`/server/src/models/auth/`** — `EmailVerification`, `SmsVerification`, `LoginRecord`, `Blacklist`, `WithdrawnUser`
- **`/server/src/models/market/`** — `StockPrice` (daily OHLCV), `FinancialStatement`, `ShortSelling`, `EcosIndicator`
- **`/server/src/models/trade/`** — `RealOrder`, `VirtualOrder`

### Market Data

Stock price data comes from the **Korea Investment & Securities (KIS) API**. Schedulers in `/server/src/schedulers/market/` handle automated data collection (StockPrice, FinancialStatement, EcosIndicator, ShortSelling, Stock52Week, ForeignAndInstitutional), but are **commented out** in `index.ts` and must be manually triggered or re-enabled.

### Server Middleware

- `authMiddleware` (`isAuthenticated`) — JWT validation via cookie
- `rateLimitMiddleware` — `loginRateLimiter`, `emailCodeRateLimiter`, `smsCodeRateLimiter`
- `authValidation` — Input validation schemas for auth routes

### Frontend Routing

Protected routes (`/manage`, `/dashboard`, `/community`, `/support`, `/events`, `/mypage`) use a `ProtectedRoute` component that reads a login cookie and redirects to `/login` with a 5-second countdown if unauthenticated.
