import { Router } from 'express'
import { isAuthenticated } from '../../middleware/auth/authMiddleware'
import { requireFullyVerified } from '../../middleware/auth/verificationTierMiddleware'
import { hmacMiddleware } from '../../middleware/security/hmacMiddleware'
import * as ctrl from '../../controllers/trade/realTradeController'

const router = Router()

router.use(isAuthenticated)
// 실거래는 조회까지 포함해 이메일·휴대폰 둘 다 인증한 사용자만 — 실제 계좌 정보가 오가는 경로다
router.use(requireFullyVerified)

// 상태 변경 요청 전체에 HMAC 서명 검증을 강제한다(hmacMiddleware 가 GET/HEAD 는 통과시킴).
// 계좌 등록은 KIS 앱키·시크릿을 본문에 실어 보내므로 변조·재전송 방어가 특히 필요하다.
router.use(hmacMiddleware)

router.post('/account',   ctrl.registerAccount)  // 계좌 등록
router.get('/account',    ctrl.getAccountStatus)                        // 계좌 상태 조회
router.delete('/account', ctrl.removeAccount)    // 계좌 해제
router.get('/balance',    ctrl.getBalance)                              // KIS 잔고 조회
router.post('/buy',       ctrl.buyStock)          // 매수
router.post('/sell',      ctrl.sellStock)         // 매도
router.get('/orders',     ctrl.getOrders)                               // 거래내역

export default router
