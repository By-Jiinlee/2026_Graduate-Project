import { Router } from 'express'
import { isAuthenticated } from '../../middleware/auth/authMiddleware'
import { hmacMiddleware } from '../../middleware/security/hmacMiddleware'
import * as ctrl from '../../controllers/trade/tradePinController'

const router = Router()

router.use(isAuthenticated)

// 다른 거래 라우터와 동일하게 상태 변경 요청에 HMAC 서명을 강제한다.
// 클라이언트 서명 범위(tradeSigning.requiresSignature)가 '/api/trade/' 전체이므로
// 이 라우터도 자동으로 서명 대상에 포함된다 — 범위를 따로 넓힐 필요가 없다.
router.use(hmacMiddleware)

// 휴대폰 인증은 걸지 않는다 — 그건 실거래 본인확인 수단이고,
// PIN 은 모의투자·실거래가 함께 쓰는 거래 인증 수단이다.
router.get('/status', ctrl.getPinStatus)   // 설정 여부 조회
router.post('/', ctrl.setPin)              // 최초 설정
router.post('/verify', ctrl.verifyPinOnly) // 검증만 (변경 1단계 즉시 확인)
router.post('/change', ctrl.changePin)     // 변경 (현재 PIN 필요)

export default router
