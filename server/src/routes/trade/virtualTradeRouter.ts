import { Router } from 'express'
import { isAuthenticated } from '../../middleware/auth/authMiddleware'
import { requirePhoneVerified } from '../../middleware/auth/phoneVerifiedMiddleware'
import * as ctrl from '../../controllers/trade/virtualTradeController'

const router = Router()

router.use(isAuthenticated)

router.post('/pin',                requirePhoneVerified, ctrl.setPin)          // PIN 설정
router.post('/pin/change',         requirePhoneVerified, ctrl.changePin)       // PIN 변경
router.post('/account/open',       requirePhoneVerified, ctrl.openAccount)     // 계좌 개설
router.post('/account/reset',      requirePhoneVerified, ctrl.resetAccount)    // 계좌 리셋
router.post('/buy',                requirePhoneVerified, ctrl.buyStock)        // 매수
router.post('/sell',               requirePhoneVerified, ctrl.sellStock)       // 매도
router.get('/portfolio',           ctrl.getPortfolio)                          // 포트폴리오 조회
router.get('/orders',              ctrl.getOrders)                             // 거래내역 조회
router.get('/orders/pending',      ctrl.getPendingOrders)                      // 미체결 주문 조회
router.delete('/orders/:orderId',  ctrl.cancelOrder)                           // 미체결 주문 취소

export default router
