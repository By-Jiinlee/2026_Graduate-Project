import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import User from '../../models/user/User'
import Wallet from '../../models/user/Wallet'
import EmailVerification from '../../models/auth/EmailVerification'
import SmsVerification from '../../models/auth/SmsVerification'
import LoginRecord from '../../models/auth/LoginRecord'
import {
  isWalletRegistered,
  registerWalletFor,
  unregisterWallet,
  getAuthNonce,
  verifySignature as contractVerifySignature,
  buildAuthMessage,
} from '../web3/contractService'
import { sendVerificationEmail } from './emailService'
import { sendVerificationSms } from './smsService'
import { Op } from 'sequelize'

// ─── 이메일 인증 ──────────────────────────────────────────────

// 이메일 인증코드 발송
export const sendEmailCode = async (email: string): Promise<void> => {
  // 이메일 중복 확인
  const existing = await User.findOne({ where: { email } })
  if (existing) throw new Error('이미 사용 중인 이메일입니다')

  // 기존 미사용 코드 무효화
  await EmailVerification.update(
    { is_used: true },
    { where: { email, is_used: false } },
  )

  // 재발송 횟수 확인 (일 5회 제한)
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)

  const sendCount = await EmailVerification.count({
    where: {
      email,
      created_at: { [Op.gte]: todayStart },
    },
  })
  if (sendCount >= 5) throw new Error('일일 인증 요청 한도를 초과했습니다')

  // 쿨타임 확인 (1분)
  const lastSent = await EmailVerification.findOne({
    where: { email },
    order: [['created_at', 'DESC']],
  })
  if (lastSent) {
    const diff = Date.now() - new Date(lastSent.created_at!).getTime()
    if (diff < 60 * 1000) throw new Error('1분 후 다시 요청해주세요')
  }

  // 6자리 코드 생성
  const code = crypto.randomInt(100000, 999999).toString()
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000) // 5분

  await EmailVerification.create({
    email,
    code,
    expires_at: expiresAt,
    is_used: false,
    fail_count: 0,
  })
  await sendVerificationEmail(email, code)
}

// 이메일 인증코드 검증
export const verifyEmailCode = async (
  email: string,
  code: string,
): Promise<void> => {
  const record = await EmailVerification.findOne({
    where: { email, is_used: false },
    order: [['created_at', 'DESC']],
  })

  if (!record) throw new Error('인증코드가 존재하지 않습니다')
  if (new Date() > record.expires_at)
    throw new Error('인증코드가 만료되었습니다')

  // 실패 횟수 확인 (5회 초과 시 무효화)
  if (record.fail_count >= 5) {
    await record.update({ is_used: true })
    throw new Error('인증 시도 횟수를 초과했습니다. 코드를 재발급 받으세요')
  }

  if (record.code !== code) {
    await record.increment('fail_count')
    const remaining = 4 - record.fail_count
    throw new Error(`인증코드가 올바르지 않습니다. 남은 시도: ${remaining}회`)
  }

  await record.update({ is_used: true })
}

// ─── SMS 인증 ────────────────────────────────────────────────

// SMS 인증코드 발송
export const sendSmsCode = async (phone: string): Promise<void> => {
  // 휴대폰 중복 확인
  const existing = await User.findOne({ where: { phone } })
  if (existing) throw new Error('이미 사용 중인 휴대폰 번호입니다')

  // 기존 미사용 코드 무효화
  await SmsVerification.update(
    { is_used: true },
    { where: { phone, is_used: false } },
  )

  // 재발송 횟수 확인 (일 5회 제한)
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)

  const sendCount = await SmsVerification.count({
    where: {
      phone,
      created_at: { [Op.gte]: todayStart },
    },
  })
  if (sendCount >= 5) throw new Error('일일 인증 요청 한도를 초과했습니다')

  // 쿨타임 확인 (1분)
  const lastSent = await SmsVerification.findOne({
    where: { phone },
    order: [['created_at', 'DESC']],
  })
  if (lastSent) {
    const diff = Date.now() - new Date(lastSent.created_at!).getTime()
    if (diff < 60 * 1000) throw new Error('1분 후 다시 요청해주세요')
  }

  // 6자리 코드 생성
  const code = crypto.randomInt(100000, 999999).toString()
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000) // 5분

  await SmsVerification.create({
    phone,
    code,
    expires_at: expiresAt,
    is_used: false,
    fail_count: 0,
  })
  await sendVerificationSms(phone, code)
}

// SMS 인증코드 검증
export const verifySmsCode = async (
  phone: string,
  code: string,
): Promise<void> => {
  const record = await SmsVerification.findOne({
    where: { phone, is_used: false },
    order: [['created_at', 'DESC']],
  })

  if (!record) throw new Error('인증코드가 존재하지 않습니다')
  if (new Date() > record.expires_at)
    throw new Error('인증코드가 만료되었습니다')

  if (record.fail_count >= 5) {
    await record.update({ is_used: true })
    throw new Error('인증 시도 횟수를 초과했습니다. 코드를 재발급 받으세요')
  }

  if (record.code !== code) {
    await record.increment('fail_count')
    const remaining = 4 - record.fail_count
    throw new Error(`인증코드가 올바르지 않습니다. 남은 시도: ${remaining}회`)
  }

  await record.update({ is_used: true })
}

// ─── 회원가입 ─────────────────────────────────────────────────

export const register = async (
  email: string,
  password: string,
  name: string,
  phone: string,
  walletAddress: string,
  walletSignature: string,
  terms_agreed: boolean,
  privacy_agreed: boolean,
  location_agreed: boolean,
  age_agreed: boolean,
  marketing_agreed: boolean,
) => {
  const emailVerified = await EmailVerification.findOne({
    where: { email, is_used: true },
    order: [['created_at', 'DESC']],
  })
  if (!emailVerified) throw new Error('이메일 인증이 완료되지 않았습니다')

  if (phone) {
    const smsVerified = await SmsVerification.findOne({
      where: { phone, is_used: true },
      order: [['created_at', 'DESC']],
    })
    if (!smsVerified) throw new Error('휴대폰 인증이 완료되지 않았습니다')
  }

  const existingWallet = await Wallet.findOne({
    where: { address: walletAddress },
  })
  if (existingWallet) throw new Error('이미 등록된 지갑 주소입니다')

  const onChainRegistered = await isWalletRegistered(walletAddress)
  if (onChainRegistered) throw new Error('이미 온체인에 등록된 지갑 주소입니다')

  const message = buildAuthMessage(walletAddress, BigInt(0))
  const { recoverMessageAddress } = await import('viem')
  const recovered = await recoverMessageAddress({
    message: { raw: message },
    signature: walletSignature as `0x${string}`,
  })
  if (recovered.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new Error('지갑 서명 검증에 실패했습니다')
  }

  const password_hash = await bcrypt.hash(password, 12)

  const user = await User.create({
    email,
    password_hash,
    name,
    phone,
    role: 'user',
    is_email_verified: true,
    is_locked: false,
    status: 'active',
    terms_agreed,
    privacy_agreed,
    location_agreed,
    age_agreed,
    marketing_agreed,
  })

  await registerWalletFor(walletAddress)

  await Wallet.create({
    user_id: user.id,
    address: walletAddress,
    network: 'sepolia',
    seed_amount: 0,
    is_primary: true,
    linked_at: new Date(),
  })

  return user
}

// ─── 로그인 ───────────────────────────────────────────────────

// 1단계: 이메일 + 비밀번호 검증 → nonce 반환
export const loginStep1 = async (email: string, password: string) => {
  const user = await User.findOne({ where: { email } })
  if (!user) throw new Error('이메일 또는 비밀번호가 올바르지 않습니다')
  if (user.is_locked)
    throw new Error('계정이 잠겼습니다. 관리자에게 문의하세요')
  if (user.status === 'withdrawn') throw new Error('탈퇴한 계정입니다')

  const isMatch = await bcrypt.compare(password, user.password_hash)
  if (!isMatch) throw new Error('이메일 또는 비밀번호가 올바르지 않습니다')

  const wallet = await Wallet.findOne({
    where: { user_id: user.id, is_primary: true },
  })
  if (!wallet) throw new Error('지갑이 등록되지 않은 계정입니다')

  // 온체인 nonce 조회
  const nonce = await getAuthNonce(wallet.address)

  return {
    userId: user.id,
    walletAddress: wallet.address,
    nonce: nonce.toString(),
  }
}

// 2단계: 지갑 서명 검증 → JWT 발급
export const loginStep2 = async (
  userId: number,
  walletAddress: string,
  signature: string,
  ip: string,
  userAgent: string,
) => {
  const user = await User.findByPk(userId)
  if (!user) throw new Error('유저를 찾을 수 없습니다')

  const nonce = await getAuthNonce(walletAddress)

  // 온체인 서명 검증
  await contractVerifySignature(walletAddress, nonce, signature)

  // 로그인 기록 저장
  await saveLoginRecord(userId, walletAddress, ip, userAgent)

  // JWT 발급
  const accessToken = jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET as string,
    { expiresIn: '1h' },
  )

  const refreshToken = jwt.sign(
    { id: user.id },
    process.env.JWT_REFRESH_SECRET as string,
    { expiresIn: '7d' },
  )

  return { user, accessToken, refreshToken, walletAddress }
}

// ─── 로그인 기록 ──────────────────────────────────────────────

interface GeoResponse {
  country?: string
  regionName?: string
  city?: string
}

const saveLoginRecord = async (
  userId: number,
  walletAddress: string,
  ip: string,
  userAgent: string,
) => {
  try {
    const geoRes = await fetch(
      `http://ip-api.com/json/${ip}?fields=country,regionName,city`,
    )
    const geo = (await geoRes.json()) as GeoResponse

    await LoginRecord.create({
      user_id: userId,
      wallet_address: walletAddress,
      ip_address: ip,
      country: geo.country ?? undefined,
      region: geo.regionName ?? undefined,
      city: geo.city ?? undefined,
      user_agent: userAgent,
      logged_at: new Date(),
    })
  } catch {
    console.error('로그인 기록 저장 실패')
  }
}

// ─── 탈퇴 ─────────────────────────────────────────────────────

export const withdraw = async (userId: number) => {
  const user = await User.findByPk(userId)
  if (!user) throw new Error('유저를 찾을 수 없습니다')

  const wallet = await Wallet.findOne({
    where: { user_id: userId, is_primary: true },
  })

  // 온체인 등록 해제
  if (wallet) {
    await unregisterWallet(wallet.address)
  }

  // 소프트 삭제
  await user.update({
    status: 'withdrawn',
    deleted_at: new Date(),
  })

  return true
}

// ─── 토큰 검증 ───────────────────────────────────────────────

export const verifyAccessToken = (token: string) => {
  return jwt.verify(token, process.env.JWT_SECRET as string)
}

export const verifyRefreshToken = (token: string) => {
  return jwt.verify(token, process.env.JWT_REFRESH_SECRET as string)
}
