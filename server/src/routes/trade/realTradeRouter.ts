import { Router } from 'express'
import { isAuthenticated } from '../../middleware/auth/authMiddleware'
import { requirePhoneVerified } from '../../middleware/auth/phoneVerifiedMiddleware'
import { hmacMiddleware } from '../../middleware/security/hmacMiddleware'
import * as ctrl from '../../controllers/trade/realTradeController'

const router = Router()

router.use(isAuthenticated)

// 상태 변경 요청 전체에 HMAC 서명 검증을 강제한다(hmacMiddleware 가 GET/HEAD 는 통과시킴).
// 계좌 등록은 KIS 앱키·시크릿을 본문에 실어 보내므로 변조·재전송 방어가 특히 필요하다.
router.use(hmacMiddleware)

router.post('/account',   requirePhoneVerified, ctrl.registerAccount)  // 계좌 등록
router.get('/account',    ctrl.getAccountStatus)                        // 계좌 상태 조회
router.delete('/account', requirePhoneVerified, ctrl.removeAccount)    // 계좌 해제
router.get('/balance',    ctrl.getBalance)                              // KIS 잔고 조회
router.post('/buy',       requirePhoneVerified, ctrl.buyStock)          // 매수
router.post('/sell',      requirePhoneVerified, ctrl.sellStock)         // 매도
router.get('/orders',     ctrl.getOrders)                               // 거래내역

export default router
