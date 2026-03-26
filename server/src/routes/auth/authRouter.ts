import { Router } from 'express'
import * as authController from '../../controllers/auth/authController'
import { isAuthenticated } from '../../middleware/auth/authMiddleware'
import {
  validateRegister,
  validateLogin,
} from '../../middleware/validation/authValidation'

const router = Router()

// 회원가입
router.post('/register', validateRegister, authController.register)

// 로그인
router.post('/login', validateLogin, authController.login)

// 로그아웃 (로그인 필요)
router.post('/logout', isAuthenticated, authController.logout)

// 탈퇴 (로그인 필요)
router.delete('/withdraw', isAuthenticated, authController.withdraw)

// 토큰 갱신
router.post('/refresh', authController.refreshToken)

export default router
