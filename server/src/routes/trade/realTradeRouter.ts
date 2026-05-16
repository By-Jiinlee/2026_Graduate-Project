import { Router } from 'express'
import { isAuthenticated } from '../../middleware/auth/authMiddleware'
import { requirePhoneVerified } from '../../middleware/auth/phoneVerifiedMiddleware'
import * as ctrl from '../../controllers/trade/realTradeController'

const router = Router()

router.use(isAuthenticated)

router.post('/account',   requirePhoneVerified, ctrl.registerAccount)  // 계좌 등록
router.get('/account',    ctrl.getAccountStatus)                        // 계좌 상태 조회
router.delete('/account', requirePhoneVerified, ctrl.removeAccount)    // 계좌 해제
router.get('/balance',    ctrl.getBalance)                              // KIS 잔고 조회
router.post('/buy',       requirePhoneVerified, ctrl.buyStock)          // 매수
router.post('/sell',      requirePhoneVerified, ctrl.sellStock)         // 매도
router.get('/orders',     ctrl.getOrders)                               // 거래내역

export default router
