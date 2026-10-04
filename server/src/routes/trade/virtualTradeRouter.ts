import { Router } from 'express'
import { isAuthenticated } from '../../middleware/auth/authMiddleware'
import { requireAnyVerified } from '../../middleware/auth/verificationTierMiddleware'
import { hmacMiddleware } from '../../middleware/security/hmacMiddleware'
import * as ctrl from '../../controllers/trade/virtualTradeController'

const router = Router()

router.use(isAuthenticated)
// 모의투자는 이메일·휴대폰 중 하나만 인증하면 된다(가상 자금). 둘 다 요구하는 것은 실거래(realTradeRouter)뿐이다.
// 가입 때 둘 중 하나를 반드시 인증하므로 정상 가입자는 모두 통과하고, 인증 기록이 없는 비정상 계정만 막힌다.
router.use(requireAnyVerified)

// 상태 변경 요청 전체에 HMAC 서명 검증을 강제한다(hmacMiddleware 가 GET/HEAD 는 통과시킴).
// 매수·매도에만 걸어두면 PIN 변경·계좌 리셋·주문 취소가 재전송·본문 변조 방어 밖에 남는다.
// 클라이언트 서명 범위(tradeSigning.requiresSignature)와 반드시 동일해야 한다.
router.use(hmacMiddleware)

// PIN 설정·변경은 /api/trade/pin 으로 옮겼다 — 실거래도 같은 PIN 을 쓰는데
// 설정 경로만 모의투자에 있으면, 실거래만 쓰려는 사용자가 모의투자를 거쳐야 한다.
router.post('/account/open',       ctrl.openAccount)     // 계좌 개설
router.post('/account/reset',      ctrl.resetAccount)    // 계좌 리셋
router.post('/buy',                ctrl.buyStock)        // 매수
router.post('/sell',               ctrl.sellStock)       // 매도
router.get('/portfolio',           ctrl.getPortfolio)                          // 포트폴리오 조회
router.get('/market-status',       ctrl.getMarketStatus)                       // 장 운영 상태(정규장·휴장일)
router.get('/orders',              ctrl.getOrders)                             // 거래내역 조회
router.get('/orders/pending',      ctrl.getPendingOrders)                      // 미체결 주문 조회
router.get('/orders/:orderId/proof', ctrl.getOrderProof)                     // 체결 장부 포함 증명
router.delete('/orders/:orderId',  ctrl.cancelOrder)                           // 미체결 주문 취소

export default router
