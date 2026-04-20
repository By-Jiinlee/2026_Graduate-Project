import { Router } from 'express'
import * as authController from '../../controllers/auth/authController'
import { isAuthenticated } from '../../middleware/auth/authMiddleware'
import { checkAccountLock, analyzeAfterLogin } from '../../middleware/auth/anomalyMiddleware'
import {
  validateRegister,
  validateLoginStep1,
  validateLoginStep2,
  validateEmailCode,
  validateSmsCode,
} from '../../middleware/validation/authValidation'
import {
  loginRateLimiter,
  emailCodeRateLimiter,
  smsCodeRateLimiter,
} from '../../middleware/auth/rateLimitMiddleware'

const router = Router()

// ─── 이메일 인증 ──────────────────────────────────────────────
router.post(
    '/email/send',
    emailCodeRateLimiter,
    validateEmailCode,
    authController.sendEmailCode,
)
router.post(
    '/email/verify',
    emailCodeRateLimiter,
    validateEmailCode,
    authController.verifyEmailCode,
)

// ─── SMS 인증 ─────────────────────────────────────────────────
router.post(
    '/sms/send',
    smsCodeRateLimiter,
    validateSmsCode,
    authController.sendSmsCode,
)
router.post(
    '/sms/verify',
    smsCodeRateLimiter,
    validateSmsCode,
    authController.verifySmsCode,
)

// ─── 회원가입 ─────────────────────────────────────────────────
router.post('/register', validateRegister, authController.register)

// ─── 로그인 ───────────────────────────────────────────────────
// Step1: ① checkAccountLock(잠금확인) → ② loginStep1 → ③ analyzeAfterLogin(brute force 기록)
router.post(
  '/login/step1',
  loginRateLimiter,
  checkAccountLock,
  validateLoginStep1,
  authController.loginStep1,
  analyzeAfterLogin,
)

// Step2: ① loginStep2 → ② analyzeAfterLogin(시간대/동시세션/국가 탐지)
router.post(
  '/login/step2',
  loginRateLimiter,
  validateLoginStep2,
  authController.loginStep2,
  analyzeAfterLogin,
)

// ─── 로그아웃 ─────────────────────────────────────────────────
router.post('/logout', isAuthenticated, authController.logout)

// ─── 탈퇴 ─────────────────────────────────────────────────────
router.delete('/withdraw', isAuthenticated, authController.withdraw)

// ─── 토큰 갱신 ───────────────────────────────────────────────
router.post('/refresh', authController.refreshToken)


// ─── 마이페이지 휴대폰 인증 ───────────────────────────────────
router.post('/phone/send', isAuthenticated, smsCodeRateLimiter, validateSmsCode, authController.sendPhoneCode)
router.post('/phone/verify', isAuthenticated, smsCodeRateLimiter, validateSmsCode, authController.verifyPhoneCode)

// ─── 내 정보 조회 / 수정 ──────────────────────────────────────
router.get('/me', isAuthenticated, authController.getMyInfo)
router.patch('/me', isAuthenticated, authController.updateProfile)
router.get('/nickname/check', isAuthenticated, authController.checkNickname)
router.patch('/password', isAuthenticated, authController.changePassword)
router.get('/login-records', isAuthenticated, authController.getLoginRecords)

// ─── 이메일 변경 (월 1회, 인증 필요) ─────────────────────────
router.post('/email/change/send', isAuthenticated, authController.sendEmailChangeCode)
router.patch('/email', isAuthenticated, authController.changeEmail)

// ─── 신뢰 기기 관리 ──────────────────────────────────────────
router.get('/devices', isAuthenticated, authController.listTrustedDevices)
router.post('/devices/register', isAuthenticated, authController.registerDevice)
router.delete('/devices/:deviceId', isAuthenticated, authController.removeTrustedDevice)

// ─── 거래 nonce 조회 (고액 거래 MetaMask 서명용) ──────────────
router.get('/trade-nonce', isAuthenticated, authController.getTradeNonce)

export default router

