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
//
// 원본은 저장소 루트의 contracts/abi 지만, 배포 단위는 server/ 하나다(레일웨이 Root
// Directory = server). 루트를 참조하면 컨테이너에 그 경로가 없어 모듈 로드 시점에
// ENOENT 로 죽는다. 그래서 server/abi 에 사본을 두고 그쪽을 읽는다.
// 컨트랙트를 다시 컴파일하면 contracts/abi → server/abi 로 복사해야 한다.
//
// 경로는 src(ts-node)와 dist(빌드본) 양쪽에서 같은 깊이라 그대로 통한다.
const ABI_DIR = path.join(__dirname, '../../../abi')

const loadAbi = (file: string): any => {
  const full = path.join(ABI_DIR, file)
  try {
    return JSON.parse(fs.readFileSync(full, 'utf-8'))
  } catch (err: any) {
    throw new Error(
      `컨트랙트 ABI 를 읽지 못했습니다: ${full}\n` +
      `contracts/abi 의 ${file} 을 server/abi 로 복사했는지 확인하세요. (${err.code ?? err.message})`,
    )
  }
}

const abi = loadAbi('AuthVerifier.abi.json')
const mockTradeAbi = loadAbi('MockTrade.abi.json')

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
  try {
    const { request } = await publicClient.simulateContract({
      address: contractAddress,
      abi,
      functionName: 'verifySignature',
      args: [getAddress(walletAddress), nonce, signature as `0x${string}`],
      account,
    })
    await walletClient.writeContract(request)
    return true
  } catch (e: any) {
    const msg: string = e?.message ?? ''
    if (msg.includes('Invalid signature') || msg.includes('reverted')) {
      throw new Error('MetaMask 서명이 올바르지 않습니다. 등록된 지갑 주소로 서명해주세요.')
    }
    throw e
  }
}

// 거래 서명 검증
export const verifyTradeSignature = async (
  walletAddress: string,
  nonce: bigint,
  amount: bigint,
  stockCode: string,
  signature: string,
): Promise<boolean> => {
  try {
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
  } catch (e: any) {
    const msg: string = e?.message ?? ''
    if (msg.includes('Invalid signature') || msg.includes('reverted')) {
      throw new Error('MetaMask 서명이 올바르지 않습니다. 등록된 지갑 주소로 서명해주세요.')
    }
    throw e
  }
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
