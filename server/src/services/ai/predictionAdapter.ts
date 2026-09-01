import crypto from 'crypto'
import axios from 'axios'

// ─────────────────────────────────────────────────────────────
// AI 예측 모델 어댑터
//
// 보안 계층(입력 검증·호출 제한·응답 최소화·감사 로그)을 모델 구현과 분리하기 위한 경계다.
// 팀 AI 코드가 확정되면 이 파일의 어댑터 구현만 교체하면 되고, 미들웨어·컨트롤러·공격
// 시뮬레이션 스크립트는 수정하지 않는다.
//
// 모델 계약(상승·하락 이진 분류)
//   입력 : 종목코드(6자리) + 예측 구간(1d/1w/1m/1y)
//   출력 : 상승 확률 [0,1] + 라벨(1=상승, 0=하락) + 추천 여부
//
// 어댑터 선택은 환경변수 AI_ADAPTER 로 한다.
//   table : 배치 예측 결과 테이블 조회 — v9.7 모델의 정식 경로(운영 기본값)
//   mock  : 결정적 의사확률 생성기 (보안 계층 단독 검증용)
//   http  : 외부 추론 서버(REST) 호출 — AI_PREDICT_URL 필요
//
// v9.7 모델은 "그날 전 종목 중 확신도 상위 X%"를 추천하므로 종목 단건 추론이 성립하지
// 않는다(추천 여부를 정하려면 같은 날 다른 종목과 순위를 비교해야 함). 따라서 하루 1회
// 배치로 전 종목 점수를 계산해 stock_predictions 에 적재하고, 웹은 조회만 수행한다.
// 이 구조는 보안 측면에서도 유리하다 — 모델을 웹 요청 경로에서 호출하지 않으므로
// 질의를 통한 모델 추출이 불가능해지고, 방어의 초점이 "예측 결과 대량 수집"으로 옮겨간다.
// ─────────────────────────────────────────────────────────────

export const HORIZONS = ['1d', '1w', '1m', '1y'] as const
export type Horizon = (typeof HORIZONS)[number]

export interface PredictionInput {
  code: string
  horizon: Horizon
}

export interface PredictionOutput {
  /** 1 = 상승, 0 = 하락 */
  label: 0 | 1
  /** 상승 확률 [0,1] — 응답 노출 전 양자화된다 */
  probability: number
  /**
   * 추천 여부(Selective Prediction). 그날 전 종목 중 확신도 상위 coverage 내에 들면 true.
   * 배치 테이블 경로에서만 판정 가능하며, 미추천 종목은 응답에서 방향·확신도를 노출하지 않는다.
   */
  recommended?: boolean
  /** 예측 기준일(YYYY-MM-DD) — 배치 경로에서 제공 */
  predictDate?: string
}

/** 해당 종목·구간의 예측이 배치에 존재하지 않음 (유니버스 밖 종목 등 정상적인 경우) */
export class PredictionNotFoundError extends Error {}

export interface PredictionAdapter {
  readonly name: string
  predict(input: PredictionInput): Promise<PredictionOutput>
}

export class ModelContractError extends Error {}
export class ModelUnavailableError extends Error {}

// ─────────────────────────────────────────────
// 모델 응답 정규화 — 계약 위반은 통과시키지 않는다(fail-closed)
//
// 모델 쪽 필드명이 확정되기 전이므로 흔한 표기를 함께 수용한다. 팀 AI 스펙이 확정되면
// 아래 후보 목록을 실제 필드명 하나로 좁히는 것이 안전하다.
// ─────────────────────────────────────────────
const PROB_KEYS = ['probability', 'prob', 'up_prob', 'confidence', 'score', 'proba'] as const
const LABEL_KEYS = ['label', 'pred', 'prediction', 'direction', 'y_pred'] as const

export function normalizeModelOutput(raw: unknown): PredictionOutput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ModelContractError('모델 응답이 객체가 아님')
  }
  const obj = raw as Record<string, unknown>

  let probability: number | undefined
  for (const key of PROB_KEYS) {
    const v = obj[key]
    if (typeof v === 'number' && Number.isFinite(v)) {
      probability = v
      break
    }
  }
  if (probability === undefined) throw new ModelContractError('모델 응답에 확률 값이 없음')

  // 백분율(0~100)로 내려오는 경우를 보정한 뒤 상·하한을 클리핑한다.
  if (probability > 1) probability = probability / 100
  probability = Math.min(1, Math.max(0, probability))

  let label: 0 | 1 | undefined
  for (const key of LABEL_KEYS) {
    const v = obj[key]
    if (typeof v === 'number' && (v === 0 || v === 1)) { label = v as 0 | 1; break }
    if (typeof v === 'boolean') { label = v ? 1 : 0; break }
    if (typeof v === 'string') {
      const s = v.trim().toUpperCase()
      if (s === 'UP' || s === '1' || s === 'RISE') { label = 1; break }
      if (s === 'DOWN' || s === '0' || s === 'FALL') { label = 0; break }
    }
  }
  // 라벨이 없으면 확률로부터 유도한다 — 임계값 0.5
  if (label === undefined) label = probability >= 0.5 ? 1 : 0

  return { label, probability }
}

// ─────────────────────────────────────────────
// mock 어댑터 — 입력에 대해 항상 같은 값을 돌려주는 결정적 생성기.
// 무작위성을 배제해 공격 시뮬레이션 결과가 재현 가능하도록 한다.
// ─────────────────────────────────────────────
const MOCK_RECOMMEND_CONFIDENCE = 0.05 // 배치 경로의 추천 판정을 대체하는 고정 기준

const mockAdapter: PredictionAdapter = {
  name: 'mock',
  async predict({ code, horizon }) {
    const digest = crypto.createHmac('sha256', 'uptick-mock-adapter').update(`${code}.${horizon}`).digest()
    const probability = digest.readUInt32BE(0) / 0xffffffff
    return {
      label: probability >= 0.5 ? 1 : 0,
      probability,
      // mock 은 단건 호출이라 "그날 상위 X%" 판정이 불가능하므로 확신도 기준으로 대체한다
      recommended: Math.abs(probability - 0.5) >= MOCK_RECOMMEND_CONFIDENCE,
    }
  },
}

// ─────────────────────────────────────────────
// http 어댑터 — 별도 프로세스로 서빙되는 추론 서버 호출.
// 모델 파일(.pkl 등)은 웹 서버의 정적 서빙 경로 밖에 두고, 여기서 네트워크로만 접근한다.
// ─────────────────────────────────────────────
const httpAdapter: PredictionAdapter = {
  name: 'http',
  async predict(input) {
    const url = process.env.AI_PREDICT_URL
    if (!url) throw new ModelUnavailableError('AI_PREDICT_URL 미설정')

    const timeout = Number(process.env.AI_PREDICT_TIMEOUT_MS ?? 3000)
    let res
    try {
      res = await axios.post(url, input, {
        timeout,
        headers: { 'Content-Type': 'application/json' },
        // 추론 서버가 오류를 200 이외로 반환하면 예외로 처리한다
        validateStatus: (s: number) => s === 200,
      } as any)
    } catch (err: any) {
      throw new ModelUnavailableError(err?.message ?? '추론 서버 호출 실패')
    }
    return normalizeModelOutput(res.data)
  },
}

// ─────────────────────────────────────────────
// table 어댑터 — 배치로 적재된 예측 결과를 조회한다(v9.7 정식 경로).
//
// 조회 기준은 "그 종목의 가장 최근 행"이 아니라 "그 구간의 최신 배치일에 있는 행"이다.
// 종목 단위로 최신 행을 집으면, 현재 배치에서 빠진 종목이 과거 배치의 예측으로 응답되어
// 오래된 결과가 현재 예측처럼 노출된다(배치 신선도 위반). 그 경우 "미산출 종목"이라는
// 상태 자체가 사라져 응답 최소화 정책도 무너지므로, 배치일을 먼저 고정한 뒤 조회한다.
// 해당 배치에 종목이 없으면 PredictionNotFoundError 를 던진다.
// (1d/1w/1m 은 거래대금 상위 500 종목만 산출되므로 "예측 없음"이 정상 상태다)
// ─────────────────────────────────────────────
const tableAdapter: PredictionAdapter = {
  name: 'table',
  async predict({ code, horizon }) {
    const StockPrediction = (await import('../../models/ai/StockPrediction')).default

    const latest = await StockPrediction.findOne({
      where: { horizon },
      order: [['predict_date', 'DESC']],
      attributes: ['predict_date'],
    })
    if (!latest) throw new PredictionNotFoundError(`적재된 배치 없음: ${horizon}`)

    const row = await StockPrediction.findOne({
      where: { ticker: code, horizon, predict_date: latest.predict_date },
    })
    if (!row) throw new PredictionNotFoundError(`예측 결과 없음: ${code} ${horizon}`)

    const probability = Number(row.prob)
    if (!Number.isFinite(probability)) throw new ModelContractError('적재된 확률 값이 비정상')

    return {
      label: row.direction === 'UP' ? 1 : 0,
      probability: Math.min(1, Math.max(0, probability)),
      recommended: Boolean(row.recommended),
      predictDate: String(row.predict_date),
    }
  },
}

const ADAPTERS: Record<string, PredictionAdapter> = {
  table: tableAdapter,
  mock: mockAdapter,
  http: httpAdapter,
}

let warned = false

export function getPredictionAdapter(): PredictionAdapter {
  const key = (process.env.AI_ADAPTER ?? 'mock').toLowerCase()
  const adapter = ADAPTERS[key]
  if (!adapter) {
    throw new ModelUnavailableError(`알 수 없는 AI_ADAPTER: ${key} (사용 가능: ${Object.keys(ADAPTERS).join(', ')})`)
  }
  if (adapter.name === 'mock' && !warned) {
    warned = true
    console.warn('[AI] mock 어댑터로 동작 중 — 실제 모델 결과가 아닙니다 (.env 의 AI_ADAPTER 확인)')
  }
  return adapter
}
