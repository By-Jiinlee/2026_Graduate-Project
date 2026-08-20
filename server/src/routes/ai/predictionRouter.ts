import { Router } from 'express'
import { isAuthenticated } from '../../middleware/auth/authMiddleware'
import { inferenceGuard } from '../../middleware/security/inferenceGuard'
import { predict } from '../../controllers/ai/predictionController'

const router = Router()

// 인증(JWT) → 추론 보안 검증(입력 스키마·예측 대상·호출 한도) → 모델 호출
// GET 이 아닌 POST 로 받는다 — 본문 스키마 검증을 강제하고 URL·프록시 로그에 질의가 남지 않게 한다.
router.post('/predict', isAuthenticated, inferenceGuard, predict)

export default router
