import { Op, QueryTypes } from 'sequelize'
import sequelize from '../../config/database'
import VirtualOrder from '../../models/trade/VirtualOrder'
import RealOrder from '../../models/trade/RealOrder'
import User from '../../models/user/User'
import {
  Baseline,
  EMPTY_BASELINE,
  monotonicTrend,
  robustScore,
  scoreToMultiple,
  summarize,
  trendRatio,
} from './statsEngine'
import { recordTradeAnomaly } from './anomalyService'

// ─────────────────────────────────────────────────────────────
// M-1 거래 이상탐지 — 주문 무결성 + 개인 베이스라인 이탈
//
// 무엇을 보는가(입력 신호)
//   S0 주문 파라미터 자체        : 수량·가격·금액의 정합성(정수·양수·상한)
//   S1 단건 거래금액             : 사용자의 과거 거래금액 분포에서의 이탈(로그 강건 z)
//   S2 최근 24시간 누적 거래금액 : 분할 주문(smurfing) 회피를 잡기 위한 누적 관점
//   S3 포트폴리오 대비 비율      : 통계와 무관한 절대 상한(베이스라인 오염 내성)
//   S4 베이스라인 상승 추세      : 금액을 조금씩 키워 기준선을 끌어올리는 회피 탐지
//                                  (중앙값 비율 = 크기, Mann-Kendall z = 방향, 둘 다 충족 시)
//
// 어떻게 판정하는가
//   BLOCK   : S0 위반 — 정상 클라이언트에서 나올 수 없는 주문. 즉시 거절(fail-closed).
//   STEP_UP : S1~S4 중 하나라도 임계 초과 — 지갑 서명(소유자 증명) 재인증을 요구한다.
//             서명이 동봉되면 그대로 진행하되 탐지 사실은 기록한다.
//   ALLOW   : 그 외.
//
// 왜 통계와 비율을 함께 쓰는가
//   비율 규칙만 두면 "포트폴리오의 19%"를 반복하는 공격을 영원히 통과시킨다.
//   통계 규칙만 두면 공격자가 금액을 서서히 키워 베이스라인을 오염시킬 수 있다.
//   두 규칙은 서로의 회피 경로를 막는다 — 비율은 통계로 무력화되지 않고,
//   통계는 비율 하한 아래의 습관 이탈을 잡는다.
//
// 로깅 원칙: 거래금액은 이미 주문 내역에 남는 정보라 근거로 기록하되,
//           계좌 평가액·잔고는 절대금액을 남기지 않고 비율(%)로만 기록한다.
// ─────────────────────────────────────────────────────────────

export const TRADE_POLICY = {
  BASELINE: {
    WINDOW_DAYS: 90,    // 베이스라인 표본 기간
    MAX_SAMPLES: 200,   // 표본 상한(최근 순)
    MIN_SAMPLES: 5,     // 이보다 적으면 통계 판정을 하지 않는다(콜드 스타트)
  },
  DAILY: {
    WINDOW_MS: 24 * 60 * 60 * 1000,
    MIN_DAYS: 5,        // 일별 누적 베이스라인 최소 표본 일수
  },
  Z: {
    STEP_UP: 3.5,       // 수정 z-점수 이상치 관례값
  },
  RATIO: {
    STEP_UP: 0.2,       // 포트폴리오 평가액 대비 20% 초과(기존 고액거래 규칙 승계)
  },
  ESCALATION: {
    MIN_SAMPLES: 8,
    // 크기 조건: 최근 절반 중앙값 / 이전 절반 중앙값.
    // 선형 상승에서 이 비율의 이론적 상한이 3 이므로(statsEngine.trendRatio 주석)
    // 3 으로 두면 등차로 키우는 공격은 절대 걸리지 않는다. 1.5 로 낮추는 대신
    // 아래 단조성 조건을 함께 요구해 정상 사용자의 우연한 변동을 걸러낸다.
    RATIO: 1.5,
    // 방향 조건: Mann-Kendall 단측 z. 2.33 ≈ p<0.01
    TREND_Z: 2.33,
  },
  SANITY: {
    MAX_QUANTITY: 1_000_000,
    MAX_PRICE: 100_000_000,
    MAX_AMOUNT: 1_000_000_000_000,
  },
  // M-2 / M-3 — 위험 맥락에서의 임계 완화
  //
  // 평상시 임계(z 3.5 / 비율 20%)는 "정상 사용자를 성가시게 하지 않는" 값으로 잡혀 있다.
  // 그런데 계정을 막 탈취한 공격자는 (1) 소유자가 되돌리지 못하도록 비밀번호·이메일을
  // 먼저 바꾸고 (2) 곧바로 자산을 옮긴다. 오래 방치된 계정이 갑자기 활동하는 것도 같은
  // 성격이다. 이 두 창(window) 안에서는 같은 금액이라도 위험도가 다르므로 임계를 낮춘다.
  //
  // 즉 "새 규칙"이 아니라 **맥락에 따라 기존 임계를 조정**하는 구조다. 이렇게 하면
  // 평상시 오탐을 늘리지 않으면서 탈취 직후 구간의 민감도만 올릴 수 있다.
  ELEVATED: {
    CREDENTIAL_CHANGE_WINDOW_MIN: 30,  // 비밀번호·이메일 변경 후 이 시간 안(M-2)
    DORMANT_DAYS: 30,                  // 마지막 활동 이후 이 기간을 넘겨 방치됨(M-3)
    Z: 2.0,                            // 완화된 단건 z 임계 (평상시 3.5)
    RATIO: 0.05,                       // 완화된 평가액 비율 임계 (평상시 20%)
  },
} as const

export type SanityReason =
  | 'QUANTITY_NOT_FINITE'
  | 'QUANTITY_NOT_INTEGER'
  | 'QUANTITY_NOT_POSITIVE'
  | 'QUANTITY_TOO_LARGE'
  | 'PRICE_NOT_FINITE'
  | 'PRICE_NOT_POSITIVE'
  | 'PRICE_TOO_LARGE'
  | 'AMOUNT_NOT_FINITE'
  | 'AMOUNT_TOO_LARGE'

export type TradeSignal =
  | 'SANITY_VIOLATION'
  | 'AMOUNT_ZSCORE'
  | 'DAILY_ZSCORE'
  | 'PORTFOLIO_RATIO'
  | 'BASELINE_ESCALATION'
  | 'POST_CREDENTIAL_CHANGE'   // M-2 자격증명 변경 직후 고액 거래
  | 'DORMANT_ACTIVITY'         // M-3 장기 미사용 계정의 갑작스러운 고액 거래

export type TradeVerdict = 'ALLOW' | 'STEP_UP' | 'BLOCK'

export interface TradeAssessment {
  verdict: TradeVerdict
  signals: TradeSignal[]
  sanityReason: SanityReason | null
  amountZ: number | null      // 표본 부족 시 null
  dailyZ: number | null
  ratio: number | null        // 포트폴리오 대비 비율
  trend: number | null        // 베이스라인 상승 배수
  trendZ: number | null       // 단조 상승 검정(Mann-Kendall) z
  baseline: Baseline
  detail: string              // anomaly_logs·관리자용
  userMessage: string         // 사용자 응답·이메일용
}

export interface TradeInput {
  quantity: number
  price: number
  portfolioValue?: number | null   // 실계좌처럼 평가액을 못 구하면 생략 → 비율 규칙 미적용
  history: readonly number[]       // 과거 단건 거래금액(시간 오름차순)
  dailyTotals: readonly number[]   // 과거 일별 거래총액(오늘 제외, 시간 오름차순)
  recentTotal?: number             // 최근 24시간 누적 거래금액(현재 주문 제외)
  // 위험 맥락 — 값이 없으면(null/undefined) 해당 규칙은 평가하지 않는다.
  minutesSinceCredentialChange?: number | null  // M-2: 비밀번호·이메일 최종 변경 후 경과 분
  daysSinceLastActivity?: number | null         // M-3: 마지막 거래 이후 경과 일
}

const won = (v: number): string => `${Math.round(v).toLocaleString('ko-KR')}원`
const pct = (v: number): string => `${(v * 100).toFixed(1)}%`

// ─────────────────────────────────────────────
// S0. 주문 파라미터 무결성 — 통계 이전에 먼저 본다
//
// 수량이 음수면 총액이 음수가 되어 "잔고 차감"이 "잔고 증가"로 뒤집힌다.
// 소수 수량은 DB(INTEGER)에서 반올림되며 계좌 상태와 주문 기록이 어긋난다.
// 정상 클라이언트는 이런 값을 만들 수 없으므로 경고가 아니라 즉시 거절한다.
// ─────────────────────────────────────────────
export function validateOrderIntegrity(
  quantity: number,
  price: number,
): { ok: true; amount: number } | { ok: false; reason: SanityReason } {
  if (!Number.isFinite(quantity)) return { ok: false, reason: 'QUANTITY_NOT_FINITE' }
  if (!Number.isInteger(quantity)) return { ok: false, reason: 'QUANTITY_NOT_INTEGER' }
  if (quantity <= 0) return { ok: false, reason: 'QUANTITY_NOT_POSITIVE' }
  if (quantity > TRADE_POLICY.SANITY.MAX_QUANTITY) return { ok: false, reason: 'QUANTITY_TOO_LARGE' }

  if (!Number.isFinite(price)) return { ok: false, reason: 'PRICE_NOT_FINITE' }
  if (price <= 0) return { ok: false, reason: 'PRICE_NOT_POSITIVE' }
  if (price > TRADE_POLICY.SANITY.MAX_PRICE) return { ok: false, reason: 'PRICE_TOO_LARGE' }

  const amount = price * quantity
  if (!Number.isFinite(amount)) return { ok: false, reason: 'AMOUNT_NOT_FINITE' }
  if (amount > TRADE_POLICY.SANITY.MAX_AMOUNT) return { ok: false, reason: 'AMOUNT_TOO_LARGE' }

  return { ok: true, amount }
}

const SANITY_LABEL: Record<SanityReason, string> = {
  QUANTITY_NOT_FINITE:  '수량이 숫자가 아님',
  QUANTITY_NOT_INTEGER: '수량이 정수가 아님',
  QUANTITY_NOT_POSITIVE: '수량이 0 이하(음수 수량 주문)',
  QUANTITY_TOO_LARGE:   '수량 상한 초과',
  PRICE_NOT_FINITE:     '가격이 숫자가 아님',
  PRICE_NOT_POSITIVE:   '가격이 0 이하',
  PRICE_TOO_LARGE:      '가격 상한 초과',
  AMOUNT_NOT_FINITE:    '주문 금액 계산 불가',
  AMOUNT_TOO_LARGE:     '주문 금액 상한 초과',
}

// ─────────────────────────────────────────────
// 판정 본체 — DB 접근이 없는 순수 함수(검증 스크립트가 직접 호출한다)
// ─────────────────────────────────────────────
export function assessTrade(input: TradeInput): TradeAssessment {
  const integrity = validateOrderIntegrity(input.quantity, input.price)

  if (!integrity.ok) {
    return {
      verdict: 'BLOCK',
      signals: ['SANITY_VIOLATION'],
      sanityReason: integrity.reason,
      amountZ: null,
      dailyZ: null,
      ratio: null,
      trend: null,
      trendZ: null,
      baseline: { ...EMPTY_BASELINE },
      detail: `주문 무결성 위반(${integrity.reason}) — ${SANITY_LABEL[integrity.reason]}: 수량=${input.quantity}, 가격=${input.price}`,
      userMessage: '주문 값이 올바르지 않습니다. 수량과 가격을 확인해주세요.',
    }
  }

  const amount = integrity.amount
  const signals: TradeSignal[] = []
  const reasons: string[] = []
  const userReasons: string[] = []

  // S1. 단건 거래금액 이탈
  const baseline = summarize(input.history)
  let amountZ: number | null = null
  if (baseline.n >= TRADE_POLICY.BASELINE.MIN_SAMPLES) {
    amountZ = robustScore(amount, baseline)
    if (amountZ >= TRADE_POLICY.Z.STEP_UP) {
      signals.push('AMOUNT_ZSCORE')
      const multiple = amount / (baseline.median || 1)
      reasons.push(
        `단건 금액 이탈 z=${amountZ.toFixed(2)}(임계 ${TRADE_POLICY.Z.STEP_UP}) — ` +
        `금액 ${won(amount)}, 평소 중앙값 ${won(baseline.median)}의 ${multiple.toFixed(1)}배, 표본 ${baseline.n}건`,
      )
      userReasons.push(`평소 거래금액(${won(baseline.median)})의 약 ${multiple.toFixed(1)}배인 주문입니다.`)
    }
  }

  // S2. 최근 24시간 누적 금액 이탈 — 분할 주문 회피 대응
  const dailyBaseline = summarize(input.dailyTotals)
  let dailyZ: number | null = null
  const cumulative = (input.recentTotal ?? 0) + amount
  if (dailyBaseline.n >= TRADE_POLICY.DAILY.MIN_DAYS) {
    dailyZ = robustScore(cumulative, dailyBaseline)
    if (dailyZ >= TRADE_POLICY.Z.STEP_UP) {
      signals.push('DAILY_ZSCORE')
      const multiple = cumulative / (dailyBaseline.median || 1)
      reasons.push(
        `24시간 누적 금액 이탈 z=${dailyZ.toFixed(2)} — ` +
        `누적 ${won(cumulative)}, 평소 일간 중앙값 ${won(dailyBaseline.median)}의 ${multiple.toFixed(1)}배, 표본 ${dailyBaseline.n}일`,
      )
      userReasons.push(`최근 24시간 거래 총액이 평소 하루 거래액의 약 ${multiple.toFixed(1)}배입니다.`)
    }
  }

  // S3. 포트폴리오 대비 비율 — 통계로 무력화되지 않는 절대 상한
  let ratio: number | null = null
  if (input.portfolioValue != null && Number.isFinite(input.portfolioValue) && input.portfolioValue > 0) {
    ratio = amount / input.portfolioValue
    if (ratio > TRADE_POLICY.RATIO.STEP_UP) {
      signals.push('PORTFOLIO_RATIO')
      reasons.push(`평가액 대비 ${pct(ratio)}(임계 ${pct(TRADE_POLICY.RATIO.STEP_UP)}) 규모 주문`)
      userReasons.push(`보유 자산의 ${pct(ratio)}에 해당하는 고액 주문입니다.`)
    }
  }

  // S4. 베이스라인 상승 추세 — 기준선을 서서히 끌어올리는 회피 시도
  //     크기(중앙값 비율)와 방향(단조 상승 유의성)을 모두 만족할 때만 신호로 본다.
  const trend = trendRatio(input.history, TRADE_POLICY.ESCALATION.MIN_SAMPLES)
  const mk = monotonicTrend(input.history, TRADE_POLICY.ESCALATION.MIN_SAMPLES)
  const trendZ = mk?.z ?? null
  if (
    trend != null && trend >= TRADE_POLICY.ESCALATION.RATIO &&
    trendZ != null && trendZ >= TRADE_POLICY.ESCALATION.TREND_Z
  ) {
    signals.push('BASELINE_ESCALATION')
    reasons.push(
      `거래금액 기준선 상승 ${trend.toFixed(1)}배(임계 ${TRADE_POLICY.ESCALATION.RATIO}배), ` +
      `단조 상승 검정 z=${trendZ.toFixed(2)}(임계 ${TRADE_POLICY.ESCALATION.TREND_Z}) — ` +
      `최근 표본이 이전 구간 대비 일관되게 상승(기준선 오염 시도 의심)`,
    )
    userReasons.push('최근 거래 금액이 이전보다 지속적으로 커지는 패턴이 감지되었습니다.')
  }

  // ── S5 / S6. 위험 맥락에서의 임계 완화 (M-2 / M-3) ──────────────
  //
  // 두 규칙은 같은 판정식을 공유한다: "완화 임계(z 2.0 또는 평가액 5%)를 넘는 금액이,
  // 위험한 시간 창 안에서 발생했는가". 다른 것은 창의 정의뿐이다.
  //
  // 평상시 임계를 이미 넘어 다른 신호가 선 경우에도 이 신호를 함께 남긴다 —
  // 관리자가 "왜 위험한가"를 판단할 때 금액 크기보다 맥락이 더 중요하기 때문이다.
  const elevatedExceeded =
    (amountZ != null && amountZ >= TRADE_POLICY.ELEVATED.Z) ||
    (ratio != null && ratio > TRADE_POLICY.ELEVATED.RATIO)

  // 완화 임계를 넘었는데 평상시 임계로는 무엇이 걸렸는지 설명에 함께 적는다.
  const elevatedEvidence = (): string => {
    const parts: string[] = []
    if (amountZ != null) parts.push(`단건 z=${amountZ.toFixed(2)}(완화 임계 ${TRADE_POLICY.ELEVATED.Z})`)
    if (ratio != null) parts.push(`평가액 대비 ${pct(ratio)}(완화 임계 ${pct(TRADE_POLICY.ELEVATED.RATIO)})`)
    return parts.join(', ')
  }

  // M-2. 비밀번호·이메일 변경 직후 고액 거래
  //   탈취 계정의 전형적 순서다 — 소유자가 되돌리지 못하도록 자격증명을 먼저 바꾸고
  //   곧바로 자산을 옮긴다. 변경 자체는 정상 행위라 단독으로는 신호가 되지 않지만,
  //   "변경 + 평소보다 큰 거래"의 조합은 정당한 사용자에게 흔치 않다.
  const sinceChange = input.minutesSinceCredentialChange
  if (
    sinceChange != null && Number.isFinite(sinceChange) &&
    sinceChange >= 0 && sinceChange <= TRADE_POLICY.ELEVATED.CREDENTIAL_CHANGE_WINDOW_MIN &&
    elevatedExceeded
  ) {
    signals.push('POST_CREDENTIAL_CHANGE')
    reasons.push(
      `계정 정보 변경 ${Math.round(sinceChange)}분 후 고액 거래 ` +
      `(창 ${TRADE_POLICY.ELEVATED.CREDENTIAL_CHANGE_WINDOW_MIN}분) — ${elevatedEvidence()}`,
    )
    userReasons.push('비밀번호 또는 이메일을 변경한 직후의 고액 주문입니다.')
  }

  // M-3. 장기 미사용 계정의 갑작스러운 고액 거래
  //   오래 방치된 계정은 소유자의 감시도 느슨해 탈취 후 악용 표적이 되기 쉽다.
  //   재개 자체를 막지는 않되, 재개하자마자 큰 금액이 나가는 경우를 표시한다.
  const dormantDays = input.daysSinceLastActivity
  if (
    dormantDays != null && Number.isFinite(dormantDays) &&
    dormantDays >= TRADE_POLICY.ELEVATED.DORMANT_DAYS &&
    elevatedExceeded
  ) {
    signals.push('DORMANT_ACTIVITY')
    reasons.push(
      `${Math.round(dormantDays)}일 미사용 후 고액 거래 ` +
      `(임계 ${TRADE_POLICY.ELEVATED.DORMANT_DAYS}일) — ${elevatedEvidence()}`,
    )
    userReasons.push(`${Math.round(dormantDays)}일 만의 거래이면서 평소보다 큰 금액입니다.`)
  }

  if (signals.length === 0) {
    return {
      verdict: 'ALLOW',
      signals,
      sanityReason: null,
      amountZ,
      dailyZ,
      ratio,
      trend,
      trendZ,
      baseline,
      detail: '',
      userMessage: '',
    }
  }

  return {
    verdict: 'STEP_UP',
    signals,
    sanityReason: null,
    amountZ,
    dailyZ,
    ratio,
    trend,
    trendZ,
    baseline,
    detail: `거래 이상 탐지 [${signals.join(', ')}] ${reasons.join(' / ')}`,
    userMessage: `${userReasons.join(' ')} 본인 확인을 위해 지갑 서명이 필요합니다.`,
  }
}

/** z 점수를 사람이 읽는 배수로 — 관리자 화면·보고서용 */
export function describeScore(z: number, baseline: Baseline): string {
  return `${scoreToMultiple(z, baseline).toFixed(1)}배`
}

// ─────────────────────────────────────────────
// 베이스라인 표본 적재
//
// 취소·실패 주문은 자산이 실제로 움직이지 않았으므로 습관 표본에서 제외한다.
// 최근 MAX_SAMPLES 건만 사용해(오래된 습관 배제) 시간 오름차순으로 돌려준다.
// ─────────────────────────────────────────────
export type Market = 'virtual' | 'real'

/**
 * 위험 맥락 조회 (M-2 / M-3).
 *
 * 두 값 모두 "없으면 평가하지 않는다"가 원칙이다. 변경 이력이 없는 계정(가입 후 한 번도
 * 안 바꿈)이나 첫 거래인 계정을 위험으로 몰지 않기 위해서다. 조회가 실패해도 거래를
 * 막지 않고 null 을 돌려 규칙만 건너뛴다 — 탐지 장애가 본 서비스를 멈추면 안 된다.
 */
export async function loadRiskContext(
  userId: number,
  market: Market,
): Promise<{ minutesSinceCredentialChange: number | null; daysSinceLastActivity: number | null }> {
  const empty = { minutesSinceCredentialChange: null, daysSinceLastActivity: null }
  try {
    const model: any = market === 'real' ? RealOrder : VirtualOrder
    const [user, lastOrder] = await Promise.all([
      User.findByPk(userId, { attributes: ['password_changed_at', 'email_changed_at'], raw: true }),
      model.findOne({
        where: { user_id: userId },
        attributes: ['ordered_at'],
        order: [['ordered_at', 'DESC']],
        raw: true,
      }),
    ])

    const now = Date.now()

    // 비밀번호·이메일 중 더 최근에 바뀐 쪽을 기준으로 삼는다.
    const changeTimes = [(user as any)?.password_changed_at, (user as any)?.email_changed_at]
      .map((v) => (v ? new Date(v).getTime() : NaN))
      .filter((t) => Number.isFinite(t))
    const lastChange = changeTimes.length > 0 ? Math.max(...changeTimes) : null

    const lastAt = lastOrder?.ordered_at ? new Date(lastOrder.ordered_at).getTime() : null

    return {
      minutesSinceCredentialChange: lastChange != null ? (now - lastChange) / 60_000 : null,
      daysSinceLastActivity: lastAt != null ? (now - lastAt) / 86_400_000 : null,
    }
  } catch (err) {
    console.error('[TradeAnomaly] 위험 맥락 조회 실패 — M-2/M-3 미적용:', err)
    return empty
  }
}

export async function loadTradeHistory(userId: number, market: Market): Promise<number[]> {
  const cutoff = new Date(Date.now() - TRADE_POLICY.BASELINE.WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const model: any = market === 'real' ? RealOrder : VirtualOrder
  const excluded = market === 'real' ? ['cancelled', 'failed'] : ['cancelled']

  const rows = await model.findAll({
    where: {
      user_id: userId,
      ordered_at: { [Op.gte]: cutoff },
      status: { [Op.notIn]: excluded },
    },
    attributes: ['total_amount'],
    order: [['ordered_at', 'DESC']],
    limit: TRADE_POLICY.BASELINE.MAX_SAMPLES,
    raw: true,
  })

  return rows
    .map((r: { total_amount: unknown }) => Number(r.total_amount))
    .filter((v: number) => Number.isFinite(v) && v > 0)
    .reverse()
}

/**
 * 일별 거래총액 베이스라인(최근 24시간 제외) + 최근 24시간 누적액.
 * 하루 안에 여러 건으로 쪼개는 분할 주문을 누적 관점으로 잡기 위한 표본이다.
 */
export async function loadDailyTotals(
  userId: number,
  market: Market,
): Promise<{ dailyTotals: number[]; recentTotal: number }> {
  const table = market === 'real' ? 'real_orders' : 'virtual_orders'
  const excluded = market === 'real' ? `('cancelled','failed')` : `('cancelled')`
  const now = Date.now()
  const dayStart = new Date(now - TRADE_POLICY.DAILY.WINDOW_MS)
  const cutoff = new Date(now - TRADE_POLICY.BASELINE.WINDOW_DAYS * 24 * 60 * 60 * 1000)

  const [daily, recent] = await Promise.all([
    sequelize.query<{ total: string | number }>(
      `SELECT SUM(total_amount) AS total
         FROM ${table}
        WHERE user_id = :userId
          AND status NOT IN ${excluded}
          AND ordered_at >= :cutoff AND ordered_at < :dayStart
        GROUP BY DATE(ordered_at)
        ORDER BY DATE(ordered_at) ASC`,
      { replacements: { userId, cutoff, dayStart }, type: QueryTypes.SELECT },
    ),
    sequelize.query<{ total: string | number | null }>(
      `SELECT COALESCE(SUM(total_amount), 0) AS total
         FROM ${table}
        WHERE user_id = :userId
          AND status NOT IN ${excluded}
          AND ordered_at >= :dayStart`,
      { replacements: { userId, dayStart }, type: QueryTypes.SELECT },
    ),
  ])

  return {
    dailyTotals: daily
      .map((r) => Number(r.total))
      .filter((v) => Number.isFinite(v) && v > 0),
    recentTotal: Number(recent[0]?.total ?? 0) || 0,
  }
}

// ─────────────────────────────────────────────
// 서비스 진입점 — 컨트롤러가 주문 실행 직전에 호출한다
//
// 가용성 원칙: 무결성(S0) 판정은 로컬 계산이라 항상 수행한다.
// 통계 표본 적재가 실패하면(DB 장애 등) 통계 신호는 포기하고 비율 규칙만 적용한다.
// 탐지 실패로 정상 거래를 막지 않되, 무결성 위반은 어떤 경우에도 통과시키지 않는다.
// ─────────────────────────────────────────────
export interface TradeRequestContext {
  userId: number
  email?: string
  ip: string
  userAgent?: string
  market: Market
  side: 'buy' | 'sell'
  stockCode: string
  quantity: number
  price: number
  portfolioValue?: number | null
  hasSignature: boolean
  // 지갑 서명 재인증 경로가 있는 시장인지. 모의투자는 있고(true), 실계좌는
  // 서명 채널이 없어 false — 이 경우 STEP_UP 은 경보·기록으로만 남긴다.
  stepUpAvailable?: boolean
}

export async function evaluateTradeRequest(ctx: TradeRequestContext): Promise<TradeAssessment> {
  let history: number[] = []
  let dailyTotals: number[] = []
  let recentTotal = 0
  let riskContext: { minutesSinceCredentialChange: number | null; daysSinceLastActivity: number | null } =
    { minutesSinceCredentialChange: null, daysSinceLastActivity: null }

  // 무결성 위반은 표본 조회 없이 즉시 판정한다 — 잘못된 주문으로 DB 를 두드리지 않는다.
  const integrity = validateOrderIntegrity(ctx.quantity, ctx.price)
  if (integrity.ok) {
    try {
      const [h, d, rc] = await Promise.all([
        loadTradeHistory(ctx.userId, ctx.market),
        loadDailyTotals(ctx.userId, ctx.market),
        loadRiskContext(ctx.userId, ctx.market),
      ])
      history = h
      dailyTotals = d.dailyTotals
      recentTotal = d.recentTotal
      riskContext = rc
    } catch (err) {
      console.error('[TradeAnomaly] 베이스라인 조회 실패 — 비율 규칙만 적용:', err)
    }
  }

  const assessment = assessTrade({
    quantity: ctx.quantity,
    price: ctx.price,
    portfolioValue: ctx.portfolioValue,
    history,
    dailyTotals,
    recentTotal,
    minutesSinceCredentialChange: riskContext.minutesSinceCredentialChange,
    daysSinceLastActivity: riskContext.daysSinceLastActivity,
  })

  if (assessment.verdict !== 'ALLOW') {
    const marketLabel = ctx.market === 'real' ? '실거래' : '모의투자'
    const sideLabel = ctx.side === 'buy' ? '매수' : '매도'
    const stepUpAvailable = ctx.stepUpAvailable ?? true

    // 조치는 요청에 실제로 무슨 일이 벌어졌는지를 그대로 기록한다.
    //  - 무결성 위반: 거절(BLOCK)
    //  - 재인증 요구 후 서명 미동봉: 요청 거절(BLOCK)
    //  - 서명으로 소유자 확인됨 / 재인증 경로가 없는 시장: 경보(ALERT)
    let action: 'ALERT' | 'BLOCK' = 'ALERT'
    let outcome = '탐지 기록(추가 인증 경로 없음)'
    if (assessment.verdict === 'BLOCK') {
      action = 'BLOCK'
      outcome = '주문 거절'
    } else if (ctx.hasSignature) {
      outcome = '지갑 서명 확인 후 진행'
    } else if (stepUpAvailable) {
      action = 'BLOCK'
      outcome = '지갑 서명 재인증 요구(원 요청 거절)'
    }

    await recordTradeAnomaly({
      userId: ctx.userId,
      email: ctx.email,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      action,
      notify: !ctx.hasSignature,
      detail: `[${marketLabel} ${sideLabel} ${ctx.stockCode}] ${assessment.detail} → ${outcome}`,
      userMessage: assessment.userMessage,
      types: assessment.signals,
    })
  }

  return assessment
}
