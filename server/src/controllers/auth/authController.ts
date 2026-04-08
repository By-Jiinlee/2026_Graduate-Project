import { Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import * as authService from '../../services/auth/authService'
import {
  verifyTrustedDevice,
  registerTrustedDevice,
  revokeAllTrustedDevices,
  getTrustedDevices,
  revokeTrustedDevice,
  DEVICE_COOKIE_NAME,
} from '../../services/auth/trustedDeviceService'

// ─── 이메일 인증 ──────────────────────────────────────────────

// 이메일 인증코드 발송
export const sendEmailCode = async (req: Request, res: Response) => {
  try {
    const { email } = req.body
    await authService.sendEmailCode(email)
    return res.status(200).json({ message: '인증코드가 발송되었습니다' })
  } catch (error: any) {
    return res.status(400).json({ message: error.message })
  }
}

// 이메일 인증코드 검증
export const verifyEmailCode = async (req: Request, res: Response) => {
  try {
    const { email, code } = req.body
    await authService.verifyEmailCode(email, code)
    return res.status(200).json({ message: '이메일 인증이 완료되었습니다' })
  } catch (error: any) {
    return res.status(400).json({ message: error.message })
  }
}

// ─── SMS 인증 ─────────────────────────────────────────────────

// SMS 인증코드 발송
export const sendSmsCode = async (req: Request, res: Response) => {
  try {
    const { phone } = req.body
    await authService.sendSmsCode(phone)
    return res.status(200).json({ message: '인증코드가 발송되었습니다' })
  } catch (error: any) {
    return res.status(400).json({ message: error.message })
  }
}

// SMS 인증코드 검증
export const verifySmsCode = async (req: Request, res: Response) => {
  try {
    const { phone, code } = req.body
    await authService.verifySmsCode(phone, code)
    return res.status(200).json({ message: '휴대폰 인증이 완료되었습니다' })
  } catch (error: any) {
    return res.status(400).json({ message: error.message })
  }
}

// ─── 회원가입 ─────────────────────────────────────────────────

export const register = async (req: Request, res: Response) => {
  try {
    const {
      email,
      password,
      name,
      phone,
      walletAddress,
      walletSignature,
      terms_agreed,
      privacy_agreed,
      location_agreed,
      age_agreed,
      marketing_agreed,
    } = req.body

    if (!walletAddress) {
      return res
      .status(400)
      .json({ message: 'MetaMask 지갑 연결이 필요합니다' })
    }
    if (!walletSignature) {
      return res.status(400).json({ message: '지갑 서명이 필요합니다' })
    }

    const user = await authService.register(
      email,
      password,
      name,
      phone,
      walletAddress,
      walletSignature,
      terms_agreed,
      privacy_agreed,
      location_agreed,
      age_agreed,
      marketing_agreed ?? false,
    )

    return res.status(201).json({
      message: '회원가입이 완료되었습니다',
      userId: user.id,
    })
  } catch (error: any) {
    console.error('register error:', error.message, error.errors)
    return res.status(400).json({ message: error.message })
  }
}

// ─── 로그인 1단계 ─────────────────────────────────────────────

// 1단계: 이메일 + 비밀번호 검증 → nonce 반환
export const loginStep1 = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body
    const result = await authService.loginStep1(email, password)

    // ↓ 추가: 신뢰 기기 확인
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown'
    const userAgent = req.headers['user-agent'] || 'unknown'
    const rawDeviceToken = req.cookies[DEVICE_COOKIE_NAME]
    let isTrustedDevice = false
    if (rawDeviceToken) {
      isTrustedDevice = await verifyTrustedDevice(result.userId, rawDeviceToken, userAgent, ip)
    }

    // ↓ 추가: 이상탐지 미들웨어를 위한 locals 설정
    res.locals.loginSuccess = true
    res.locals.loginEmail = email
    res.locals.loginUserId = result.userId

    return res.status(200).json({
      message: '1단계 인증 성공. 지갑 서명을 진행해주세요',
      userId: result.userId,
      walletAddress: result.walletAddress,
      nonce: result.nonce,
      isTrustedDevice,            // ↓ 추가
      requireWalletSign: !isTrustedDevice, // ↓ 추가
    })
  } catch (error: any) {
    // ↓ 추가: 실패도 이상탐지 미들웨어에 전달
    res.locals.loginSuccess = false
    res.locals.loginEmail = req.body.email
    return res.status(400).json({ message: error.message })
  }
}

// 2단계: 지갑 서명 검증 → JWT 발급
export const loginStep2 = async (req: Request, res: Response) => {
  try {
    const { userId, walletAddress, signature, rememberDevice, skipSignature } = req.body // ↓ rememberDevice, skipSignature 추가

    const ip =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() ||
      req.socket.remoteAddress ||
      'unknown'

    const userAgent = req.headers['user-agent'] || 'unknown'

    const { user, accessToken, refreshToken } = await authService.loginStep2(
      userId,
      walletAddress,
      signature,
      ip,
      userAgent,
      skipSignature, // ↓ 추가
    )

    res.cookie('accessToken', accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 1000 * 60 * 10, // 10분
    })

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7일
    })

    res.cookie('isLoggedIn', 'true', {
      httpOnly: false,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 1000 * 60 * 10, // 10분
    })

    // ↓ 추가: 기기 기억하기
    if (rememberDevice) {
      const rawDeviceToken = await registerTrustedDevice(userId, userAgent, ip)
      res.cookie(DEVICE_COOKIE_NAME, rawDeviceToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 1000 * 60 * 60 * 24 * 30,
      })
    }

    // ↓ 추가: 이상탐지 미들웨어를 위한 locals 설정
    res.locals.loginSuccess = true
    res.locals.loginEmail = user.email
    res.locals.loginUserId = user.id

    return res.status(200).json({
      message: '로그인 성공',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        walletAddress,
      },
    })
  } catch (error: any) {
    res.locals.loginSuccess = false
    res.locals.loginEmail = req.body.email ?? ''
    return res.status(400).json({ message: error.message })
  }
}

// ─── 로그아웃 ─────────────────────────────────────────────────

export const logout = async (req: Request, res: Response) => {
  try {
    res.clearCookie('accessToken')
    res.clearCookie('refreshToken')
    res.clearCookie('isLoggedIn')
    res.clearCookie(DEVICE_COOKIE_NAME)
    return res.status(200).json({ message: '로그아웃 되었습니다' })
  } catch (error: any) {
    return res.status(500).json({ message: error.message })
  }
}

// ─── 탈퇴 ─────────────────────────────────────────────────────

export const withdraw = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    await authService.withdraw(userId)
    await revokeAllTrustedDevices(userId)
    res.clearCookie('accessToken')
    res.clearCookie('refreshToken')
    res.clearCookie('isLoggedIn')
    res.clearCookie(DEVICE_COOKIE_NAME)
    return res.status(200).json({ message: '탈퇴가 완료되었습니다' })
  } catch (error: any) {
    return res.status(400).json({ message: error.message })
  }
}

// ─── 토큰 갱신 ───────────────────────────────────────────────

export const refreshToken = async (req: Request, res: Response) => {
  try {
    const token = req.cookies.refreshToken
    if (!token) return res.status(401).json({ message: '토큰이 없습니다' })

    const decoded = authService.verifyRefreshToken(token) as any

    const accessToken = jwt.sign(
      { id: decoded.id },
      process.env.JWT_SECRET as string,
      { expiresIn: '1h' },
    )

    res.cookie('accessToken', accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 1000 * 60 * 60,
    })

    return res.status(200).json({ message: '토큰이 갱신되었습니다' })
  } catch (error: any) {
    return res.status(401).json({ message: '유효하지 않은 토큰입니다' })
  }
}
// ─── 마이페이지 휴대폰 인증 ───────────────────────────────────

export const sendPhoneCode = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const { phone } = req.body
    await authService.sendPhoneCode(userId, phone)
    return res.status(200).json({ message: '인증코드가 발송되었습니다' })
  } catch (error: any) {
    return res.status(400).json({ message: error.message })
  }
}

export const verifyPhoneCode = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const { phone, code } = req.body
    await authService.verifyPhoneCode(userId, phone, code)
    return res.status(200).json({ message: '휴대폰 인증이 완료되었습니다' })
  } catch (error: any) {
    return res.status(400).json({ message: error.message })
  }
}

export const getMyInfo = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const User = require('../../models/user/User').default
    const user = await User.findByPk(userId, {
      attributes: ['id', 'email', 'name', 'phone', 'is_phone_verified', 'role', 'status', 'created_at'],
    })
    return res.status(200).json(user)
  } catch (error: any) {
    return res.status(500).json({ message: error.message })
  }
}

// ─── 신뢰 기기 관리 (마이페이지) ─────────────────────────────
// ↓ 추가: 신규 함수

export const listTrustedDevices = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const devices = await getTrustedDevices(userId)
    return res.status(200).json({ devices })
  } catch (error: any) {
    return res.status(500).json({ message: error.message })
  }
}

export const removeTrustedDevice = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const deviceId = Number(req.params.deviceId)
    if (isNaN(deviceId)) {
      return res.status(400).json({ message: '유효하지 않은 기기 ID 형식입니다' })
    }
    await revokeTrustedDevice(userId, deviceId)
    return res.status(200).json({ message: '기기 신뢰가 해제되었습니다' })
  } catch (error: any) {
    return res.status(400).json({ message: error.message })
  }
}
