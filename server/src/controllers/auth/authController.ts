import { Request, Response, NextFunction } from 'express'
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
import { assessRisk, collectRiskSignals, decideAuthRequirement } from '../../services/auth/riskEngine'
import { recordAdaptiveDecision } from '../../services/auth/anomalyService'
import { getTradeNonce as fetchTradeNonce } from '../../services/web3/contractService'
import { issueSessionSecret, revokeSessionSecret } from '../../services/auth/hmacService'
import Wallet from '../../models/user/Wallet'
import User from '../../models/user/User'
import { nextTick } from 'node:process'

// ─── 이메일 인증 ──────────────────────────────────────────────

// 이메일 인증코드 발송
export const sendEmailCode = async (req: Request, res: Response) => {
  try {
    const { email } = req.body
    await authService.sendEmailCode(email)
    return res.status(200).json({ message: '인증코드가 발송되었습니다' })
  } catch (error: any) {
    console.error('[email/send 400]', error.message)
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

export const checkWalletAddress = async (req: Request, res: Response) => {
  try {
    const { address } = req.query as { address: string }
    if (!address) return res.status(400).json({ message: '지갑 주소가 필요합니다' })

    const existing = await Wallet.findOne({ where: { address } })
    if (existing) return res.status(200).json({ available: false, reason: 'db' })

    const { isWalletRegistered } = await import('../../services/web3/contractService')
    const onChain = await isWalletRegistered(address)
    if (onChain) return res.status(200).json({ available: false, reason: 'onchain' })

    return res.status(200).json({ available: true })
  } catch (error: any) {
    return res.status(500).json({ message: error.message })
  }
}

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
export const loginStep1 = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password, honeypot, behaviorData } = req.body

    // 기만 기술: 사람이 아닌 봇(Bot)이 숨김 필드를 채운 경우 즉시 차단
    if (honeypot && honeypot.length > 0) {
      return res.status(403).json({
        code: 'BOT_DETECTED',
        message: '비정상적인 접근이 감지되었습니다.'
      })
    }
    const result = await authService.loginStep1(email, password)
    
    // 신뢰 기기 확인
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown'
    const userAgent = req.headers['user-agent'] || 'unknown'
    const rawDeviceToken = req.cookies[DEVICE_COOKIE_NAME]
    let isTrustedDevice = false
    if (rawDeviceToken) {
      isTrustedDevice = await verifyTrustedDevice(result.userId, rawDeviceToken, userAgent, ip)
    }

    // 이상탐지 미들웨어를 위한 locals 설정
    res.locals.loginSuccess = true
    res.locals.loginEmail = email
    res.locals.loginUserId = result.userId
    // 적응형 인증(H) — 위험 점수 판정은 탐지 결과가 나온 뒤라야 하므로
    // analyzeAfterLogin 에서 수행한다. 여기서는 입력만 넘긴다.
    res.locals.isTrustedDevice = isTrustedDevice
    res.locals.behaviorData = behaviorData;

    res.locals.responseData = {
      message: '1단계 인증 성공. 지갑 서명을 진행해주세요',
      userId: result.userId,
      walletAddress: result.walletAddress,
      nonce: result.nonce,
      isTrustedDevice,
      requireWalletSign: !isTrustedDevice,
    }
    res.locals.responseStatus = 200
    return next()

    // return res.status(200).json({
    //   message: '1단계 인증 성공. 지갑 서명을 진행해주세요',
    //   userId: result.userId,
    //   walletAddress: result.walletAddress,
    //   nonce: result.nonce,
    //   isTrustedDevice,
    //   requireWalletSign: !isTrustedDevice,
    // })
  } catch (error: any) {
    // ↓ 추가: 실패도 이상탐지 미들웨어에 전달
    res.locals.loginSuccess = false
    res.locals.loginEmail = req.body.email
    res.locals.responseData = { message: error.message }
    res.locals.responseStatus = 400
    return next()
    //return res.status(400).json({ message: error.message })
  }
}

// 2단계: 지갑 서명 검증 → JWT 발급
export const loginStep2 = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, walletAddress, signature, rememberDevice } = req.body

    const ip =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() ||
      req.socket.remoteAddress ||
      'unknown'

    const userAgent = req.headers['user-agent'] || 'unknown'

    // 지갑 서명 생략 여부는 클라이언트 요청값(skipSignature)을 신뢰하지 않고 서버가 직접 재검증한다.
    // 요청 바디의 플래그를 그대로 쓰면 비밀번호만 아는 공격자가 서명 단계를 우회할 수 있다.
    const rawDeviceToken = req.cookies?.[DEVICE_COOKIE_NAME]
    const isTrustedDevice = rawDeviceToken
      ? await verifyTrustedDevice(userId, rawDeviceToken, userAgent, ip)
      : false

    // ── 적응형 인증(H) — 요구 강도를 서버에서 재계산해 강제한다 ──────────
    //
    // step1 응답의 requiredAuth 는 **안내용**이다. 클라이언트가 그 값을 낮춰 보내면
    // 그대로 통과하는 구조가 되면 안 되므로 실제 강제는 여기서 다시 계산한다.
    // (요청 본문의 skipSignature 를 신뢰해 2단계가 무력화됐던 과거 취약점과 같은 유형)
    const collected = await collectRiskSignals({ userId, ip, abuseScore: res.locals.abuseScore })
    const risk = assessRisk(collected.signals)
    const decision = decideAuthRequirement({
      isTrustedDevice,
      risk,
      degraded: collected.degraded,
    })

    const denyStepUp = (message: string, code: string) => {
      res.locals.loginSuccess = false
      res.locals.loginEmail = req.body.email ?? ''
      res.locals.responseData = {
        message,
        code,
        requiredAuth: decision.requirement,
        riskScore: risk.score,
      }
      res.locals.responseStatus = 400
      res.locals.isStep2 = true
      return next()
    }

    // ── 단계적 적용 게이트 ────────────────────────────────────────
    //
    // 프론트 재인증 화면이 붙었으므로 기본값을 '강제' 로 둔다. 관측만 하려면
    // ADAPTIVE_AUTH_ENFORCE=false 로 명시적으로 끈다.
    //
    // 기본값이 관측일 때 실제로 발생했던 문제: 프론트는 step1 의 requiredAuth 를 보고
    // 이메일 코드 입력 화면을 띄우는데 서버는 코드를 검증하지 않아, **아무 코드나 넣어도
    // 로그인이 되는 '인증하는 척하는 화면'** 이 됐다. 안내값과 강제 여부가 갈리면
    // 언제든 같은 종류의 괴리가 생기므로 기본을 강제로 맞춘다.
    //
    // 강제를 꺼도 **기존 정책은 그대로 강제한다.** 미신뢰 기기의 지갑 서명 요구는
    // 게이트와 무관하게 항상 적용되므로, 꺼져 있어도 기존보다 약해지지 않는다.
    const enforceAdaptive = process.env.ADAPTIVE_AUTH_ENFORCE !== 'false'

    if (!isTrustedDevice && !signature) {
      // 기존 정책 — 게이트와 무관하게 항상 적용
      return denyStepUp('지갑 서명이 필요합니다', 'WALLET_REQUIRED')
    }

    // 판정 기록 — 관측 모드에서도 남긴다. 강제를 켜기 전에 실제 등급 분포를 모으는 것이
    // 이 기록의 1차 목적이다. 통과(NONE)는 제외한다(전 로그인이 쌓여 집계가 무의미해짐).
    // 로그인 응답을 지연시키지 않도록 await 하지 않는다.
    if (decision.requirement !== 'NONE') {
      void recordAdaptiveDecision({
        userId,
        ip,
        userAgent,
        requirement: decision.requirement,
        score: risk.score,
        enforced: enforceAdaptive,
        reason: decision.reason,
      })
    }

    if (enforceAdaptive && decision.requirement === 'WALLET' && !signature) {
      return denyStepUp('지갑 서명이 필요합니다', 'WALLET_REQUIRED')
    }



    const { user, accessToken, refreshToken } = await authService.loginStep2(
      userId,
      walletAddress,
      signature,
      ip,
      userAgent,
      isTrustedDevice,
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

    // 기기 기억하기
    if (rememberDevice) {
      const rawDeviceToken = await registerTrustedDevice(userId, userAgent, ip)
      res.cookie(DEVICE_COOKIE_NAME, rawDeviceToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 1000 * 60 * 60 * 24 * 30,
      })
    }

    // 이상탐지 미들웨어를 위한 locals 설정
    res.locals.loginSuccess = true
    res.locals.loginEmail = user.email
    res.locals.loginUserId = user.id

    // HMAC 요청서명용 세션 서명키 발급 — 클라이언트가 거래 요청 서명에 사용
    const signingSecret = issueSessionSecret(user.id)

    // return res.status(200).json({
    res.locals.responseData = {
      message: '로그인 성공',
      signingSecret,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        walletAddress,
        is_phone_verified: user.is_phone_verified,
        is_survey_completed: user.is_survey_completed,
        investment_type_id: user.investment_type_id ?? null,
      },
    }
    res.locals.responseStatus = 200
    res.locals.isStep2 = true
    return next() // <- analyzeAfterLogin 으로 넘김
  } catch (error: any) {
    res.locals.loginSuccess = false
    res.locals.loginEmail = req.body.email ?? ''
    res.locals.responseData = { message: error.message }
    res.locals.responseStatus = 400
    res.locals.isStep2 = true
    return next()
  }
}

// ─── 로그아웃 ─────────────────────────────────────────────────

export const logout = async (req: Request, res: Response) => {
  try {
    res.clearCookie('accessToken')
    res.clearCookie('refreshToken')
    res.clearCookie('isLoggedIn')
    // deviceToken은 로그아웃 후에도 유지 (다음 로그인 시 기기 인식용)
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
    revokeSessionSecret(userId)
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
      maxAge: 1000 * 60 * 10,
    })

    res.cookie('isLoggedIn', 'true', {
      httpOnly: false,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 1000 * 60 * 10,
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
    const user = await User.findByPk(userId, {
      attributes: ['id', 'email', 'name', 'nickname', 'phone', 'is_phone_verified', 'role', 'status', 'created_at', 'email_changed_at'],
    })
    return res.status(200).json(user)
  } catch (error: any) {
    return res.status(500).json({ message: error.message })
  }
}

export const updateProfile = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const { nickname } = req.body
    await authService.checkNicknameAvailable(nickname, userId)
    await User.update({ nickname: nickname.trim() }, { where: { id: userId } })
    return res.status(200).json({ message: '닉네임이 업데이트되었습니다' })
  } catch (error: any) {
    return res.status(400).json({ message: error.message })
  }
}

export const checkNickname = async (req: Request, res: Response) => {
  try {
    const { nickname } = req.query as { nickname: string }
    const userId = (req as any).user.id
    await authService.checkNicknameAvailable(nickname, userId)
    return res.status(200).json({ available: true, message: '사용 가능한 닉네임입니다' })
  } catch (error: any) {
    return res.status(400).json({ available: false, message: error.message })
  }
}

export const sendEmailChangeCode = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const { email } = req.body
    if (!email) return res.status(400).json({ message: '이메일을 입력해주세요' })
    await authService.sendEmailChangeCode(userId, email)
    return res.status(200).json({ message: '인증코드가 발송되었습니다' })
  } catch (error: any) {
    return res.status(400).json({ message: error.message })
  }
}

export const changeEmail = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const { email, code } = req.body
    if (!email || !code) return res.status(400).json({ message: '이메일과 인증코드를 입력해주세요' })
    await authService.verifyEmailChange(userId, email, code)
    return res.status(200).json({ message: '이메일이 변경되었습니다' })
  } catch (error: any) {
    return res.status(400).json({ message: error.message })
  }
}

const PW_REGEX = /^(?=.*[a-zA-Z])(?=.*[0-9])(?=.*[!@#$%^&*])[a-zA-Z0-9!@#$%^&*]{8,}$/

// 비밀번호 변경용 nonce 조회 (MetaMask 2차 인증)
export const getPasswordNonce = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const wallet = await Wallet.findOne({ where: { user_id: userId } })
    if (!wallet) return res.status(404).json({ message: '등록된 지갑이 없습니다' })
    const { getAuthNonce } = await import('../../services/web3/contractService')
    const nonce = await getAuthNonce(wallet.address)
    return res.status(200).json({ walletAddress: wallet.address, nonce: nonce.toString() })
  } catch (error: any) {
    return res.status(500).json({ message: error.message })
  }
}

export const changePassword = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const { currentPassword, newPassword, walletAddress, signature } = req.body
    if (!currentPassword || !newPassword) return res.status(400).json({ message: '비밀번호를 입력해주세요' })
    if (!PW_REGEX.test(newPassword)) return res.status(400).json({ message: '새 비밀번호는 영문, 숫자, 특수문자(!@#$%^&*)를 각 1개 이상 포함한 8자 이상이어야 합니다' })

    // MetaMask 서명 검증 (지갑이 있는 경우 필수)
    if (walletAddress && signature) {
      const { getAuthNonce, verifySignature } = await import('../../services/web3/contractService')
      const nonce = await getAuthNonce(walletAddress)
      const valid = await verifySignature(walletAddress, nonce, signature)
      if (!valid) return res.status(400).json({ message: 'MetaMask 서명 검증에 실패했습니다' })
    } else {
      // 지갑이 등록되어 있으면 서명 필수
      const wallet = await Wallet.findOne({ where: { user_id: userId } })
      if (wallet) return res.status(400).json({ message: 'MetaMask 2차 인증이 필요합니다' })
    }

    const user = await User.findByPk(userId)
    if (!user) return res.status(404).json({ message: '사용자를 찾을 수 없습니다' })

    const bcrypt = require('bcryptjs')
    const ok = await bcrypt.compare(currentPassword, user.password_hash)
    if (!ok) return res.status(400).json({ message: '현재 비밀번호가 올바르지 않습니다' })

    const newHash = await bcrypt.hash(newPassword, 12)
    // 변경 시각을 함께 남긴다 — M-2(계정 정보 변경 직후 고액 거래) 판정의 기준점이다.
    await User.update(
      { password_hash: newHash, password_changed_at: new Date() },
      { where: { id: userId } },
    )
    return res.status(200).json({ message: '비밀번호가 변경되었습니다' })
  } catch (error: any) {
    return res.status(500).json({ message: error.message })
  }
}

export const getLoginRecords = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const LoginRecord = require('../../models/auth/LoginRecord').default
    const records = await LoginRecord.findAll({
      where: { user_id: userId },
      order: [['logged_at', 'DESC']],
      limit: 10,
      attributes: ['id', 'ip_address', 'country', 'region', 'city', 'user_agent', 'logged_at'],
    })
    return res.status(200).json({ records })
  } catch (error: any) {
    return res.status(500).json({ message: error.message })
  }
}

// ─── 신뢰 기기 관리 (마이페이지) ─────────────────────────────

export const listTrustedDevices = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const userAgent = req.headers['user-agent'] ?? 'unknown'
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown'
    const rawDeviceToken = req.cookies[DEVICE_COOKIE_NAME]
    let isTrustedDevice = false
    if (rawDeviceToken) {
      isTrustedDevice = await verifyTrustedDevice(userId, rawDeviceToken, userAgent, ip)
    }
    const devices = await getTrustedDevices(userId)
    return res.status(200).json({ devices, isTrustedDevice })
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

export const registerDevice = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const userAgent = req.headers['user-agent'] ?? 'unknown'
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown'

    // 기존 기기 전체 해제 후 현재 기기 신규 등록
    await revokeAllTrustedDevices(userId)
    const rawDeviceToken = await registerTrustedDevice(userId, userAgent, ip)
    res.cookie(DEVICE_COOKIE_NAME, rawDeviceToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 1000 * 60 * 60 * 24 * 30,
    })
    return res.status(200).json({ message: '기기가 신뢰 기기로 등록되었습니다' })
  } catch (error: any) {
    return res.status(500).json({ message: error.message })
  }
}

// ─── 거래 nonce 조회 (고액 거래 MetaMask 서명용) ──────────────

export const getTradeNonce = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const wallet = await Wallet.findOne({ where: { user_id: userId } })
    if (!wallet) return res.status(404).json({ message: '지갑이 없습니다' })

    const nonce = await fetchTradeNonce(wallet.address)
    res.json({ nonce: nonce.toString() })
  } catch (error: any) {
    res.status(500).json({ message: error.message })
  }
}
