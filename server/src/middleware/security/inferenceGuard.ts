import { Request, Response, NextFunction } from 'express'
import { getClientIp } from '../../utils/getClientIp'
import { InferenceDenyReason } from '../../models/ai/InferenceLog'
import { PredictionInput } from '../../services/ai/predictionAdapter'
import {
  validateInferenceInput,
  isPredictableCode,
  checkCallQuota,
  logInference,
  escalateInferenceDenial,
  claimDenialLogBudget,
} from '../../services/ai/inferenceSecurityService'

// AI 추론 요청 사전 검증 — 반드시 isAuthenticated(JWT) "다음"에 배치한다.
// 통과한 요청은 req.inference 에 정규화된 입력이 담긴다.
export interface InferenceRequest extends Request {
  inference?: PredictionInput
}

// 사유별 HTTP 상태 — 형식 오류는 400, 한도 초과는 429, 남용 판정은 403
const STATUS: Record<InferenceDenyReason, number> = {
  INVALID_SHAPE: 400,
  UNKNOWN_FIELD: 400,
  INVALID_CODE: 400,
  UNKNOWN_CODE: 400,
  INVALID_HORIZON: 400,
  RATE_LIMIT: 429,
  BURST_LIMIT: 429,
  MODEL_OUTPUT_INVALID: 502,
  MODEL_UNAVAILABLE: 503,
  NOT_PREDICTED: 404,
}

const MESSAGE: Record<InferenceDenyReason, string> = {
  INVALID_SHAPE: '요청 형식이 올바르지 않습니다',
  UNKNOWN_FIELD: '허용되지 않은 요청 항목이 포함되었습니다',
  INVALID_CODE: '종목 코드 형식이 올바르지 않습니다',
  UNKNOWN_CODE: '예측을 제공하지 않는 종목입니다',
  INVALID_HORIZON: '지원하지 않는 예측 구간입니다',
  RATE_LIMIT: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요',
  BURST_LIMIT: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요',
  MODEL_OUTPUT_INVALID: '예측 결과를 제공할 수 없습니다',
  MODEL_UNAVAILABLE: '예측 서비스를 일시적으로 사용할 수 없습니다',
  NOT_PREDICTED: '해당 종목은 이 예측 구간의 산출 대상이 아닙니다',
}

export async function inferenceGuard(req: InferenceRequest, res: Response, next: NextFunction): Promise<void> {
  const user = (req as any).user
  if (!user?.id) {
    res.status(401).json({ message: '로그인이 필요합니다' })
    return
  }

  const ip = getClientIp(req)
  const userAgent = req.headers['user-agent']

  const deny = async (reason: InferenceDenyReason, code?: string, horizon?: string): Promise<void> => {
    const budget = claimDenialLogBudget(user.id)
    if (budget.allowed) {
      await logInference({
        userId: user.id,
        ip,
        userAgent,
        code: code ?? null,
        horizon: horizon ?? null,
        decision: 'DENY',
        denyReason: reason,
      })
    }

    const suppressedNote = budget.suppressed > 0 ? ` (분당 로그 한도 초과로 ${budget.suppressed}건 기록 생략)` : ''
    await escalateInferenceDenial({
      userId: user.id,
      email: user.email,
      ip,
      userAgent,
      reason,
      detail: `AI 추론 요청 차단(${reason}): ${req.method} ${req.path}${suppressedNote}`,
    })

    res.status(STATUS[reason]).json({ message: MESSAGE[reason], reason })
  }

  const validated = validateInferenceInput(req.body)
  if (!validated.ok) {
    // 형식 위반 단계에서는 신뢰할 수 없는 값을 로그에 남기지 않는다
    await deny(validated.reason)
    return
  }

  const { code, horizon } = validated.input

  if (!(await isPredictableCode(code))) {
    await deny('UNKNOWN_CODE', code, horizon)
    return
  }

  const quotaDenial = checkCallQuota(user.id, code)
  if (quotaDenial) {
    await deny(quotaDenial, code, horizon)
    return
  }

  req.inference = validated.input
  next()
}
