import {
  TRADE_POLICY,
  assessTrade,
  isObservationalSignal,
  type TradeInput,
  type TradeAssessment,
} from '../../services/auth/tradeAnomalyService'

// ─────────────────────────────────────────────────────────────
// [보안 검증] S11 자전거래 흔적 — 단일 계정 동일 종목 양방향 반복
//
// 오더북이 없어 A↔B 체결은 기계적으로 불가하므로 '흔적'을 본다. 짧은 창에서 같은 종목을
// 매수·매도 양방향으로 반복하는 단일 계정의 self-churn 을 신호로 삼는다. 동일 IP 다계정
// 맞물림은 별도 규칙(S9/M-7)이 담당한다.
//
// 호출부(evaluateTradeRequest)는 과거 방향별 건수(loadSelfChurn)에 현재 주문을 +1 한 값을
// selfChurn 으로 넘긴다. 이 테스트는 그 합산된 값으로 assessTrade 를 직접 호출한다.
//
// 실행: cd server && npx ts-node src/test/security/washTrade.test.ts
// ─────────────────────────────────────────────────────────────

let pass = 0
let fail = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass++
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`) }
}

const P = TRADE_POLICY.SELF_CHURN

const HISTORY = Array.from({ length: 40 }, (_, i) => 650_000 + (i % 7) * 20_000)
const NEUTRAL: Omit<TradeInput, 'selfChurn'> = {
  quantity: 10,
  price: 70_000,
  history: HISTORY,
  dailyTotals: [],
  recentTotal: 0,
  portfolioValue: null,
  side: 'buy',
}

function evaluate(
  selfChurn: TradeInput['selfChurn'],
  enforceManip = false,
): TradeAssessment {
  return assessTrade({ ...NEUTRAL, selfChurn, enforceManip })
}
const has = (a: TradeAssessment): boolean => a.signals.includes('WASH_TRADE')

console.log('\n[보안 테스트] S11 자전거래 흔적(self-churn)')
console.log(`\n정책: ${P.WINDOW_MS / 60000}분 창 · 같은 종목 매수·매도 각 ${P.MIN_EACH_SIDE}건 이상`)

// ── 1) 양방향 반복 — 자전거래 흔적 ─────────────────────────────
const churn = evaluate({ buyCount: P.MIN_EACH_SIDE, sellCount: P.MIN_EACH_SIDE })
check('매수·매도 각 임계 도달: 탐지', has(churn), churn.signals.join(','))
check('근거에 매수·매도 건수 표기', churn.detail.includes('매수') && churn.detail.includes('매도'), churn.detail)

const heavy = evaluate({ buyCount: 5, sellCount: 4 })
check('양방향 다수 반복: 탐지', has(heavy))

// ── 2) 한쪽 방향만 — 정상 매매(미탐) ───────────────────────────
const buyOnly = evaluate({ buyCount: 6, sellCount: 1 })
check('매수만 반복(매도 1): 미탐', !has(buyOnly))
const sellOnly = evaluate({ buyCount: 0, sellCount: 5 })
check('매도만 반복(매수 0): 미탐', !has(sellOnly))

// ── 3) 경계값 ───────────────────────────────────────────────────
const edge = evaluate({ buyCount: P.MIN_EACH_SIDE, sellCount: P.MIN_EACH_SIDE - 1 })
check('한쪽이 임계 미달: 미탐', !has(edge))

// ── 4) 미전달 시 미평가 ─────────────────────────────────────────
check('selfChurn null: 미탐', !has(evaluate(null)))

// ── 5) 등급 분리 — 관측 기본, enforce 승격 ──────────────────────
check('WASH_TRADE 가 관측 신호로 분류됨', isObservationalSignal('WASH_TRADE'))
check('관측 기본: verdict 불변(ALLOW)', churn.verdict === 'ALLOW', churn.verdict)
const enforced = evaluate({ buyCount: 3, sellCount: 3 }, true)
check('enforce 토글: STEP_UP 승격', enforced.verdict === 'STEP_UP', enforced.verdict)

console.log(`\n검증 항목: ${pass}건 통과 / ${fail}건 실패`)
if (fail > 0) { console.log('\n실패 목록:'); for (const f of failures) console.log(`  · ${f}`) }
console.log(`판정: ${fail === 0 ? 'PASS' : 'FAIL'}`)
process.exit(fail === 0 ? 0 : 1)
