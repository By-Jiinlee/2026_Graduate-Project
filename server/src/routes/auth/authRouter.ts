import { Router } from 'express'
import * as authController from '../../controllers/auth/authController'
import { isAuthenticated } from '../../middleware/auth/authMiddleware'
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
router.post(
  '/login/step1',
  loginRateLimiter,
  validateLoginStep1,
  authController.loginStep1,
)
router.post(
  '/login/step2',
  loginRateLimiter,
  validateLoginStep2,
  authController.loginStep2,
)

// ─── 로그아웃 ─────────────────────────────────────────────────
router.post('/logout', isAuthenticated, authController.logout)

// ─── 탈퇴 ─────────────────────────────────────────────────────
router.delete('/withdraw', isAuthenticated, authController.withdraw)

// ─── 토큰 갱신 ───────────────────────────────────────────────
router.post('/refresh', authController.refreshToken)

export default router
// ─── 마이페이지 휴대폰 인증 ───────────────────────────────────
router.post('/phone/send', isAuthenticated, smsCodeRateLimiter, validateSmsCode, authController.sendPhoneCode)
router.post('/phone/verify', isAuthenticated, smsCodeRateLimiter, validateSmsCode, authController.verifyPhoneCode)

// ─── 내 정보 조회 ─────────────────────────────────────────────
router.get('/me', isAuthenticated, authController.getMyInfo)