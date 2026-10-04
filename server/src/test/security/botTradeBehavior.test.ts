import {
  TRADE_POLICY,
  assessTrade,
  isObservationalSignal,
  type TradeInput,
  type TradeAssessment,
} from '../../services/auth/tradeAnomalyService'

// ─────────────────────────────────────────────────────────────
// [보안 검증] S12 거래 화면 자동화
//   S12-a 일정한 주문 간격(서버 계산) — 사람은 들쭉날쭉, 봇은 일정하다. 간격 변동계수로 본다.
//   S12-b 마우스 없는 즉시 클릭(클라이언트) — 체류 중 마우스 이동 0회.
// 둘 중 하나라도 서면 BOT_TRADE_BEHAVIOR(관측). enforce 토글 시 STEP_UP 승격.
//
// 실행: cd server && npx ts-node src/test/security/botTradeBehavior.test.ts
// ─────────────────────────────────────────────────────────────

let pass = 0
let fail = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass++
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`) }
}

const OI = TRADE_POLICY.ORDER_INTERVAL
const BH = TRADE_POLICY.BEHAVIOR

const HISTORY = Array.from({ length: 40 }, (_, i) => 650_000 + (i % 7) * 20_000)
const NEUTRAL: Omit<TradeInput, 'orderIntervals' | 'behavior'> = {
  quantity: 10,
  price: 70_000,
  history: HISTORY,
  dailyTotals: [],
  recentTotal: 0,
  portfolioValue: null,
  side: 'buy',
}

function evaluate(
  orderIntervals: readonly number[] | undefined,
  behavior: TradeInput['behavior'] = null,
  enforceManip = false,
): TradeAssessment {
  return assessTrade({ ...NEUTRAL, orderIntervals, behavior, enforceManip })
}
const has = (a: TradeAssessment): boolean => a.signals.includes('BOT_TRADE_BEHAVIOR')

console.log('\n[보안 테스트] S12 거래 화면 자동화')
console.log(
  `\n정책: 간격 표본 ${OI.MIN_SAMPLES}개 이상 · 변동계수 ≤ ${OI.CV_MAX}(일정 간격) / ` +
    `체류 > ${BH.MIN_TIME_ON_PAGE_MS}ms 중 마우스 이동 0회`,
)

// ── 1) 일정한 주문 간격(봇) ─────────────────────────────────────
const regular = Array.from({ length: 6 }, () => 30_000) // 정확히 30초 간격
check('완전 일정 간격: 탐지', has(evaluate(regular)), evaluate(regular).detail)

const nearlyRegular = [30_000, 30_200, 29_900, 30_100, 30_050, 29_950] // 아주 미세한 흔들림
check('거의 일정한 간격(봇): 탐지', has(evaluate(nearlyRegular)))

// ── 2) 사람의 들쭉날쭉한 간격(정상) ─────────────────────────────
const human = [12_000, 95_000, 3_000, 240_000, 48_000, 7_000]
check('사람의 불규칙 간격: 미탐', !has(evaluate(human)))

// ── 3) 표본 부족 ───────────────────────────────────────────────
const few = [30_000, 30_000] // 간격 2개 < MIN_SAMPLES
check('간격 표본 부족: 미탐(미평가)', !has(evaluate(few)))

// ── 4) 마우스 없는 즉시 클릭(봇) ────────────────────────────────
const mouseless = evaluate(undefined, { mouseMoveCount: 0, timeOnPage: 1500 })
check('체류 중 마우스 0: 탐지', has(mouseless), mouseless.detail)
check('근거에 마우스 표기', mouseless.detail.includes('마우스 이동 0회'), mouseless.detail)

// ── 5) 마우스 사용자(정상) ──────────────────────────────────────
check('마우스 이동 있음: 미탐', !has(evaluate(undefined, { mouseMoveCount: 37, timeOnPage: 4000 })))
check('체류 짧음(즉시 로드 직후): 미탐', !has(evaluate(undefined, { mouseMoveCount: 0, timeOnPage: 300 })))
check('behavior 미전달: 미탐', !has(evaluate(undefined, null)))

// ── 6) 등급 분리 — 관측 기본, enforce 승격 ──────────────────────
check('BOT_TRADE_BEHAVIOR 가 관측 신호로 분류됨', isObservationalSignal('BOT_TRADE_BEHAVIOR'))
check('관측 기본: verdict 불변(ALLOW)', evaluate(regular).verdict === 'ALLOW')
const enforced = evaluate(regular, { mouseMoveCount: 0, timeOnPage: 1500 }, true)
check('enforce 토글: STEP_UP 승격', enforced.verdict === 'STEP_UP', enforced.verdict)

console.log(`\n검증 항목: ${pass}건 통과 / ${fail}건 실패`)
if (fail > 0) { console.log('\n실패 목록:'); for (const f of failures) console.log(`  · ${f}`) }
console.log(`판정: ${fail === 0 ? 'PASS' : 'FAIL'}`)
process.exit(fail === 0 ? 0 : 1)
