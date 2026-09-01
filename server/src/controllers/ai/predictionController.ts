import { Response } from 'express'
import { getClientIp } from '../../utils/getClientIp'
import { InferenceRequest } from '../../middleware/security/inferenceGuard'
import {
  getPredictionAdapter,
  ModelContractError,
  ModelUnavailableError,
  PredictionNotFoundError,
} from '../../services/ai/predictionAdapter'
import { logInference, quantizeProbability } from '../../services/ai/inferenceSecurityService'

// ─────────────────────────────────────────────────────────────
// AI 상승·하락 예측 조회
//
// 입력 검증·호출 제한은 inferenceGuard 가 이미 수행했다. 이 컨트롤러의 보안 책임은
//   (1) 모델 응답 계약 검증 및 실패 시 fail-closed
//   (2) 응답 최소화 — 원시 확률·모델 내부 정보 비노출, 확률 양자화
//   (3) 감사 로그 기록 (원본 확률은 DB 에만 보관)
// 이다.
// ─────────────────────────────────────────────────────────────
export async function predict(req: InferenceRequest, res: Response): Promise<void> {
  const user = (req as any).user
  const ip = getClientIp(req)
  const userAgent = req.headers['user-agent']
  const input = req.inference
  if (!input) {
    res.status(400).json({ message: '요청 형식이 올바르지 않습니다' })
    return
  }

  const adapter = getPredictionAdapter()
  const startedAt = Date.now()

  try {
    const output = await adapter.predict(input)
    const latencyMs = Date.now() - startedAt

    await logInference({
      userId: user.id,
      ip,
      userAgent,
      code: input.code,
      horizon: input.horizon,
      decision: 'ALLOW',
      label: output.label,
      probability: output.probability,
      latencyMs,
      adapter: adapter.name,
    })

    // 모델 식별자·원시 확률·확신도 순위·임계값은 응답에 담지 않는다.
    // 브라우저·중간 캐시에 예측 결과가 남지 않도록 저장을 금지한다.
    res.setHeader('Cache-Control', 'no-store')

    const disclaimer = '본 예측은 정보 제공 목적이며 투자 권유가 아닙니다.'

    // 미추천(확신도 하위) 종목은 방향·확신도를 제공하지 않는다.
    // Selective Prediction 의 서비스 논리이자, 그날 전 종목의 순위표가 복원되는 것을 막는
    // 자산 보호 조치다(추천 목록 자체가 모델의 산출 가치이므로).
    if (output.recommended === false) {
      res.json({
        code: input.code,
        horizon: input.horizon,
        ...(output.predictDate ? { predictDate: output.predictDate } : {}),
        recommended: false,
        message: '확신도가 낮아 예측을 제공하지 않습니다.',
        disclaimer,
      })
      return
    }

    // confidence 는 "예측한 방향에 대한 확률"로 노출한다. 모델은 상승확률(p)을 내므로
    // 상승 예측이면 p, 하락 예측이면 1−p 를 쓴다 → 항상 "그 방향일 확률"로 읽힌다.
    // 5%p 격자로 양자화하여 원본 확률의 정밀 복원(모델 추출)을 어렵게 한다.
    const directionProb = output.label === 1 ? output.probability : 1 - output.probability
    res.json({
      code: input.code,
      horizon: input.horizon,
      ...(output.predictDate ? { predictDate: output.predictDate } : {}),
      recommended: true,
      direction: output.label === 1 ? 'UP' : 'DOWN',
      confidence: quantizeProbability(directionProb),
      disclaimer,
    })
  } catch (err) {
    const latencyMs = Date.now() - startedAt
    const reason =
      err instanceof PredictionNotFoundError ? 'NOT_PREDICTED'
        : err instanceof ModelContractError ? 'MODEL_OUTPUT_INVALID'
        : 'MODEL_UNAVAILABLE'

    await logInference({
      userId: user.id,
      ip,
      userAgent,
      code: input.code,
      horizon: input.horizon,
      decision: 'DENY',
      denyReason: reason,
      latencyMs,
      adapter: adapter.name,
    })

    // 내부 오류 메시지·스택은 노출하지 않는다 (모델 구성 정보 유출 방지)
    if (
      !(err instanceof ModelContractError) &&
      !(err instanceof ModelUnavailableError) &&
      !(err instanceof PredictionNotFoundError)
    ) {
      console.error('[AI] 추론 처리 오류:', err)
    }

    const STATUS = { NOT_PREDICTED: 404, MODEL_OUTPUT_INVALID: 502, MODEL_UNAVAILABLE: 503 } as const
    const MESSAGE = {
      NOT_PREDICTED: '해당 종목은 이 예측 구간의 산출 대상이 아닙니다',
      MODEL_OUTPUT_INVALID: '예측 결과를 제공할 수 없습니다',
      MODEL_UNAVAILABLE: '예측 서비스를 일시적으로 사용할 수 없습니다',
    } as const

    res.status(STATUS[reason]).json({ message: MESSAGE[reason], reason })
  }
}
