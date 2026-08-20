import { Router } from 'express'
import { isAuthenticated } from '../../middleware/auth/authMiddleware'
import { requirePhoneVerified } from '../../middleware/auth/phoneVerifiedMiddleware'
import { hmacMiddleware } from '../../middleware/security/hmacMiddleware'
import * as ctrl from '../../controllers/trade/virtualTradeController'

const router = Router()

router.use(isAuthenticated)

// 상태 변경 요청 전체에 HMAC 서명 검증을 강제한다(hmacMiddleware 가 GET/HEAD 는 통과시킴).
// 매수·매도에만 걸어두면 PIN 변경·계좌 리셋·주문 취소가 재전송·본문 변조 방어 밖에 남는다.
// 클라이언트 서명 범위(tradeSigning.requiresSignature)와 반드시 동일해야 한다.
router.use(hmacMiddleware)

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
