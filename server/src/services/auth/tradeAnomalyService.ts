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
  // M-6 — 거래 "빈도" 급증. 금액 규칙(S1~S4)이 전부 통과하는 회피 경로를 덮는다.
  //
  // 금액 기준만 있으면 공격자는 평소 금액대로 잘게 쪼개 여러 번 주문해 전량을 빼낼 수
  // 있다. S2(24시간 누적)가 총액은 보지만, 누적액이 평소 수준인데 건수만 폭증하는
  // 자동화(봇) 패턴은 잡히지 않는다. 그래서 건수 자체를 별도 표본으로 본다.
  //
  // 판정은 금액과 동일한 강건 z(statsEngine)를 건수에 그대로 재사용한다 — 새 통계
  // 로직을 만들지 않아 임계의 의미가 금액 규칙과 같게 유지된다.
  FREQUENCY: {
    MIN_DAYS: 5,     // 일별 건수 베이스라인 최소 표본 일수
    Z: 3.5,          // 강건 z 임계 — 금액 규칙과 같은 관례값
    // 건수는 작은 정수라 1→4 같은 변화도 z 가 쉽게 튄다. 절대 하한을 함께 요구해
    // "평소 1건인데 오늘 3건" 수준을 급증으로 부르지 않는다.
    MIN_COUNT: 5,
  },
  // M-8 — 반올림 금액 반복. 자동화(봇) 주문의 흔적을 본다.
  //
  // 사람이 "100만원어치 사자" 하는 것은 아주 흔하므로 **단발 반올림은 신호가 아니다.**
  // 신호가 되는 것은 반복이다 — 총액이 정확히 UNIT 의 배수로 떨어지려면 단가와 수량이
  // 맞아떨어져야 해서 자연 발생 확률이 낮은데, 금액을 지정해 주문하는 자동화는
  // 구조적으로 이 값만 만들어낸다.
  //
  // 현재 주문 자체가 반올림일 때만 평가한다. 그러지 않으면 과거 이력만으로 매 주문마다
  // 계속 신호가 서서 기록이 무의미해진다.
  ROUND: {
    UNIT: 1_000_000,   // 이 단위의 배수를 '반올림 금액'으로 본다
    WINDOW: 20,        // 최근 몇 건을 보는가(현재 주문 포함)
    MIN_SAMPLES: 10,   // 창 표본이 이보다 적으면 판정 보류
    RATIO: 0.4,        // 창 안 반올림 비율 임계
    // ★ 시간 밀도 조건 — 오탐의 유일한 실효 대책
    //
    // 비율 조건만 두면 "매달 100만원씩 정액 매수" 하는 적립식 투자자가 봇과
    // 완전히 같은 모양이 된다(실측 오탐 93.7%). 금액 축에서는 원리적으로 구별되지
    // 않으므로 **시간 축**을 추가한다 — 적립식은 월 1회, 자동화는 하루에 여러 번이다.
    // 반올림 주문이 짧은 시간에 몰려 있을 때만 신호로 본다.
    BURST_WINDOW_MS: 24 * 60 * 60 * 1000,
    BURST_MIN: 3,      // 이 창 안에 반올림 주문이 이만큼 있어야 한다(현재 주문 포함)
  },
  // M-7 — 동일 IP 다계정 동일 종목 거래.
  //
  // 계획서 원안은 "같은 IP 3계정 이상이 같은 종목을 거래하면 플래그" 였는데, 그대로
  // 구현하면 오탐이 구조적으로 심하다 — 가족 공유기, 학교·회사·PC방 NAT, 모바일 캐리어
  // NAT 뒤에서는 남남인 3명이 같은 인기 종목을 사는 일이 흔하다. 계정 수만으로는
  // "같은 강의실" 과 "한 사람이 굴리는 다계정" 이 구별되지 않는다.
  //
  // 그래서 계정 수를 **필요조건**으로만 두고, 자동화·자전거래를 가르는 보조 신호를
  // 함께 요구한다.
  //   · 금액 유사도 — 사람 여럿은 금액이 제각각이고, 한 사람이 굴리는 다계정은 비슷하다
  //   · 방향 상반   — 자전거래는 한쪽이 사고 다른 쪽이 판다. 이 형태면 금액 조건을 완화
  MULTI_ACCOUNT: {
    WINDOW_MIN: 10,            // 같은 IP·같은 종목 주문을 하나로 묶는 시간 창
    MIN_ACCOUNTS: 3,           // 계정 수 임계 (계획서 원안)
    AMOUNT_CV: 0.15,           // 계정별 금액의 변동계수가 이 이하면 '유사'
    AMOUNT_CV_OPPOSING: 0.35,  // 매수·매도가 맞물리면 완화 (자전거래 형태)
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
  | 'TRADE_FREQUENCY_SPIKE'    // M-6 평소 대비 거래 건수 급증 (관측 신호)
  | 'ROUND_AMOUNT_PATTERN'     // M-8 반올림 금액 반복 — 자동화 흔적 (관측 신호)
  | 'MULTI_ACCOUNT_SAME_IP'    // M-7 동일 IP 다계정 동일 종목 거래 (관측 신호)

export type TradeVerdict = 'ALLOW' | 'STEP_UP' | 'BLOCK'

/**
 * 관측 신호 — 기록만 하고 판정(verdict)은 바꾸지 않는 신호.
 *
 * 왜 등급을 나누는가: 기존 조립은 "신호가 하나라도 서면 예외 없이 STEP_UP" 이었다.
 * 그 구조에 빈도·패턴 계열 신호를 그대로 넣으면 정상 사용자가 재인증을 요구받는다.
 * 예컨대 하루 날 잡고 리밸런싱하면 건수는 당연히 튀는데, 금액은 평소와 같다.
 * 이런 신호는 단독으로 차단 근거가 되기엔 오탐 비용이 크고, 대신 관리자 판단과
 * 봇 탐지(A 항목)의 입력으로서 가치가 있다.
 *
 * 다만 관측 신호가 무의미해지는 것은 아니다 — 차단 신호가 하나라도 함께 서면
 * 아래 조립에서 자연히 STEP_UP 이 되고, 그 근거에 관측 신호도 같이 기록된다.
 * 즉 "빈도만 튐 → 통과+기록", "빈도 튐 + 고액 → 재인증" 으로 갈린다.
 */
const OBSERVATIONAL_SIGNALS: ReadonlySet<TradeSignal> = new Set<TradeSignal>([
  'TRADE_FREQUENCY_SPIKE',
  'ROUND_AMOUNT_PATTERN',
  'MULTI_ACCOUNT_SAME_IP',
])

/** 해당 신호가 관측 전용(판정 불변)인지 — 대시보드·검증 스크립트가 함께 참조한다. */
export function isObservationalSignal(signal: TradeSignal): boolean {
  return OBSERVATIONAL_SIGNALS.has(signal)
}

export interface TradeAssessment {
  verdict: TradeVerdict
  signals: TradeSignal[]
  sanityReason: SanityReason | null
  amountZ: number | null      // 표본 부족 시 null
  dailyZ: number | null
  freqZ: number | null        // M-6 일별 거래 건수 z (표본 부족 시 null)
  roundRatio: number | null   // M-8 최근 창에서 반올림 금액이 차지하는 비율
  sameIpAccounts: number | null   // M-7 같은 IP·같은 종목을 거래한 계정 수(현재 사용자 포함)
  ratio: number | null        // 포트폴리오 대비 비율
  trend: number | null        // 베이스라인 상승 배수
  trendZ: number | null       // 단조 상승 검정(Mann-Kendall) z
  baseline: Baseline
  detail: string              // anomaly_logs·관리자용
  userMessage: string         // 사용자 응답·이메일용
}

/**
 * 같은 IP·같은 종목으로 들어온 최근 주문 한 건.
 * 크로스 계정 조회는 로더(loadSameIpOrders)가 담당하고, 판정 함수는 순수하게 유지한다.
 */
export interface SameIpOrder {
  userId: number
  side: 'buy' | 'sell'
  amount: number
}

export interface TradeInput {
  quantity: number
  price: number
  portfolioValue?: number | null   // 실계좌처럼 평가액을 못 구하면 생략 → 비율 규칙 미적용
  history: readonly number[]       // 과거 단건 거래금액(시간 오름차순)
  dailyTotals: readonly number[]   // 과거 일별 거래총액(오늘 제외, 시간 오름차순)
  recentTotal?: number             // 최근 24시간 누적 거래금액(현재 주문 제외)
  // M-6 — 값이 없으면 빈도 규칙은 평가하지 않는다(기존 호출부 하위호환).
  dailyCounts?: readonly number[]  // 과거 일별 거래 건수(오늘 제외, 시간 오름차순)
  recentCount?: number             // 최근 24시간 거래 건수(현재 주문 제외)
  // M-8 — history 와 같은 순서·길이의 주문 시각(epoch ms). 없으면 시간 조건은 생략된다.
  historyAt?: readonly number[]
  // M-7 — 같은 IP·같은 종목의 최근 주문(현재 주문 제외). 값이 없으면 미평가.
  sameIpOrders?: readonly SameIpOrder[]
  side?: 'buy' | 'sell'            // 현재 주문의 방향 — 방향 상반 판정에 쓴다
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
      freqZ: null,
      roundRatio: null,
      sameIpAccounts: null,
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

  // S7. 거래 빈도 급증 (M-6) — 금액이 아니라 "건수"의 이탈
  //
  //   금액 규칙(S1~S4)은 한 번에 크게 빼가는 공격을 본다. 반대로 평소 금액대로
  //   잘게 쪼개 여러 번 주문하면 단건 z 도, 24시간 누적액도 평소 범위에 머문다.
  //   그 경로를 덮기 위해 "오늘 몇 건인가"를 별도 표본으로 판정한다.
  //
  //   관측 신호다 — 단독으로는 판정을 바꾸지 않는다(OBSERVATIONAL_SIGNALS 주석 참조).
  //   건수 급증은 정상 사용자에게도 흔하기 때문이다(리밸런싱, 장 급변일).
  const freqBaseline = summarize(input.dailyCounts ?? [])
  let freqZ: number | null = null
  const todayCount = (input.recentCount ?? 0) + 1   // 현재 주문 포함
  if (
    freqBaseline.n >= TRADE_POLICY.FREQUENCY.MIN_DAYS &&
    todayCount >= TRADE_POLICY.FREQUENCY.MIN_COUNT
  ) {
    freqZ = robustScore(todayCount, freqBaseline)
    if (freqZ >= TRADE_POLICY.FREQUENCY.Z) {
      signals.push('TRADE_FREQUENCY_SPIKE')
      const multiple = todayCount / (freqBaseline.median || 1)
      reasons.push(
        `거래 빈도 급증 z=${freqZ.toFixed(2)}(임계 ${TRADE_POLICY.FREQUENCY.Z}) — ` +
        `24시간 ${todayCount}건, 평소 일간 중앙값 ${freqBaseline.median}건의 ${multiple.toFixed(1)}배, ` +
        `표본 ${freqBaseline.n}일`,
      )
      // userReasons 에는 넣지 않는다 — 관측 신호는 사용자에게 노출하지 않는다.
      // (탐지 기준을 알려주면 건수를 임계 아래로 맞추는 회피가 쉬워진다)
    }
  }

  // S8. 반올림 금액 반복 (M-8) — 자동화 흔적
  //
  //   추가 쿼리·컬럼 없이 input.history 만으로 판정하는 순수 산술 규칙이다.
  //   관측 신호다 — 사람도 "100만원어치" 를 자주 쓰므로 단독 차단 근거가 될 수 없다.
  const isRound = (v: number): boolean =>
    Number.isFinite(v) && v > 0 && v % TRADE_POLICY.ROUND.UNIT === 0

  let roundRatio: number | null = null
  if (isRound(amount)) {
    // 현재 주문을 포함해 최근 WINDOW 건을 본다.
    const recent = [...input.history.slice(-(TRADE_POLICY.ROUND.WINDOW - 1)), amount]
    if (recent.length >= TRADE_POLICY.ROUND.MIN_SAMPLES) {
      const rounds = recent.filter(isRound)
      roundRatio = rounds.length / recent.length

      // 시간 밀도 — 반올림 주문이 최근 창 안에 몇 건 몰려 있는가(현재 주문 포함).
      // historyAt 이 없으면(하위호환) 이 조건은 생략한다.
      let burst: number | null = null
      if (input.historyAt != null && input.historyAt.length === input.history.length) {
        const since = Date.now() - TRADE_POLICY.ROUND.BURST_WINDOW_MS
        let n = 1 // 현재 주문
        for (let i = 0; i < input.history.length; i++) {
          if (isRound(input.history[i]) && (input.historyAt[i] ?? 0) >= since) n++
        }
        burst = n
      }

      const burstOk = burst == null || burst >= TRADE_POLICY.ROUND.BURST_MIN
      if (roundRatio >= TRADE_POLICY.ROUND.RATIO && burstOk) {
        signals.push('ROUND_AMOUNT_PATTERN')
        const distinct = new Set(rounds).size
        reasons.push(
          `반올림 금액 반복 ${pct(roundRatio)}(임계 ${pct(TRADE_POLICY.ROUND.RATIO)}) — ` +
          `최근 ${recent.length}건 중 ${rounds.length}건이 ` +
          `${won(TRADE_POLICY.ROUND.UNIT)} 배수, 서로 다른 금액 ${distinct}종` +
          (burst != null
            ? `, 최근 24시간 집중 ${burst}건(임계 ${TRADE_POLICY.ROUND.BURST_MIN})`
            : ''),
        )
        // userReasons 미추가 — 관측 신호는 사용자에게 노출하지 않는다.
      }
    }
  }

  // S9. 동일 IP 다계정 동일 종목 거래 (M-7) — 자동화·자전거래 흔적
  //
  //   계정 수는 필요조건일 뿐이다(NAT 오탐). 실제 판정은 보조 신호가 가른다.
  //   관측 신호 — 남남인 3명이 같은 종목을 사는 일은 정당하게 일어난다.
  let sameIpAccounts: number | null = null
  if (input.sameIpOrders != null) {
    // 계정별 합계로 접는다 — 한 계정이 여러 번 주문해도 한 표로 센다.
    const byAccount = new Map<number, { amount: number; sides: Set<'buy' | 'sell'> }>()
    const push = (userId: number, side: 'buy' | 'sell', amount: number): void => {
      const cur = byAccount.get(userId) ?? { amount: 0, sides: new Set<'buy' | 'sell'>() }
      cur.amount += amount
      cur.sides.add(side)
      byAccount.set(userId, cur)
    }
    for (const o of input.sameIpOrders) {
      if (Number.isFinite(o.amount) && o.amount > 0) push(o.userId, o.side, o.amount)
    }
    // 현재 주문도 한 표로 포함한다 — 아직 DB 에 없다.
    if (input.side) push(-1, input.side, amount)

    sameIpAccounts = byAccount.size
    if (sameIpAccounts >= TRADE_POLICY.MULTI_ACCOUNT.MIN_ACCOUNTS) {
      const amounts = [...byAccount.values()].map((v) => v.amount)
      const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length
      const sd = Math.sqrt(
        amounts.reduce((acc, v) => acc + (v - mean) ** 2, 0) / amounts.length,
      )
      const cv = mean > 0 ? sd / mean : 0

      // 방향 상반 — 매수 계정과 매도 계정이 모두 존재(자전거래 형태)
      const buyers = [...byAccount.values()].filter((v) => v.sides.has('buy')).length
      const sellers = [...byAccount.values()].filter((v) => v.sides.has('sell')).length
      const opposing = buyers > 0 && sellers > 0

      const cvLimit = opposing
        ? TRADE_POLICY.MULTI_ACCOUNT.AMOUNT_CV_OPPOSING
        : TRADE_POLICY.MULTI_ACCOUNT.AMOUNT_CV

      if (cv <= cvLimit) {
        signals.push('MULTI_ACCOUNT_SAME_IP')
        reasons.push(
          `동일 IP 다계정 동일 종목 거래 — ${TRADE_POLICY.MULTI_ACCOUNT.WINDOW_MIN}분 내 ` +
          `${sameIpAccounts}계정(임계 ${TRADE_POLICY.MULTI_ACCOUNT.MIN_ACCOUNTS}), ` +
          `금액 변동계수 ${cv.toFixed(3)}(임계 ${cvLimit})` +
          (opposing ? `, 매수 ${buyers}·매도 ${sellers} 맞물림(자전거래 형태)` : ''),
        )
        // 개인정보 최소화 — 다른 사용자의 식별자는 기록하지 않고 집계값만 남긴다.
      }
    }
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

  // ── 판정 조립 ─────────────────────────────────────────────
  //
  // 차단 신호가 하나라도 있으면 STEP_UP. 관측 신호만 선 경우는 판정을 바꾸지 않되
  // 기록은 남긴다 — 나중에 봇 탐지(A)가 이 이력을 신뢰도 입력으로 쓴다.
  const gating = signals.filter((sig) => !OBSERVATIONAL_SIGNALS.has(sig))

  const common = {
    signals,
    sanityReason: null,
    amountZ,
    dailyZ,
    freqZ,
    roundRatio,
    sameIpAccounts,
    ratio,
    trend,
    trendZ,
    baseline,
  } as const

  if (signals.length === 0) {
    return { ...common, verdict: 'ALLOW', detail: '', userMessage: '' }
  }

  if (gating.length === 0) {
    // 관측 전용 — 주문은 그대로 진행시키고 사용자에게도 알리지 않는다.
    return {
      ...common,
      verdict: 'ALLOW',
      detail: `거래 관측 신호 [${signals.join(', ')}] ${reasons.join(' / ')}`,
      userMessage: '',
    }
  }

  return {
    ...common,
    verdict: 'STEP_UP',
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

export async function loadTradeHistory(
  userId: number,
  market: Market,
): Promise<{ amounts: number[]; times: number[] }> {
  const cutoff = new Date(Date.now() - TRADE_POLICY.BASELINE.WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const model: any = market === 'real' ? RealOrder : VirtualOrder
  const excluded = market === 'real' ? ['cancelled', 'failed'] : ['cancelled']

  const rows = await model.findAll({
    where: {
      user_id: userId,
      ordered_at: { [Op.gte]: cutoff },
      status: { [Op.notIn]: excluded },
    },
    // M-8 은 "언제" 를 봐야 한다 — 금액만으로는 적립식 매수와 자동화가 구별되지 않는다.
    attributes: ['total_amount', 'ordered_at'],
    order: [['ordered_at', 'DESC']],
    limit: TRADE_POLICY.BASELINE.MAX_SAMPLES,
    raw: true,
  })

  const kept = rows
    .map((r: { total_amount: unknown; ordered_at: unknown }) => ({
      amount: Number(r.total_amount),
      at: new Date(r.ordered_at as string).getTime(),
    }))
    .filter((v: { amount: number; at: number }) => Number.isFinite(v.amount) && v.amount > 0)
    .reverse()

  return {
    amounts: kept.map((v: { amount: number; at: number }) => v.amount),
    times: kept.map((v: { amount: number; at: number }) => (Number.isFinite(v.at) ? v.at : 0)),
  }
}

/**
 * 일별 거래총액 베이스라인(최근 24시간 제외) + 최근 24시간 누적액.
 * 하루 안에 여러 건으로 쪼개는 분할 주문을 누적 관점으로 잡기 위한 표본이다.
 */
export async function loadDailyTotals(
  userId: number,
  market: Market,
): Promise<{
  dailyTotals: number[]
  recentTotal: number
  dailyCounts: number[]
  recentCount: number
}> {
  const table = market === 'real' ? 'real_orders' : 'virtual_orders'
  const excluded = market === 'real' ? `('cancelled','failed')` : `('cancelled')`
  const now = Date.now()
  const dayStart = new Date(now - TRADE_POLICY.DAILY.WINDOW_MS)
  const cutoff = new Date(now - TRADE_POLICY.BASELINE.WINDOW_DAYS * 24 * 60 * 60 * 1000)

  const [daily, recent] = await Promise.all([
    sequelize.query<{ total: string | number; cnt: string | number }>(
      `SELECT SUM(total_amount) AS total, COUNT(*) AS cnt
         FROM ${table}
        WHERE user_id = :userId
          AND status NOT IN ${excluded}
          AND ordered_at >= :cutoff AND ordered_at < :dayStart
        GROUP BY DATE(ordered_at)
        ORDER BY DATE(ordered_at) ASC`,
      { replacements: { userId, cutoff, dayStart }, type: QueryTypes.SELECT },
    ),
    sequelize.query<{ total: string | number | null; cnt: string | number }>(
      `SELECT COALESCE(SUM(total_amount), 0) AS total, COUNT(*) AS cnt
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
    // 건수는 금액과 독립 표본이다 — 금액이 0 인 행이 걸러져도 건수는 그대로 센다.
    dailyCounts: daily
      .map((r) => Number(r.cnt))
      .filter((v) => Number.isFinite(v) && v > 0),
    recentCount: Number(recent[0]?.cnt ?? 0) || 0,
  }
}

/**
 * 같은 IP·같은 종목으로 들어온 최근 주문 (M-7).
 *
 * 지금까지 모든 탐지는 `WHERE user_id = ?` 로 자기 데이터만 봤지만 이 규칙만은
 * **다른 계정**을 본다. 인덱스 `(ip_address, ordered_at)` 로 IP 축을 먼저 좁힌 뒤
 * 종목으로 거른다. 반환에는 집계에 필요한 최소 필드만 담는다.
 */
export async function loadSameIpOrders(
  market: Market,
  ip: string,
  stockCode: string,
): Promise<SameIpOrder[]> {
  if (!ip || !stockCode) return []
  const table = market === 'real' ? 'real_orders' : 'virtual_orders'
  const excluded = market === 'real' ? `('cancelled','failed')` : `('cancelled')`
  const windowStart = new Date(Date.now() - TRADE_POLICY.MULTI_ACCOUNT.WINDOW_MIN * 60_000)

  const rows = await sequelize.query<{ user_id: number; side: 'buy' | 'sell'; total_amount: string | number }>(
    `SELECT o.user_id, o.side, o.total_amount
       FROM ${table} o
       JOIN stocks s ON s.id = o.stock_id
      WHERE o.ip_address = :ip
        AND s.code = :stockCode
        AND o.ordered_at >= :windowStart
        AND o.status NOT IN ${excluded}`,
    { replacements: { ip, stockCode, windowStart }, type: QueryTypes.SELECT },
  )

  return rows.map((r) => ({
    userId: Number(r.user_id),
    side: r.side,
    amount: Number(r.total_amount),
  }))
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
  let historyAt: number[] = []
  let dailyTotals: number[] = []
  let recentTotal = 0
  let dailyCounts: number[] = []
  let recentCount = 0
  let sameIpOrders: SameIpOrder[] = []
  let riskContext: { minutesSinceCredentialChange: number | null; daysSinceLastActivity: number | null } =
    { minutesSinceCredentialChange: null, daysSinceLastActivity: null }

  // 무결성 위반은 표본 조회 없이 즉시 판정한다 — 잘못된 주문으로 DB 를 두드리지 않는다.
  const integrity = validateOrderIntegrity(ctx.quantity, ctx.price)
  if (integrity.ok) {
    try {
      const [h, d, rc, si] = await Promise.all([
        loadTradeHistory(ctx.userId, ctx.market),
        loadDailyTotals(ctx.userId, ctx.market),
        loadRiskContext(ctx.userId, ctx.market),
        // M-7 은 실패해도 나머지 판정을 막지 않는다 — 크로스 계정 조회는 부가 신호다.
        loadSameIpOrders(ctx.market, ctx.ip, ctx.stockCode).catch(() => [] as SameIpOrder[]),
      ])
      history = h.amounts
      historyAt = h.times
      dailyTotals = d.dailyTotals
      recentTotal = d.recentTotal
      dailyCounts = d.dailyCounts
      recentCount = d.recentCount
      sameIpOrders = si
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
    dailyCounts,
    recentCount,
    historyAt,
    sameIpOrders,
    side: ctx.side,
    minutesSinceCredentialChange: riskContext.minutesSinceCredentialChange,
    daysSinceLastActivity: riskContext.daysSinceLastActivity,
  })

  // 관측 전용 신호만 선 경우에도 기록은 남긴다 — 판정을 바꾸지 않을 뿐 이력은 자산이다.
  if (assessment.signals.length > 0) {
    const marketLabel = ctx.market === 'real' ? '실거래' : '모의투자'
    const sideLabel = ctx.side === 'buy' ? '매수' : '매도'
    const stepUpAvailable = ctx.stepUpAvailable ?? true

    // 조치는 요청에 실제로 무슨 일이 벌어졌는지를 그대로 기록한다.
    //  - 무결성 위반: 거절(BLOCK)
    //  - 재인증 요구 후 서명 미동봉: 요청 거절(BLOCK)
    //  - 서명으로 소유자 확인됨 / 재인증 경로가 없는 시장: 경보(ALERT)
    //  - 관측 신호만 선 경우: 주문 진행, 기록만(ALERT)
    const observationalOnly = assessment.verdict === 'ALLOW'

    let action: 'ALERT' | 'BLOCK' = 'ALERT'
    let outcome = '탐지 기록(추가 인증 경로 없음)'
    if (observationalOnly) {
      outcome = '관측 기록(판정 불변, 주문 진행)'
    } else if (assessment.verdict === 'BLOCK') {
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
      // 관측 신호는 사용자에게 알리지 않는다 — 오탐 비중이 높아 알림 피로만 늘고,
      // 탐지 사실을 알려주면 임계 아래로 맞추는 회피가 쉬워진다.
      notify: !observationalOnly && !ctx.hasSignature,
      detail: `[${marketLabel} ${sideLabel} ${ctx.stockCode}] ${assessment.detail} → ${outcome}`,
      userMessage: assessment.userMessage,
      types: assessment.signals,
    })
  }

  return assessment
}
