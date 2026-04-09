import {
  createPublicClient,
  createWalletClient,
  http,
  getAddress,
  encodeAbiParameters,
  keccak256,
  concat,
  toBytes,
  toHex,
} from 'viem'
import { sepolia } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import fs from 'fs'
import path from 'path'

// ABI 로드
const abiPath = path.join(__dirname, '../../../../contracts/abi/AuthVerifier.abi.json')
const abi = JSON.parse(fs.readFileSync(abiPath, 'utf-8'))

const mockTradeAbiPath = path.join(__dirname, '../../../../contracts/abi/MockTrade.abi.json')
const mockTradeAbi = JSON.parse(fs.readFileSync(mockTradeAbiPath, 'utf-8'))

const contractAddress = getAddress(process.env.CONTRACT_AUTH_ADDRESS as string)
const mockTradeAddress = getAddress(process.env.CONTRACT_MOCK_TRADE_ADDRESS as string)

const account = privateKeyToAccount(
  process.env.SERVER_PRIVATE_KEY as `0x${string}`,
)

// Public Client (읽기 전용)
const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(process.env.SEPOLIA_RPC_URL),
})

// Wallet Client (쓰기 전용)
const walletClient = createWalletClient({
  account,
  chain: sepolia,
  transport: http(process.env.SEPOLIA_RPC_URL),
})

// ─── 읽기 함수 ────────────────────────────────────────────────

// 지갑 등록 여부 확인
export const isWalletRegistered = async (
  walletAddress: string,
): Promise<boolean> => {
  const result = await publicClient.readContract({
    address: contractAddress,
    abi,
    functionName: 'isRegistered',
    args: [getAddress(walletAddress)],
  })
  return result as boolean
}

// 로그인 nonce 조회
export const getAuthNonce = async (walletAddress: string): Promise<bigint> => {
  const result = await publicClient.readContract({
    address: contractAddress,
    abi,
    functionName: 'getAuthNonce',
    args: [getAddress(walletAddress)],
  })
  return result as bigint
}

// 거래 nonce 조회
export const getTradeNonce = async (walletAddress: string): Promise<bigint> => {
  const result = await publicClient.readContract({
    address: contractAddress,
    abi,
    functionName: 'getTradeNonce',
    args: [getAddress(walletAddress)],
  })
  return result as bigint
}

// ─── 서명 메시지 생성 헬퍼 (클라이언트 서명용) ────────────────

// 로그인 서명 메시지 생성
export const buildAuthMessage = (
  walletAddress: string,
  nonce: bigint,
): `0x${string}` => {
  const innerHash = keccak256(
    concat([
      toBytes(BigInt(sepolia.id), { size: 32 }),
      toBytes(contractAddress, { size: 20 }),
      toBytes(getAddress(walletAddress), { size: 20 }),
      toBytes(nonce, { size: 32 }),
    ]),
  )
  return innerHash
}

// 거래 서명 메시지 생성
export const buildTradeMessage = (
  walletAddress: string,
  nonce: bigint,
  amount: bigint,
  stockCode: string,
): `0x${string}` => {
  return keccak256(
    concat([
      toBytes(BigInt(sepolia.id),          { size: 32 }),
      toBytes(contractAddress,             { size: 20 }),
      toBytes(getAddress(walletAddress),   { size: 20 }),
      toBytes(nonce,                       { size: 32 }),
      toBytes(amount,                      { size: 32 }),
      new TextEncoder().encode(stockCode),
    ]),
  )
}

// ─── 쓰기 함수 ────────────────────────────────────────────────

// 서버 대리 지갑 등록 (회원가입 시)
export const registerWalletFor = async (
  walletAddress: string,
): Promise<void> => {
  const { request } = await publicClient.simulateContract({
    address: contractAddress,
    abi,
    functionName: 'registerWalletFor',
    args: [getAddress(walletAddress)],
    account,
  })
  await walletClient.writeContract(request)
}

// 서버 대리 지갑 등록 취소 (탈퇴 시)
export const unregisterWallet = async (
  walletAddress: string,
): Promise<void> => {
  const { request } = await publicClient.simulateContract({
    address: contractAddress,
    abi,
    functionName: 'unregisterWallet',
    args: [getAddress(walletAddress)],
    account,
  })
  await walletClient.writeContract(request)
}

// 로그인 2차 인증 서명 검증
export const verifySignature = async (
  walletAddress: string,
  nonce: bigint,
  signature: string,
): Promise<boolean> => {
  const { request } = await publicClient.simulateContract({
    address: contractAddress,
    abi,
    functionName: 'verifySignature',
    args: [getAddress(walletAddress), nonce, signature as `0x${string}`],
    account,
  })
  await walletClient.writeContract(request)
  return true
}

// 거래 서명 검증
export const verifyTradeSignature = async (
  walletAddress: string,
  nonce: bigint,
  amount: bigint,
  stockCode: string,
  signature: string,
): Promise<boolean> => {
  const { request } = await publicClient.simulateContract({
    address: contractAddress,
    abi,
    functionName: 'verifyTradeSignature',
    args: [
      getAddress(walletAddress),
      nonce,
      amount,
      stockCode,
      signature as `0x${string}`,
    ],
    account,
  })
  await walletClient.writeContract(request)
  return true
}
export const signMessage = async (
  message: `0x${string}`,
): Promise<`0x${string}`> => {
  const signature = await walletClient.signMessage({
    message: { raw: message },
  })
  return signature
}

// ─── MockTrade: 버짓 지급 기록 ────────────────────────────────

export const recordSeed = async (
  walletAddress: string,
  amount: bigint,
): Promise<void> => {
  const { request } = await publicClient.simulateContract({
    address: mockTradeAddress,
    abi: mockTradeAbi,
    functionName: 'recordSeed',
    args: [getAddress(walletAddress), amount],
    account,
  })
  await walletClient.writeContract(request)
}

// ─── MockTrade: 고액 거래 감사 로그 ──────────────────────────

export const logTrade = async (
  walletAddress: string,
  stockCode: string,
  side: 'buy' | 'sell',
  amount: bigint,
  tradeNonce: bigint,
): Promise<void> => {
  const { request } = await publicClient.simulateContract({
    address: mockTradeAddress,
    abi: mockTradeAbi,
    functionName: 'logTrade',
    args: [getAddress(walletAddress), stockCode, side, amount, tradeNonce],
    account,
  })
  await walletClient.writeContract(request)
}
