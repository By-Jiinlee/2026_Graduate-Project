import { createPublicClient, createWalletClient, http, getAddress } from 'viem'
import { sepolia } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import fs from 'fs'
import path from 'path'

// ABI 로드
const abiPath = path.join(
  __dirname,
  '../../../../contracts/abi/AuthVerifier.abi.json',
)
const abi = JSON.parse(fs.readFileSync(abiPath, 'utf-8'))

const contractAddress = getAddress(process.env.CONTRACT_AUTH_ADDRESS as string)

// Public Client (읽기 전용)
const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(process.env.SEPOLIA_RPC_URL),
})

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

// nonce 조회
export const getAuthNonce = async (walletAddress: string): Promise<bigint> => {
  const result = await publicClient.readContract({
    address: contractAddress,
    abi,
    functionName: 'getAuthNonce',
    args: [getAddress(walletAddress)],
  })
  return result as bigint
}

// 서명 검증
export const verifySignature = async (
  walletAddress: string,
  nonce: bigint,
  signature: string,
): Promise<boolean> => {
  const account = privateKeyToAccount(
    process.env.SERVER_PRIVATE_KEY as `0x${string}`,
  )

  const walletClient = createWalletClient({
    account,
    chain: sepolia,
    transport: http(process.env.SEPOLIA_RPC_URL),
  })

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
