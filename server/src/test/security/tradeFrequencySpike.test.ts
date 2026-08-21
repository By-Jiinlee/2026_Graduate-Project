import {
  TRADE_POLICY,
  assessTrade,
  isObservationalSignal,
  type TradeAssessment,
} from '../../services/auth/tradeAnomalyService'
import { summarize, robustScore } from '../../services/auth/statsEngine'

// ─────────────────────────────────────────────────────────────
// [보안 검증] M-6 거래 빈도 급증 + 신호 등급 분리
//
// 두 가지를 검증한다.
//   1) M-6 이 "금액 규칙이 전부 통과하는 회피 경로"를 실제로 덮는가
//      → 총액을 평소 수준으로 유지한 채 건수만 늘리는 자동화 패턴
//   2) 등급 분리가 동작하는가
//      → 빈도만 급증하면 판정 불변(ALLOW)이고 기록만 남는다
//      → 금액 신호가 함께 서면 STEP_UP 으로 승격된다
//
// DB·서버 없이 정책 함수를 직접 호출하는 결정적 검증이다.
// 실행: cd server && npx ts-node src/test/security/tradeFrequencySpike.test.ts
// ─────────────────────────────────────────────────────────────

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass++
  else {
    fail++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  }
}

let seed = 20260820
const rand = (): number => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}

// ── 정상 사용자 프로필 ────────────────────────────────────────
// 하루 2~4건, 건당 10만원 안팎. 30일치 표본.
const NORMAL_DAILY_COUNTS = Array.from({ length: 30 }, () => 2 + Math.floor(rand() * 3))
const UNIT = 100_000
const NORMAL_HISTORY = Array.from({ length: 60 }, () =>
  Math.round((UNIT * Math.exp((rand() - 0.5) * 0.6)) / 1000) * 1000,
)
const NORMAL_DAILY_TOTALS = NORMAL_DAILY_COUNTS.map((c) => c * UNIT)

const order = (amount: number) => ({ quantity: 10, price: amount / 10 })

function evaluate(opts: {
  amount?: number
  recentCount?: number
  recentTotal?: number
  dailyCounts?: readonly number[]
  portfolioValue?: number | null
}): TradeAssessment {
  return assessTrade({
    ...order(opts.amount ?? UNIT),
    history: NORMAL_HISTORY,
    dailyTotals: NORMAL_DAILY_TOTALS,
    recentTotal: opts.recentTotal ?? 0,
    dailyCounts: opts.dailyCounts ?? NORMAL_DAILY_COUNTS,
    recentCount: opts.recentCount ?? 0,
    portfolioValue: opts.portfolioValue ?? null,
  })
}

const has = (a: TradeAssessment): boolean => a.signals.includes('TRADE_FREQUENCY_SPIKE')

const countBaseline = summarize(NORMAL_DAILY_COUNTS)
const medianCount = countBaseline.median

console.log('\n[보안 테스트] M-6 거래 빈도 급증 + 신호 등급 분리')
console.log(
  `\n표본 프로필: 일별 건수 중앙값 ${medianCount}건 (표본 ${countBaseline.n}일), ` +
    `건당 약 ${UNIT.toLocaleString('ko-KR')}원`,
)

// ── 1) 탐지 하한 탐색 — 몇 건부터 걸리는가 ──────────────────────
let firstDetected = -1
for (let c = TRADE_POLICY.FREQUENCY.MIN_COUNT; c <= 80; c++) {
  if (has(evaluate({ recentCount: c - 1 }))) {
    firstDetected = c
    break
  }
}
check('탐지 하한이 존재한다', firstDetected > 0, `firstDetected=${firstDetected}`)
check(
  '탐지 하한이 중앙값보다 충분히 크다',
  firstDetected >= medianCount * 4,
  `${firstDetected}건 vs 중앙값 ${medianCount}건`,
)

// ── 2) 정상 범위 오탐 — 1건 ~ 하한 직전까지 전부 미탐 ───────────
let normalTried = 0
let normalFalse = 0
for (let c = 1; c < firstDetected; c++) {
  normalTried++
  if (has(evaluate({ recentCount: c - 1 }))) normalFalse++
}
check('탐지 하한 미만 구간 오탐 0', normalFalse === 0, `${normalFalse}/${normalTried}`)

// ── 3) ★ 핵심: 금액 규칙을 전부 통과하는 회피 경로를 덮는가 ──────
//     총액을 평소 수준으로 유지한 채 건수만 늘린다(건당 금액을 1/10 로 쪼갬).
const SPLIT_UNIT = UNIT / 10
const SPLIT_COUNT = 30
const splitTotal = SPLIT_UNIT * SPLIT_COUNT // ≈ 평소 일간 총액 수준
const evasion = assessTrade({
  ...order(SPLIT_UNIT),
  history: NORMAL_HISTORY,
  dailyTotals: NORMAL_DAILY_TOTALS,
  recentTotal: splitTotal - SPLIT_UNIT,
  dailyCounts: NORMAL_DAILY_COUNTS,
  recentCount: SPLIT_COUNT - 1,
  portfolioValue: null,
})
check('회피 시나리오: 단건 금액 규칙 미탐(설계상 통과)', !evasion.signals.includes('AMOUNT_ZSCORE'))
check('회피 시나리오: 24시간 누적 금액 규칙 미탐(설계상 통과)', !evasion.signals.includes('DAILY_ZSCORE'))
check('회피 시나리오: M-6 이 탐지', has(evasion), evasion.signals.join(','))

// ── 4) 등급 분리 — 빈도만 급증하면 판정 불변 ────────────────────
const freqOnly = evaluate({ recentCount: SPLIT_COUNT - 1 })
check('빈도 단독: 신호 기록됨', has(freqOnly))
check('빈도 단독: verdict 불변(ALLOW)', freqOnly.verdict === 'ALLOW', freqOnly.verdict)
check('빈도 단독: 관측 기록 detail 생성', freqOnly.detail.includes('거래 관측 신호'), freqOnly.detail)
check('빈도 단독: 사용자 메시지 없음', freqOnly.userMessage === '')
check('TRADE_FREQUENCY_SPIKE 가 관측 신호로 분류됨', isObservationalSignal('TRADE_FREQUENCY_SPIKE'))
check('금액 신호는 차단 신호로 분류됨', !isObservationalSignal('AMOUNT_ZSCORE'))

// ── 5) 결합 — 빈도 급증 + 고액이면 STEP_UP 으로 승격 ────────────
const combined = evaluate({
  amount: UNIT * 30, // 단건 고액 → AMOUNT_ZSCORE (차단 신호)
  recentCount: SPLIT_COUNT - 1,
})
check(
  '결합: 두 신호 모두 기록',
  has(combined) && combined.signals.includes('AMOUNT_ZSCORE'),
  combined.signals.join(','),
)
check('결합: verdict 승격(STEP_UP)', combined.verdict === 'STEP_UP', combined.verdict)
check(
  '결합: 사용자 메시지에 빈도 근거 미노출',
  !combined.userMessage.includes('건'),
  combined.userMessage,
)

// ── 6) 콜드 스타트 — 표본 부족 시 판정 보류 ─────────────────────
const cold = assessTrade({
  ...order(UNIT),
  history: NORMAL_HISTORY,
  dailyTotals: NORMAL_DAILY_TOTALS,
  recentTotal: 0,
  dailyCounts: [3, 3, 2], // MIN_DAYS(5) 미만
  recentCount: 99,
  portfolioValue: null,
})
check('콜드 스타트: 표본 부족 시 미탐', !has(cold))
check('콜드 스타트: freqZ 판정 보류(null)', cold.freqZ === null, String(cold.freqZ))

// ── 7) 절대 하한 — 건수가 작으면 z 가 튀어도 탐지하지 않는다 ────
const rareUser = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
const rareBelow = assessTrade({
  ...order(UNIT),
  history: NORMAL_HISTORY,
  dailyTotals: NORMAL_DAILY_TOTALS,
  recentTotal: 0,
  dailyCounts: rareUser,
  recentCount: TRADE_POLICY.FREQUENCY.MIN_COUNT - 2, // 오늘 건수 = MIN_COUNT-1
  portfolioValue: null,
})
check('절대 하한: MIN_COUNT 미만은 미탐', !has(rareBelow))

// ── 8) 하위호환 — dailyCounts 미전달 시 규칙 자체가 비활성 ───────
const legacy = assessTrade({
  ...order(UNIT),
  history: NORMAL_HISTORY,
  dailyTotals: NORMAL_DAILY_TOTALS,
  recentTotal: 0,
  portfolioValue: null,
})
check('하위호환: dailyCounts 없으면 미평가', !has(legacy) && legacy.freqZ === null)

// ── 대조군 수치 ────────────────────────────────────────────────
const detectedZ = evaluate({ recentCount: SPLIT_COUNT - 1 }).freqZ ?? 0
const normalZ = robustScore(medianCount, countBaseline)

// ── 요약 출력 ──────────────────────────────────────────────────
const detected = 3 // 회피 시나리오 / 빈도 단독 / 결합
const attempts = normalTried + detected
console.log(
  `총 시도: ${attempts}회 | 탐지: ${detected}회 | 차단: 1회 | ` +
    `탐지율: ${Math.round((detected / (detected + normalFalse)) * 100)}%`,
)
console.log(
  `- 탐지 하한         : ${firstDetected}건 (평소 중앙값 ${medianCount}건의 ` +
    `${(firstDetected / medianCount).toFixed(1)}배) · 임계 z=${TRADE_POLICY.FREQUENCY.Z}`,
)
console.log(
  `- 금액규칙 회피 경로 : 건당 ${SPLIT_UNIT.toLocaleString('ko-KR')}원 × ${SPLIT_COUNT}건 ` +
    `= ${splitTotal.toLocaleString('ko-KR')}원 (평소 일간 총액 수준)`,
)
console.log(
  `                      단건 z·누적 z 모두 미탐 → M-6 이 z=${detectedZ.toFixed(2)} 로 탐지`,
)
console.log('- 등급 분리         : 빈도 단독 → ALLOW(기록만) / 빈도+고액 → STEP_UP')
console.log(
  `- 정상 범위 오탐률   : ${((normalFalse / normalTried) * 100).toFixed(1)}% ` +
    `(1~${firstDetected - 1}건 ${normalTried}회 중 ${normalFalse}회)`,
)
console.log(
  `- 대조군            : 평소 건수(${medianCount}건) z=${normalZ.toFixed(2)} 미탐 · ` +
    `급증(${SPLIT_COUNT}건) z=${detectedZ.toFixed(2)} 탐지`,
)

console.log(`\n검증 항목: ${pass}건 통과 / ${fail}건 실패`)
if (fail > 0) {
  console.log('\n실패 목록:')
  for (const f of failures) console.log(`  · ${f}`)
}
console.log(`판정: ${fail === 0 ? 'PASS' : 'FAIL'}`)
process.exit(fail === 0 ? 0 : 1)
