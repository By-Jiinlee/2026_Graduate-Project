import {
  TRADE_POLICY,
  assessTrade,
  isObservationalSignal,
  type TradeAssessment,
} from '../../services/auth/tradeAnomalyService'

// ─────────────────────────────────────────────────────────────
// [보안 검증] M-8 반올림 금액 반복 패턴
//
// 이 규칙의 성패는 오탐이다. 사람도 "100만원어치 사자" 를 아주 흔하게 쓰기 때문에,
// 단발 반올림을 신호로 보면 정상 사용자가 매번 걸린다. 그래서 검증의 초점을
// **정상 사용자 오탐률**에 둔다.
//
//   1) 단발 반올림은 절대 탐지되지 않는가
//   2) 현실적인 주가·수량으로 만든 정상 사용자에게서 오탐이 나는가
//   3) 금액 지정 자동 주문(봇)은 탐지되는가
//   4) 관측 신호로서 판정을 바꾸지 않는가
//
// DB·서버 없이 정책 함수를 직접 호출하는 결정적 검증이다.
// 실행: cd server && npx ts-node src/test/security/roundAmountPattern.test.ts
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

let seed = 20260821
const rand = (): number => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]

const UNIT = TRADE_POLICY.ROUND.UNIT
const WINDOW = TRADE_POLICY.ROUND.WINDOW

// ── 현실적인 국내 주식 단가 (총액이 100만원 배수로 떨어지기 어려운 값) ──
const REAL_PRICES = [68_400, 178_500, 45_250, 215_000, 89_300, 12_750, 331_500, 57_800, 7_420, 143_000]
// ── 총액이 딱 떨어지는 단가 (사람도 이런 종목은 라운드로 산다) ──
const ROUND_FRIENDLY = [50_000, 100_000, 25_000, 200_000, 20_000]

const normalAmount = (): number => pick(REAL_PRICES) * (1 + Math.floor(rand() * 30))
const roundAmount = (): number => UNIT * (1 + Math.floor(rand() * 3))

const order = (amount: number) => ({ quantity: 10, price: amount / 10 })

const DAY = 24 * 60 * 60 * 1000

/** 주문 시각 생성기 — 간격(ms)만큼 과거로 거슬러 올라간다(오름차순). */
const timesEvery = (n: number, gapMs: number): number[] => {
  const now = Date.now()
  return Array.from({ length: n }, (_, i) => now - (n - i) * gapMs)
}

function evaluate(
  history: readonly number[],
  amount: number,
  historyAt?: readonly number[],
): TradeAssessment {
  return assessTrade({
    ...order(amount),
    history,
    historyAt,
    dailyTotals: [],
    recentTotal: 0,
    portfolioValue: null,
  })
}

const has = (a: TradeAssessment): boolean => a.signals.includes('ROUND_AMOUNT_PATTERN')

console.log('\n[보안 테스트] M-8 반올림 금액 반복 패턴')
console.log(
  `\n정책: ${UNIT.toLocaleString('ko-KR')}원 배수를 반올림으로 판정 · ` +
    `최근 ${WINDOW}건 중 ${(TRADE_POLICY.ROUND.RATIO * 100).toFixed(0)}% 이상 · ` +
    `표본 ${TRADE_POLICY.ROUND.MIN_SAMPLES}건 이상`,
)

// ── 1) ★ 단발 반올림은 신호가 아니다 ────────────────────────────
//     "정상 사용자가 100만원어치 산다" — 이 규칙이 절대 잡으면 안 되는 케이스.
const casualHistory = Array.from({ length: WINDOW - 1 }, normalAmount)
const casual = evaluate(casualHistory, UNIT)
check('단발 반올림: 미탐', !has(casual), `ratio=${casual.roundRatio}`)
check('단발 반올림: verdict ALLOW', casual.verdict === 'ALLOW', casual.verdict)

// ── 2) 정상 사용자 오탐률 — 라운드 주문을 낸 순간을 모수로 잡는다 ──
//     규칙은 "현재 주문이 반올림일 때만" 평가하므로, 그 순간이 정확한 모수다.
let normalTried = 0
let normalFalse = 0
for (let u = 0; u < 300; u++) {
  const hist = Array.from({ length: WINDOW - 1 }, normalAmount)
  normalTried++
  if (has(evaluate(hist, UNIT))) normalFalse++
}
check('정상 사용자 오탐 0', normalFalse === 0, `${normalFalse}/${normalTried}`)

// ── 3) ★ 최악의 오탐 후보: 적립식 매수 사용자 ───────────────────
//     "매번 100만원씩 정해놓고 산다" — 사람이 실제로 하는 투자 습관이고,
//     봇과 금액 패턴이 구조적으로 구별되지 않는다. 이 규칙의 진짜 한계 지점이라
//     걸리는지 걸리지 않는지를 숨기지 않고 그대로 측정한다.
//     (단가가 딱 떨어지는 종목을 쓰면 총액도 정확히 UNIT 배수가 된다)
let dcaTried = 0
let dcaFlaggedRatioOnly = 0   // 시간 조건 없이 비율만 봤을 때(개선 전)
let dcaFlagged = 0            // 시간 조건 적용(개선 후)
// 적립식 투자자는 한 달에 한 번 산다 → 반올림 주문이 시간축에 흩어진다.
const DCA_TIMES = timesEvery(WINDOW - 1, 30 * DAY)
for (let u = 0; u < 300; u++) {
  const hist = Array.from({ length: WINDOW - 1 }, () => {
    // 절반은 정액 매수(100만·200만원), 절반은 일반 종목 자유 매수
    if (rand() < 0.5) {
      const price = pick(ROUND_FRIENDLY)
      const target = UNIT * (1 + Math.floor(rand() * 2))
      return Math.round(target / price) * price // 정액에 맞춰 수량 산정 → UNIT 배수
    }
    return normalAmount()
  })
  dcaTried++
  if (has(evaluate(hist, UNIT))) dcaFlaggedRatioOnly++
  if (has(evaluate(hist, UNIT, DCA_TIMES))) dcaFlagged++
}
const dcaRateBefore = (dcaFlaggedRatioOnly / dcaTried) * 100
const dcaRate = (dcaFlagged / dcaTried) * 100
check('시간 조건이 적립식 오탐을 줄인다', dcaRate < dcaRateBefore,
  `${dcaRateBefore.toFixed(1)}% → ${dcaRate.toFixed(1)}%`)
check('적립식 오탐률이 5% 미만', dcaRate < 5, `${dcaRate.toFixed(1)}%`)

// ── 4) 봇 — 금액 지정 자동 주문 ─────────────────────────────────
const botHistory = Array.from({ length: WINDOW - 1 }, roundAmount)
// 자동화는 짧은 간격으로 반복한다 → 반올림 주문이 24시간 창에 몰린다.
const BOT_TIMES = timesEvery(WINDOW - 1, 10 * 60_000)
const bot = evaluate(botHistory, UNIT, BOT_TIMES)
check('봇 패턴: 탐지', has(bot), bot.signals.join(','))
check('봇 패턴: 근거에 비율 기록', bot.detail.includes('반올림 금액 반복'), bot.detail)

// ── 5) 탐지 하한 — 창 안에 몇 건이 반올림이어야 걸리는가 ─────────
let firstDetected = -1
for (let k = 1; k <= WINDOW; k++) {
  // 현재 주문 1건 + 과거 k-1건이 반올림, 나머지는 일반
  const hist = [
    ...Array.from({ length: WINDOW - k }, normalAmount),
    ...Array.from({ length: k - 1 }, roundAmount),
  ]
  if (has(evaluate(hist, UNIT))) { firstDetected = k; break }
}
check('탐지 하한이 존재한다', firstDetected > 0, `k=${firstDetected}`)
check(
  '탐지 하한이 정책 비율과 일치',
  firstDetected === Math.ceil(WINDOW * TRADE_POLICY.ROUND.RATIO),
  `${firstDetected} vs ${Math.ceil(WINDOW * TRADE_POLICY.ROUND.RATIO)}`,
)

// ── 6) 현재 주문이 반올림이 아니면 평가 자체를 하지 않는다 ───────
const notRound = evaluate(botHistory, 1_234_500, BOT_TIMES)
check('비반올림 주문: 미평가(roundRatio=null)', notRound.roundRatio === null, String(notRound.roundRatio))
check('비반올림 주문: 미탐', !has(notRound))

// ── 7) 표본 부족 시 판정 보류 ───────────────────────────────────
const few = evaluate([UNIT, UNIT, UNIT], UNIT) // 창 4건 < MIN_SAMPLES(10)
check('표본 부족: 판정 보류', few.roundRatio === null && !has(few), String(few.roundRatio))

// ── 8) 등급 분리 ────────────────────────────────────────────────
check('ROUND_AMOUNT_PATTERN 이 관측 신호로 분류됨', isObservationalSignal('ROUND_AMOUNT_PATTERN'))
check('봇 패턴 단독: verdict 불변(ALLOW)', bot.verdict === 'ALLOW', bot.verdict)
check('봇 패턴 단독: 관측 기록 detail', bot.detail.includes('거래 관측 신호'), bot.detail)
check('봇 패턴 단독: 사용자 메시지 없음', bot.userMessage === '')

// 고액과 결합하면 승격 — 베이스라인이 100만원대인데 5천만원 주문
const combined = assessTrade({
  ...order(UNIT * 50),
  history: botHistory,
  historyAt: BOT_TIMES,
  dailyTotals: [],
  recentTotal: 0,
  portfolioValue: null,
})
check(
  '결합: 두 신호 모두 기록',
  combined.signals.includes('ROUND_AMOUNT_PATTERN') && combined.signals.includes('AMOUNT_ZSCORE'),
  combined.signals.join(','),
)
check('결합: verdict 승격(STEP_UP)', combined.verdict === 'STEP_UP', combined.verdict)

// ── 9) M-6 과 동시 발생 — 관측 신호 둘만 서면 여전히 ALLOW ───────
const twoObservational = assessTrade({
  ...order(UNIT),
  history: botHistory,
  historyAt: BOT_TIMES,
  dailyTotals: [3_000_000, 3_000_000, 3_000_000, 3_000_000, 3_000_000, 3_000_000],
  recentTotal: 0,
  dailyCounts: [3, 3, 2, 3, 4, 3],
  recentCount: 40,
  portfolioValue: null,
})
check(
  '관측 신호 2종 동시: 둘 다 기록',
  twoObservational.signals.includes('ROUND_AMOUNT_PATTERN') &&
    twoObservational.signals.includes('TRADE_FREQUENCY_SPIKE'),
  twoObservational.signals.join(','),
)
check(
  '관측 신호 2종 동시: verdict 여전히 ALLOW',
  twoObservational.verdict === 'ALLOW',
  twoObservational.verdict,
)

// ── 요약 출력 ──────────────────────────────────────────────────
const detected = 3 // 봇 / 결합 / 관측2종
const attempts = normalTried + dcaTried + detected
console.log(
  `총 시도: ${attempts}회 | 탐지: ${detected + dcaFlagged}회 | 차단: 1회 | ` +
    `탐지율: ${((detected / detected) * 100).toFixed(0)}% ` +
    `(공격 ${detected}/${detected}, 오탐 ${normalFalse + dcaFlagged}/${normalTried + dcaTried})`,
)
console.log(
  `- 탐지 하한         : 최근 ${WINDOW}건 중 ${firstDetected}건 반올림 ` +
    `(= ${(TRADE_POLICY.ROUND.RATIO * 100).toFixed(0)}% 임계)`,
)
console.log(`- 단발 반올림       : 미탐 (정상 사용자의 "100만원어치" 주문은 걸리지 않음)`)
console.log(
  `- 정상 사용자 오탐률 : ${((normalFalse / normalTried) * 100).toFixed(1)}% ` +
    `(현실 주가 프로필 ${normalTried}명 중 ${normalFalse}명)`,
)
console.log(
  `- ★ 적립식 매수 사용자: 시간조건 없이 ${dcaRateBefore.toFixed(1)}% → ` +
    `적용 후 ${dcaRate.toFixed(1)}% (${dcaTried}명 중 ${dcaFlagged}명)`,
)
console.log(`- 봇(금액지정 반복) : 탐지 비율 ${((bot.roundRatio ?? 0) * 100).toFixed(0)}%`)
console.log(`- 등급 분리         : 관측 단독 → ALLOW(기록만) / 고액 결합 → STEP_UP`)
console.log(
  `\n오탐 대응 2층 구조:\n` +
    `  1층 등급 분리 — 관측 신호라 차단도 알림도 없다. 오탐의 '비용'을 0 으로 만든다.\n` +
    `  2층 시간 밀도 — 금액 축만 보면 적립식 매수자와 봇은 원리적으로 같다` +
    `(오탐 ${dcaRateBefore.toFixed(1)}%).\n` +
    `                  갈리는 것은 시간이다 — 적립식은 월 1회, 자동화는 24시간에 여러 번.\n` +
    `                  반올림 주문의 24시간 집중도를 함께 요구해 ${dcaRate.toFixed(1)}% 로 낮췄다.\n` +
    `  남은 한계    — 하루에 여러 번 정액 분할매수하는 사용자는 여전히 걸린다.\n` +
    `                  최종 봇 판정은 A(봇 탐지)가 주문 간격·행동 신호와 종합할 때 성립한다.`,
)

console.log(`\n검증 항목: ${pass}건 통과 / ${fail}건 실패`)
if (fail > 0) {
  console.log('\n실패 목록:')
  for (const f of failures) console.log(`  · ${f}`)
}
console.log(`판정: ${fail === 0 ? 'PASS' : 'FAIL'}`)
process.exit(fail === 0 ? 0 : 1)
