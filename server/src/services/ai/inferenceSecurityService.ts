import { QueryTypes } from 'sequelize'
import sequelize from '../../config/database'
import InferenceLog, { InferenceDecision, InferenceDenyReason } from '../../models/ai/InferenceLog'
import { HORIZONS, Horizon, PredictionInput } from './predictionAdapter'
import { recordInferenceAbuse } from '../auth/anomalyService'

// ─────────────────────────────────────────────────────────────
// AI 추론 파이프라인 보안 정책
//
// 추론 엔드포인트는 학습된 모델이라는 자산을 노출하는 지점이므로, 인증(JWT) 뒤에
// 다음 통제를 순차 적용한다.
//   1) 입력 스키마 검증  — 허용된 필드·형식·값만 통과 (모델 도달 전 차단)
//   2) 예측 대상 화이트리스트 — 상장·학습 대상 종목만 조회 허용
//   3) 호출량 제한       — 분당·10분 누적 한도
//   4) 모델 추출 탐지    — 짧은 시간에 광범위한 종목을 훑는 패턴
//   5) 응답 최소화       — 확률 양자화, 내부 정보 비노출
//   6) 감사 로그         — 허용·차단 전건 inference_logs 기록
//
// 상태(호출 이력)는 인메모리로 관리한다. 서버 재시작 시 초기화되며, 장기 추이 분석은
// inference_logs 를 조회해 수행한다.
// ─────────────────────────────────────────────────────────────

// 호출량 한도는 "모델 추출 방어"가 아니라 조회 API 남용 방지다.
//
// 모델 추출 공격은 공격자가 특징 벡터를 바꿔가며 결정 경계를 탐침해야 성립한다. 이 API 가
// 받는 입력은 {code, horizon} 즉 조회 키뿐이고, 특징은 배치 파이프라인이 시장 데이터에서
// 서버 측으로 계산한다. 입력을 변화시킬 수 없으므로 대리 모델 학습에 쓸 (입력, 출력) 쌍이
// 만들어지지 않는다. 전 종목을 조회해도 얻는 것은 "그날 하루치 예측 테이블" 한 장이다.
//
// 그래서 "10분 내 서로 다른 종목 60개" 규칙(EXTRACTION)은 폐기했다. 배치 조회 테이블에서
// 조회 키의 다양성은 공격 신호가 아니며, 종목을 많이 둘러보는 정상 사용자와 구분되지 않아
// 오탐만 만들었다(61번째 종목을 연 사용자가 공격자로 기록됨).
export const POLICY = {
  RATE: { WINDOW_MS: 60_000, MAX: 20 },                    // 분당 호출 한도
  BURST: { WINDOW_MS: 10 * 60_000, MAX: 120 },             // 10분 누적 호출 한도
  SCHEMA_ABUSE: { WINDOW_MS: 10 * 60_000, MAX: 5 },        // 스키마 위반 반복 임계
  PROBABILITY_STEP: 0.05,                                  // 확률 양자화 간격(5%p)
} as const

const ALLOWED_FIELDS = new Set(['code', 'horizon'])
const CODE_PATTERN = /^\d{6}$/

export type ValidationResult =
  | { ok: true; input: PredictionInput }
  | { ok: false; reason: InferenceDenyReason }

// ─────────────────────────────────────────────
// 1) 입력 스키마 검증
//   - 허용 필드 외 키가 있으면 거부 (파라미터 오염·프로토타입 오염 차단)
//   - 형식·값 화이트리스트를 모두 통과해야 모델에 도달한다
// ─────────────────────────────────────────────
export function validateInferenceInput(body: unknown): ValidationResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'INVALID_SHAPE' }
  }

  // Object.keys 는 프로토타입 키를 열거하지 않으므로 원시 키 존재 여부를 직접 확인한다
  const raw = body as Record<string, unknown>
  for (const forbidden of ['__proto__', 'constructor', 'prototype']) {
    if (Object.prototype.hasOwnProperty.call(raw, forbidden)) {
      return { ok: false, reason: 'UNKNOWN_FIELD' }
    }
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_FIELDS.has(key)) return { ok: false, reason: 'UNKNOWN_FIELD' }
  }

  const { code, horizon } = raw
  if (typeof code !== 'string' || typeof horizon !== 'string') {
    return { ok: false, reason: 'INVALID_SHAPE' }
  }
  if (!CODE_PATTERN.test(code)) return { ok: false, reason: 'INVALID_CODE' }
  if (!(HORIZONS as readonly string[]).includes(horizon)) return { ok: false, reason: 'INVALID_HORIZON' }

  return { ok: true, input: { code, horizon: horizon as Horizon } }
}

// ─────────────────────────────────────────────
// 2) 예측 대상 화이트리스트
//   상장 폐지 종목·학습 대상이 아닌 종목에 대한 질의를 막아, 임의 코드 대입으로
//   모델 응답 표면을 넓히는 시도를 차단한다. 조회 결과는 5분간 캐시한다.
// ─────────────────────────────────────────────
const CODE_CACHE_TTL_MS = 5 * 60_000
const predictableCodeCache = new Map<string, number>() // code → 만료 시각

export async function isPredictableCode(code: string): Promise<boolean> {
  const now = Date.now()
  const cached = predictableCodeCache.get(code)
  if (cached !== undefined && cached > now) return true

  const rows = await sequelize.query<{ cnt: number }>(
    'SELECT COUNT(*) AS cnt FROM stocks WHERE code = :code AND is_active = 1 AND is_ml_target = 1',
    { replacements: { code }, type: QueryTypes.SELECT },
  )
  const ok = Number(rows[0]?.cnt ?? 0) > 0

  // 존재하는 코드만 캐시한다 — 임의 코드 대입으로 캐시가 비대해지는 것을 막는다
  if (ok) predictableCodeCache.set(code, now + CODE_CACHE_TTL_MS)
  return ok
}

// ─────────────────────────────────────────────
// 3~4) 호출량 제한 및 모델 추출 탐지
// ─────────────────────────────────────────────
interface CallHistory {
  times: number[]                    // 호출 시각
  codes: Map<string, number>         // 종목코드 → 최근 조회 시각
}

const callHistory = new Map<number, CallHistory>()
const schemaViolations = new Map<number, number[]>()

function history(userId: number): CallHistory {
  let h = callHistory.get(userId)
  if (!h) {
    h = { times: [], codes: new Map() }
    callHistory.set(userId, h)
  }
  return h
}

function prune(h: CallHistory, now: number): void {
  const burstStart = now - POLICY.BURST.WINDOW_MS
  h.times = h.times.filter((t) => t > burstStart)

  // 종목별 최근 조회 시각은 통계·감사 용도로만 유지한다(차단 판정에는 쓰지 않는다).
  for (const [code, t] of h.codes) {
    if (t <= burstStart) h.codes.delete(code)
  }
}

/** 호출 허용 여부 판정 — 허용 시 이력을 갱신한다 */
export function checkCallQuota(userId: number, code: string, now = Date.now()): InferenceDenyReason | null {
  const h = history(userId)
  prune(h, now)

  const perMinute = h.times.filter((t) => t > now - POLICY.RATE.WINDOW_MS).length
  if (perMinute >= POLICY.RATE.MAX) return 'RATE_LIMIT'
  if (h.times.length >= POLICY.BURST.MAX) return 'BURST_LIMIT'

  h.times.push(now)
  h.codes.set(code, now)
  return null
}

/** 스키마 위반 누적 — 임계 초과 시 true (이상탐지 승격 대상) */
export function recordSchemaViolation(userId: number, now = Date.now()): boolean {
  const windowStart = now - POLICY.SCHEMA_ABUSE.WINDOW_MS
  const hits = (schemaViolations.get(userId) ?? []).filter((t) => t > windowStart)
  hits.push(now)
  schemaViolations.set(userId, hits)
  return hits.length >= POLICY.SCHEMA_ABUSE.MAX
}

// 차단 요청은 스스로 제한되지 않으므로(차단된 요청도 계속 보낼 수 있다) 로그 폭주를 막는다.
// 사용자당 1분에 기록할 차단 로그 수를 제한하고, 초과분은 건수만 세어 이상탐지 상세에 남긴다.
const DENIAL_LOG_BUDGET = { WINDOW_MS: 60_000, MAX: 30 } as const
const denialBudget = new Map<number, { windowStart: number; written: number; suppressed: number }>()

export function claimDenialLogBudget(userId: number, now = Date.now()): { allowed: boolean; suppressed: number } {
  let b = denialBudget.get(userId)
  if (!b || now - b.windowStart > DENIAL_LOG_BUDGET.WINDOW_MS) {
    b = { windowStart: now, written: 0, suppressed: 0 }
    denialBudget.set(userId, b)
  }
  if (b.written < DENIAL_LOG_BUDGET.MAX) {
    b.written++
    return { allowed: true, suppressed: b.suppressed }
  }
  b.suppressed++
  return { allowed: false, suppressed: b.suppressed }
}

// 동일 사용자·사유의 이상탐지 승격 중복 방지
const ESCALATION_COOLDOWN_MS = 10 * 60_000
const escalationCooldown = new Map<string, number>()

function claimEscalation(userId: number, reason: string, now = Date.now()): boolean {
  const key = `${userId}:${reason}`
  const last = escalationCooldown.get(key) ?? 0
  if (now - last < ESCALATION_COOLDOWN_MS) return false
  escalationCooldown.set(key, now)
  return true
}

/** 테스트·운영 점검용 — 인메모리 카운터 초기화 */
export function resetInferenceCounters(userId?: number): void {
  if (userId === undefined) {
    callHistory.clear()
    schemaViolations.clear()
    denialBudget.clear()
    escalationCooldown.clear()
    return
  }
  callHistory.delete(userId)
  schemaViolations.delete(userId)
  denialBudget.delete(userId)
  for (const key of escalationCooldown.keys()) {
    if (key.startsWith(`${userId}:`)) escalationCooldown.delete(key)
  }
}

// ─────────────────────────────────────────────
// 5) 응답 최소화 — 확률 양자화
//   원시 확률을 그대로 노출하면 반복 질의로 결정 경계를 정밀 복원할 수 있어,
//   5%p 격자로 반올림한 값만 응답에 담는다.
// ─────────────────────────────────────────────
export function quantizeProbability(p: number): number {
  const step = POLICY.PROBABILITY_STEP
  const q = Math.round(p / step) * step
  return Math.min(1, Math.max(0, Number(q.toFixed(2))))
}

// ─────────────────────────────────────────────
// 6) 감사 로그 + 이상탐지 승격
// ─────────────────────────────────────────────
export interface InferenceLogParams {
  userId: number | null
  ip: string
  userAgent?: string
  code?: string | null
  horizon?: string | null
  decision: InferenceDecision
  denyReason?: InferenceDenyReason | null
  label?: number | null
  probability?: number | null
  latencyMs?: number | null
  adapter?: string | null
}

export async function logInference(params: InferenceLogParams): Promise<void> {
  try {
    await InferenceLog.create({
      user_id: params.userId,
      ip: params.ip,
      user_agent: params.userAgent ?? null,
      stock_code: params.code ?? null,
      horizon: params.horizon ?? null,
      decision: params.decision,
      deny_reason: params.denyReason ?? null,
      label: params.label ?? null,
      probability: params.probability ?? null,
      latency_ms: params.latencyMs ?? null,
      adapter: params.adapter ?? null,
    })
  } catch (err) {
    console.error('[AI] 추론 로그 기록 실패:', err)
  }
}

/**
 * 차단 사유에 따라 이상탐지(anomaly_logs)로 승격한다.
 *   - 모델 추출 의심 : 즉시 승격 + 관리자 경보 (BLOCK)
 *   - 스키마 위반    : 반복 임계 초과 시 승격 (ALERT)
 *   - 호출량 초과    : 반복 임계 초과 시 승격 (ALERT)
 */
export async function escalateInferenceDenial(params: {
  userId: number
  email?: string
  ip: string
  userAgent?: string
  reason: InferenceDenyReason
  detail: string
}): Promise<void> {
  const { reason } = params

  const isSchemaViolation =
    reason === 'INVALID_SHAPE' || reason === 'UNKNOWN_FIELD' ||
    reason === 'INVALID_CODE' || reason === 'INVALID_HORIZON' || reason === 'UNKNOWN_CODE'

  if (isSchemaViolation) {
    // 형식 오류는 단발로 발생할 수 있어(구버전 클라이언트 등) 반복 임계를 넘길 때만 승격한다
    if (recordSchemaViolation(params.userId) && claimEscalation(params.userId, 'SCHEMA')) {
      await recordInferenceAbuse({ ...params, type: 'ADVERSARIAL_INPUT', action: 'ALERT' })
    }
    return
  }

  // 호출량 초과는 조회 API 남용으로 기록한다. 모델 도난이 아니므로 MODEL_EXTRACTION 을 쓰지 않는다.
  if (reason === 'RATE_LIMIT' || reason === 'BURST_LIMIT') {
    if (claimEscalation(params.userId, reason)) {
      await recordInferenceAbuse({ ...params, type: 'INFERENCE_ABUSE', action: 'ALERT' })
    }
  }
}
