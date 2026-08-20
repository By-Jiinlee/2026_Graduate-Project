import {
  TRADE_POLICY,
  assessTrade,
  validateOrderIntegrity,
  type SanityReason,
  type TradeAssessment,
} from '../../services/auth/tradeAnomalyService'
import { summarize, robustScore, SCALE_FLOOR } from '../../services/auth/statsEngine'

// ─────────────────────────────────────────────────────────────
// [보안 검증] M-1 거래 이상탐지 — 주문 무결성 / 개인 베이스라인 이탈
//
// DB·서버 없이 정책 함수를 직접 호출하는 결정적 검증이다. 표본은 고정 시드
// 난수로 생성해 실행할 때마다 같은 수치가 나온다. 서비스 경로(HTTP·인증·DB)
// 검증은 별도 E2E 스크립트가 담당한다.
//
// 실행: cd server && npx ts-node src/test/security/tradeAmountAnomaly.test.ts
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

// 고정 시드 선형합동생성기 — 실행 간 재현성 보장
let seed = 20260801
const rand = (): number => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}

/** 중앙값 median 을 중심으로 로그 균등 산포(±spread)된 금액 표본 (1000원 단위) */
const sampleAmount = (median: number, spread = 1.0): number =>
  Math.round((median * Math.exp((rand() - 0.5) * spread)) / 1000) * 1000

/** 금액 → 주문(수량 10주 고정, 단가 = 금액/10) */
const order = (amount: number) => ({ quantity: 10, price: amount / 10 })

interface Scenario {
  amount: number
  portfolioValue?: number | null
  history?: readonly number[]
  dailyTotals?: readonly number[]
  recentTotal?: number
}

const assess = (s: Scenario): TradeAssessment =>
  assessTrade({
    ...order(s.amount),
    portfolioValue: s.portfolioValue,
    history: s.history ?? [],
    dailyTotals: s.dailyTotals ?? [],
    recentTotal: s.recentTotal ?? 0,
  })

// ─────────────────────────────────────────────
// 공통 표본 — "평소 10만원 안팎으로 거래하는 사용자"
// ─────────────────────────────────────────────
const HABIT_MEDIAN = 100_000
const DAILY_MEDIAN = 500_000
const PORTFOLIO = 10_000_000

const history = Array.from({ length: 60 }, () => sampleAmount(HABIT_MEDIAN))
const dailyTotals = Array.from({ length: 30 }, () => sampleAmount(DAILY_MEDIAN))

const baseline = summarize(history)
// 단건 탐지가 시작되는 금액 = 중앙값 × e^(3.5 × logScale)
const detectFrom = Math.exp(baseline.logMedian + TRADE_POLICY.Z.STEP_UP * baseline.logScale) - 1

let attackAttempts = 0
let attackDetected = 0
let attackBlocked = 0        // 요청이 실제로 거절되는 건(무결성 위반 + 서명 미동봉 재인증 요구)
let normalAttempts = 0
let falsePositives = 0

const runNormal = (s: Scenario): TradeAssessment => {
  normalAttempts++
  const r = assess(s)
  if (r.verdict !== 'ALLOW') falsePositives++
  return r
}

const runAttack = (s: Scenario): TradeAssessment => {
  attackAttempts++
  const r = assess(s)
  if (r.verdict !== 'ALLOW') { attackDetected++; attackBlocked++ }
  return r
}

// ─────────────────────────────────────────────
// 0) 통계 엔진 기본 성질
// ─────────────────────────────────────────────
check('베이스라인 표본 수', baseline.n === 60, String(baseline.n))
check('중앙값이 습관 중심 근처', Math.abs(baseline.median - HABIT_MEDIAN) / HABIT_MEDIAN < 0.2,
  `median=${baseline.median}`)
check('로그 산포 하한 적용', baseline.logScale >= SCALE_FLOOR, `logScale=${baseline.logScale.toFixed(3)}`)
check('중앙값 자신의 z ≈ 0', Math.abs(robustScore(baseline.median, baseline)) < 0.3,
  robustScore(baseline.median, baseline).toFixed(3))

// ─────────────────────────────────────────────
// 1) 정상 거래 — 오탐률(FPR) 측정
//    평소 습관 범위의 주문 40건 + 활발한 하루(누적 3배) 5건
// ─────────────────────────────────────────────
for (let i = 0; i < 40; i++) {
  const amount = sampleAmount(HABIT_MEDIAN)
  const r = runNormal({ amount, portfolioValue: PORTFOLIO, history, dailyTotals, recentTotal: 200_000 })
  if (r.verdict !== 'ALLOW') failures.push(`정상 주문 오탐 — 금액 ${amount}, 신호 ${r.signals.join(',')}`)
}

// 평소보다 활발한 하루: 하루 누적이 평소 중앙값의 3배까지 쌓여도 통과해야 한다
let busyTotal = 0
for (let i = 0; i < 5; i++) {
  const amount = sampleAmount(HABIT_MEDIAN * 3)
  const r = runNormal({ amount, portfolioValue: PORTFOLIO, history, dailyTotals, recentTotal: busyTotal })
  busyTotal += amount
  if (r.verdict !== 'ALLOW') failures.push(`활발한 하루 오탐 — 누적 ${busyTotal}, 신호 ${r.signals.join(',')}`)
}

// 평소보다 작은 주문은 위험 신호가 아니다 (하방 이탈 미탐지)
const small = runNormal({ amount: 5_000, portfolioValue: PORTFOLIO, history, dailyTotals })
check('평소보다 작은 주문은 미탐지', small.verdict === 'ALLOW', small.signals.join(','))

// 표본이 거의 동일한 사용자(산포 0)도 같은 금액 주문은 통과해야 한다
const flatHistory = Array.from({ length: 30 }, () => 100_000)
const flatSame = runNormal({ amount: 100_000, portfolioValue: PORTFOLIO, history: flatHistory })
check('산포 0 표본 — 동일 금액 주문 미탐지', flatSame.verdict === 'ALLOW', flatSame.signals.join(','))

// ─────────────────────────────────────────────
// 2) 공격 A — 계정 탈취 후 단발 고액 주문
//    포트폴리오를 크게 잡아 비율 규칙을 배제하고 통계 규칙 단독 효과를 본다
// ─────────────────────────────────────────────
const takeover = runAttack({
  amount: HABIT_MEDIAN * 30,
  portfolioValue: 500_000_000,
  history,
  dailyTotals,
})
check('단발 고액 주문 탐지(통계 단독)', takeover.signals.includes('AMOUNT_ZSCORE'),
  `verdict=${takeover.verdict}, z=${takeover.amountZ?.toFixed(2)}`)
check('단발 고액 주문 → 재인증 요구', takeover.verdict === 'STEP_UP', takeover.verdict)

// 산포 0 사용자에 대한 고액 주문 — 하한 덕에 z=∞ 가 아니라 유한한 값으로 탐지
const flatSpike = runAttack({ amount: 1_000_000, portfolioValue: 500_000_000, history: flatHistory })
check('산포 0 표본 — 고액 주문 탐지', flatSpike.signals.includes('AMOUNT_ZSCORE'),
  `z=${flatSpike.amountZ?.toFixed(2)}`)
check('산포 0 표본 z 가 유한', Number.isFinite(flatSpike.amountZ ?? NaN), String(flatSpike.amountZ))

// ─────────────────────────────────────────────
// 3) 공격 B — 콜드 스타트 계정(표본 부족)에서의 고액 주문
//    통계는 못 쓰지만 포트폴리오 비율 규칙이 남아 있어야 한다
// ─────────────────────────────────────────────
const coldHistory = [100_000, 120_000]
const cold = runAttack({
  amount: 2_500_000,             // 평가액의 25%
  portfolioValue: PORTFOLIO,
  history: coldHistory,
})
check('콜드 스타트 — 통계 판정 보류', cold.amountZ === null, String(cold.amountZ))
check('콜드 스타트 — 비율 규칙으로 탐지', cold.signals.includes('PORTFOLIO_RATIO'), cold.signals.join(','))

// 콜드 스타트 사용자의 소액 주문은 통과해야 한다
const coldNormal = runNormal({ amount: 110_000, portfolioValue: PORTFOLIO, history: coldHistory })
check('콜드 스타트 — 소액 주문 미탐지', coldNormal.verdict === 'ALLOW', coldNormal.signals.join(','))

// ─────────────────────────────────────────────
// 4) 공격 C — 분할 주문(smurfing) 회피
//    단건 z 를 임계 아래로 낮춰 여러 번 나눠 보낸다.
//    개별 주문은 통과하지만 24시간 누적 신호가 잡아야 한다.
// ─────────────────────────────────────────────
const SPLIT_AMOUNT = Math.round(HABIT_MEDIAN * 3.5)   // 단건 z < 3.5 가 되도록
const splitSingle = assess({ amount: SPLIT_AMOUNT, portfolioValue: PORTFOLIO, history, dailyTotals })
check('분할 단건은 단건 규칙을 우회함(설계 확인)',
  !splitSingle.signals.includes('AMOUNT_ZSCORE'), `z=${splitSingle.amountZ?.toFixed(2)}`)

let splitTotal = 0
let splitDetectedAt = 0
for (let i = 1; i <= 12; i++) {
  attackAttempts++
  const r = assess({
    amount: SPLIT_AMOUNT,
    portfolioValue: 500_000_000,   // 비율 규칙 배제 — 누적 신호 단독 효과 측정
    history,
    dailyTotals,
    recentTotal: splitTotal,
  })
  splitTotal += SPLIT_AMOUNT
  if (r.verdict !== 'ALLOW') {
    attackDetected++
    attackBlocked++
    if (splitDetectedAt === 0) splitDetectedAt = i
  }
}
check('분할 주문 누적 탐지', splitDetectedAt > 0, '12회 내 미탐지')
check('분할 주문 탐지 시점이 합리적', splitDetectedAt > 1 && splitDetectedAt <= 8, `${splitDetectedAt}번째`)

// ─────────────────────────────────────────────
// 5) 공격 D — 기준선 상승(frog-boiling)
//    금액을 조금씩 키워 베이스라인 자체를 끌어올리는 회피.
//    크기(중앙값 비율)와 방향(Mann-Kendall 단조성)을 함께 요구하는 규칙이므로
//    ① 등차 상승 ② 등비 상승 두 형태를 모두 잡는지, 그리고
//    ③ 변동만 큰 정상 사용자는 걸리지 않는지를 같이 본다.
// ─────────────────────────────────────────────
const rampHistory = Array.from({ length: 20 }, (_, i) =>
  Math.round((100_000 * (1 + (i / 19) * 3)) / 1000) * 1000,   // 10만 → 40만 등차 점증
)
const ramp = runAttack({
  amount: 400_000,
  portfolioValue: 500_000_000,
  history: rampHistory,
})
check('기준선 상승(등차) 탐지', ramp.signals.includes('BASELINE_ESCALATION'),
  `trend=${ramp.trend?.toFixed(2)}, z=${ramp.trendZ?.toFixed(2)}, 신호=${ramp.signals.join(',')}`)

// 등비 상승 — 매 주문을 이전의 1.2배로 키우는 형태(단건 z 임계 아래를 유지하며 상승)
const geoHistory = Array.from({ length: 20 }, (_, i) =>
  Math.round((100_000 * Math.pow(1.2, i)) / 1000) * 1000,
)
const geo = runAttack({ amount: 3_000_000, portfolioValue: 500_000_000, history: geoHistory })
check('기준선 상승(등비) 탐지', geo.signals.includes('BASELINE_ESCALATION'),
  `trend=${geo.trend?.toFixed(2)}, z=${geo.trendZ?.toFixed(2)}`)

// 습관이 안정적인 사용자는 상승 신호가 뜨지 않아야 한다
const stable = runNormal({ amount: HABIT_MEDIAN, portfolioValue: PORTFOLIO, history, dailyTotals })
check('안정적 습관 — 상승 신호 오탐 없음', !stable.signals.includes('BASELINE_ESCALATION'),
  `trend=${stable.trend?.toFixed(2)}, z=${stable.trendZ?.toFixed(2)}`)

// 변동이 큰 정상 사용자 — 후반이 우연히 커도 상승이 "일관"되지 않으면 미탐지여야 한다.
// (크기 조건만 쓰던 규칙이 오탐을 내던 지점 — 단조성 조건의 존재 이유)
const volatileHistory = [
  120_000, 90_000, 300_000, 80_000, 110_000, 95_000, 400_000, 100_000,
  130_000, 250_000, 85_000, 500_000, 140_000, 90_000, 350_000, 200_000,
]
const volatile = runNormal({ amount: 150_000, portfolioValue: PORTFOLIO, history: volatileHistory })
check('변동 큰 정상 사용자 — 상승 신호 오탐 없음',
  !volatile.signals.includes('BASELINE_ESCALATION'),
  `trend=${volatile.trend?.toFixed(2)}, z=${volatile.trendZ?.toFixed(2)}`)

// 완만한 성장(1.4배) — 계좌가 커지며 거래 규모가 느는 정상 패턴은 통과해야 한다
const growthHistory = Array.from({ length: 20 }, (_, i) =>
  Math.round((100_000 * (1 + (i / 19) * 0.5)) / 1000) * 1000,   // 10만 → 15만
)
const growth = runNormal({ amount: 150_000, portfolioValue: PORTFOLIO, history: growthHistory })
check('완만한 성장 — 상승 신호 오탐 없음', !growth.signals.includes('BASELINE_ESCALATION'),
  `trend=${growth.trend?.toFixed(2)}, z=${growth.trendZ?.toFixed(2)}`)

// ─────────────────────────────────────────────
// 6) 공격 E — 주문 무결성 위반
//    음수 수량은 총액을 음수로 만들어 "잔고 차감"을 "잔고 증가"로 뒤집는다.
//    정상 클라이언트가 만들 수 없는 값이므로 경고가 아니라 즉시 거절한다.
// ─────────────────────────────────────────────
const malformed: { name: string; quantity: number; price: number; expect: SanityReason }[] = [
  { name: '음수 수량(잔고 증가 시도)', quantity: -100, price: 50_000, expect: 'QUANTITY_NOT_POSITIVE' },
  { name: '수량 0',                    quantity: 0, price: 50_000, expect: 'QUANTITY_NOT_POSITIVE' },
  { name: '소수 수량',                 quantity: 0.5, price: 50_000, expect: 'QUANTITY_NOT_INTEGER' },
  { name: '소수 수량(반올림 유도)',    quantity: 1.9999, price: 50_000, expect: 'QUANTITY_NOT_INTEGER' },
  { name: '수량 NaN',                  quantity: Number('abc'), price: 50_000, expect: 'QUANTITY_NOT_FINITE' },
  { name: '수량 Infinity',             quantity: Infinity, price: 50_000, expect: 'QUANTITY_NOT_FINITE' },
  { name: '수량 상한 초과',            quantity: 5_000_000, price: 50_000, expect: 'QUANTITY_TOO_LARGE' },
  { name: '음수 가격',                 quantity: 10, price: -50_000, expect: 'PRICE_NOT_POSITIVE' },
  { name: '가격 0',                    quantity: 10, price: 0, expect: 'PRICE_NOT_POSITIVE' },
  { name: '가격 NaN',                  quantity: 10, price: Number('1e'), expect: 'PRICE_NOT_FINITE' },
  { name: '가격 Infinity',             quantity: 10, price: Number('1e999'), expect: 'PRICE_NOT_FINITE' },
  { name: '가격 상한 초과',            quantity: 10, price: 1e9, expect: 'PRICE_TOO_LARGE' },
  { name: '금액 상한 초과',            quantity: 900_000, price: 90_000_000, expect: 'AMOUNT_TOO_LARGE' },
  { name: '음수 수량 + 음수 가격',     quantity: -10, price: -50_000, expect: 'QUANTITY_NOT_POSITIVE' },
]

let sanityBlocked = 0
let sanityReasonMatched = 0
for (const m of malformed) {
  attackAttempts++
  const r = assessTrade({
    quantity: m.quantity,
    price: m.price,
    portfolioValue: PORTFOLIO,
    history,
    dailyTotals,
  })
  if (r.verdict === 'BLOCK') {
    attackDetected++
    attackBlocked++
    sanityBlocked++
    if (r.sanityReason === m.expect) sanityReasonMatched++
    else failures.push(`${m.name} — 사유 불일치: 기대 ${m.expect} / 실제 ${r.sanityReason}`)
  } else {
    failures.push(`${m.name} — 차단되지 않음(verdict=${r.verdict})`)
  }
}
check('무결성 위반 전건 차단', sanityBlocked === malformed.length, `${sanityBlocked}/${malformed.length}`)
check('차단 사유 정확도', sanityReasonMatched === malformed.length, `${sanityReasonMatched}/${malformed.length}`)

// 정상 주문 파라미터는 무결성 검사를 통과해야 한다
const validOrders = [
  { quantity: 1, price: 1_000 },
  { quantity: 10, price: 74_500 },
  { quantity: 1_000_000, price: 100 },
]
let integrityPass = 0
for (const v of validOrders) {
  normalAttempts++
  if (validateOrderIntegrity(v.quantity, v.price).ok) integrityPass++
  else { falsePositives++; failures.push(`정상 주문 파라미터 거절 — 수량 ${v.quantity}, 가격 ${v.price}`) }
}
check('정상 주문 파라미터 통과', integrityPass === validOrders.length, `${integrityPass}/${validOrders.length}`)

// ─────────────────────────────────────────────
// 7) 베이스라인 오염 내성 — 강건 통계 vs 평균·표준편차
//    침해 계정이 만든 고액 거래가 표본에 섞였을 때도 다음 공격을 잡는가?
// ─────────────────────────────────────────────
const cleanHistory = Array.from({ length: 50 }, () => sampleAmount(HABIT_MEDIAN))
const poisonedHistory = [...cleanHistory, ...Array.from({ length: 10 }, () => 10_000_000)]
const ATTACK_AMOUNT = 3_000_000

const poisonedRobust = assess({
  amount: ATTACK_AMOUNT,
  portfolioValue: 500_000_000,
  history: poisonedHistory,
})

// 대조군: 같은 표본에 고전적 z-점수(평균·표준편차, 원척도)를 적용
const mean = poisonedHistory.reduce((a, b) => a + b, 0) / poisonedHistory.length
const std = Math.sqrt(
  poisonedHistory.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (poisonedHistory.length - 1),
)
const classicZ = (ATTACK_AMOUNT - mean) / std

attackAttempts++
if (poisonedRobust.verdict !== 'ALLOW') { attackDetected++; attackBlocked++ }

check('오염 표본에서도 강건 통계는 탐지',
  poisonedRobust.signals.includes('AMOUNT_ZSCORE'),
  `z=${poisonedRobust.amountZ?.toFixed(2)}`)
check('대조군(평균·표준편차)은 미탐 — 강건 통계 채택 근거',
  classicZ < TRADE_POLICY.Z.STEP_UP, `classicZ=${classicZ.toFixed(2)}`)

// 산포 추정치 자체가 오염에 밀리지 않아야 한다.
// (MAD 가 0이 아닌데 비강건 2차 추정치로 갈아타면 오염 10건이 분모를 3배 부풀려
//  z 를 임계 아래로 눌렀다 — 회귀 방지용 검사)
const poisonedBaseline = summarize(poisonedHistory)
const cleanBaseline = summarize(cleanHistory)
check('오염 시 비강건 추정치로 갈아타지 않음',
  poisonedBaseline.scaleSource === 'MAD' || poisonedBaseline.scaleSource === 'FLOOR',
  poisonedBaseline.scaleSource)
check('오염이 산포 추정치를 1.5배 넘게 부풀리지 못함',
  poisonedBaseline.logScale <= cleanBaseline.logScale * 1.5,
  `오염 ${poisonedBaseline.logScale.toFixed(3)} vs 정상 ${cleanBaseline.logScale.toFixed(3)}`)
check('오염이 중앙값(기준점)을 밀지 못함',
  Math.abs(poisonedBaseline.median - cleanBaseline.median) / cleanBaseline.median < 0.3,
  `오염 ${poisonedBaseline.median} vs 정상 ${cleanBaseline.median}`)

// MAD 가 0인 표본(과반이 동일 값)에서는 편차 분위수로 산포를 잡아 과민 반응을 막는다.
// 상승 추세 신호와 분리해서 보기 위해 큰 금액을 시간축에 흩어 놓는다(단조 아님).
let variedIdx = 0
const halfFlat = Array.from({ length: 50 }, (_, i) =>
  i % 5 < 2 ? 100_000 + ((variedIdx++ * 7) % 20) * 40_000 : 100_000,
)
const halfFlatBaseline = summarize(halfFlat)
check('MAD=0 표본 — 2차 추정치(편차 분위수) 사용',
  halfFlatBaseline.scaleSource === 'DEV_Q75' || halfFlatBaseline.scaleSource === 'FLOOR',
  halfFlatBaseline.scaleSource)
const halfFlatNormal = runNormal({ amount: 500_000, portfolioValue: PORTFOLIO, history: halfFlat })
check('MAD=0 표본 — 관측 범위 내 금액은 미탐지', halfFlatNormal.verdict === 'ALLOW',
  `z=${halfFlatNormal.amountZ?.toFixed(2)}, src=${halfFlatBaseline.scaleSource}`)

// ─────────────────────────────────────────────
// 8) 알려진 한계 측정 — 임계 직하 단발 주문
//    통계 임계 바로 아래 금액은 단건 규칙을 통과한다(설계상 허용).
//    다만 반복하면 7)의 누적 규칙에 걸린다는 점을 함께 측정한다.
// ─────────────────────────────────────────────
const justBelow = Math.round((detectFrom * 0.95) / 1000) * 1000
const evade = assess({ amount: justBelow, portfolioValue: 500_000_000, history, dailyTotals })
check('임계 직하 금액은 단건 규칙 통과(설계 확인)',
  !evade.signals.includes('AMOUNT_ZSCORE'), `z=${evade.amountZ?.toFixed(2)}`)

// ─────────────────────────────────────────────
// 결과 출력
// ─────────────────────────────────────────────
const detectRate = ((attackDetected / attackAttempts) * 100).toFixed(0)
const fpr = ((falsePositives / normalAttempts) * 100).toFixed(1)

console.log('')
console.log('[보안 테스트] 거래 이상탐지 (M-1 정책 단위 검증)')
console.log(`총 시도: ${normalAttempts + attackAttempts}회 | 탐지: ${attackDetected}회 | 차단: ${attackBlocked}회 | 탐지율: ${detectRate}%`)
console.log(`- 주문 무결성 위반   : ${sanityBlocked}/${malformed.length} 차단 (사유 정확 ${sanityReasonMatched}/${malformed.length})`)
console.log(`- 단발 고액(계정탈취): 탐지 z=${takeover.amountZ?.toFixed(2)} (임계 ${TRADE_POLICY.Z.STEP_UP}) → ${takeover.verdict}`)
console.log(`- 분할 주문(smurfing): 단건 z=${splitSingle.amountZ?.toFixed(2)} 미탐 · 누적 규칙이 ${splitDetectedAt}회차에서 탐지`)
console.log(`- 기준선 상승(회피)  : 등차 ${ramp.trend?.toFixed(1)}배·z=${ramp.trendZ?.toFixed(1)} / 등비 ${geo.trend?.toFixed(1)}배·z=${geo.trendZ?.toFixed(1)} 탐지 (임계 ${TRADE_POLICY.ESCALATION.RATIO}배 & z≥${TRADE_POLICY.ESCALATION.TREND_Z}) · 변동형 정상 사용자 ${volatile.trend?.toFixed(1)}배·z=${volatile.trendZ?.toFixed(1)} 미탐`)
console.log(`- 콜드 스타트 계정   : 표본 ${coldHistory.length}건 → 통계 보류, 평가액 대비 ${((cold.ratio ?? 0) * 100).toFixed(0)}% 비율 규칙으로 탐지`)
console.log(`- 베이스라인 오염    : 표본 ${poisonedHistory.length}건 중 10건 오염 시 강건 z=${poisonedRobust.amountZ?.toFixed(2)} 탐지 / 평균·표준편차 z=${classicZ.toFixed(2)} 미탐`)
console.log(`- 개인 임계(자동)    : 중앙값 ${Math.round(baseline.median).toLocaleString('ko-KR')}원 → 단건 탐지 하한 ${Math.round(detectFrom).toLocaleString('ko-KR')}원 (${(detectFrom / baseline.median).toFixed(1)}배)`)
console.log(`- 정상 요청 오탐률   : ${fpr}% (정상 ${normalAttempts}회 중 ${falsePositives}회 차단)`)

if (failures.length > 0) {
  console.log('\n[실패 항목]')
  for (const f of failures) console.log(`  · ${f}`)
}

console.log(`\n검증 항목: ${pass}건 통과 / ${fail}건 실패`)
console.log(`판정: ${fail === 0 ? 'PASS' : 'FAIL'}`)
process.exit(fail === 0 ? 0 : 1)
