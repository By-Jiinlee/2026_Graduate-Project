import { Router } from 'express'
import { isAuthenticated } from '../../middleware/auth/authMiddleware'
import { hmacMiddleware } from '../../middleware/security/hmacMiddleware'
import * as ctrl from '../../controllers/trade/virtualTradeController'

const router = Router()

router.use(isAuthenticated)

// 상태 변경 요청 전체에 HMAC 서명 검증을 강제한다(hmacMiddleware 가 GET/HEAD 는 통과시킴).
// 매수·매도에만 걸어두면 PIN 변경·계좌 리셋·주문 취소가 재전송·본문 변조 방어 밖에 남는다.
// 클라이언트 서명 범위(tradeSigning.requiresSignature)와 반드시 동일해야 한다.
router.use(hmacMiddleware)

// 휴대폰 인증은 걸지 않는다 — 그건 **실거래** 본인확인 수단이고(realTradeRouter),
// 모의투자는 가상 자금이라 실명 확인을 요구할 근거가 없다. 여기에 걸어두면
// 휴대폰 인증을 하지 않은 사용자가 모의투자 자체를 시작하지 못하고,
// PIN(고액거래·모의투자용 인증 수단) 설정 경로까지 함께 막힌다.
// PIN 설정·변경은 /api/trade/pin 으로 옮겼다 — 실거래도 같은 PIN 을 쓰는데
// 설정 경로만 모의투자에 있으면, 실거래만 쓰려는 사용자가 모의투자를 거쳐야 한다.
router.post('/account/open',       ctrl.openAccount)     // 계좌 개설
router.post('/account/reset',      ctrl.resetAccount)    // 계좌 리셋
router.post('/buy',                ctrl.buyStock)        // 매수
router.post('/sell',               ctrl.sellStock)       // 매도
router.get('/portfolio',           ctrl.getPortfolio)                          // 포트폴리오 조회
router.get('/orders',              ctrl.getOrders)                             // 거래내역 조회
router.get('/orders/pending',      ctrl.getPendingOrders)                      // 미체결 주문 조회
router.delete('/orders/:orderId',  ctrl.cancelOrder)                           // 미체결 주문 취소

export default router
