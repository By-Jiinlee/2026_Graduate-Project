import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { v4 as uuidv4 } from 'uuid'
import User from '../../models/user/User'
import Wallet from '../../models/user/Wallet'

// 회원가입
export const register = async (
  email: string,
  password: string,
  name: string,
  phone: string,
  walletAddress: string,
) => {
  // 이메일 중복 확인
  const existing = await User.findOne({ where: { email } })
  if (existing) throw new Error('이미 사용 중인 이메일입니다')

  // 비밀번호 해시
  const password_hash = await bcrypt.hash(password, 12)

  // 유저 생성
  const user = await User.create({
    email,
    password_hash,
    name,
    phone,
    role: 'user',
    is_email_verified: false,
    is_locked: false,
    status: 'active',
  })

  // 지갑 연동
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

// 로그인
export const login = async (email: string, password: string) => {
  // 유저 조회
  const user = await User.findOne({ where: { email } })
  if (!user) throw new Error('이메일 또는 비밀번호가 올바르지 않습니다')

  // 계정 잠금 확인
  if (user.is_locked)
    throw new Error('계정이 잠겼습니다. 관리자에게 문의하세요')

  // 탈퇴 확인
  if (user.status === 'withdrawn') throw new Error('탈퇴한 계정입니다')

  // 비밀번호 확인
  const isMatch = await bcrypt.compare(password, user.password_hash)
  if (!isMatch) throw new Error('이메일 또는 비밀번호가 올바르지 않습니다')

  // 지갑 확인
  const wallet = await Wallet.findOne({
    where: { user_id: user.id, is_primary: true },
  })
  if (!wallet) throw new Error('지갑이 등록되지 않은 계정입니다')

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

  return { user, accessToken, refreshToken, walletAddress: wallet.address }
}

// 탈퇴 (소프트 삭제)
export const withdraw = async (userId: number) => {
  const user = await User.findByPk(userId)
  if (!user) throw new Error('유저를 찾을 수 없습니다')

  await user.update({
    status: 'withdrawn',
    deleted_at: new Date(),
  })

  return true
}

// 토큰 검증
export const verifyAccessToken = (token: string) => {
  return jwt.verify(token, process.env.JWT_SECRET as string)
}

export const verifyRefreshToken = (token: string) => {
  return jwt.verify(token, process.env.JWT_REFRESH_SECRET as string)
}
