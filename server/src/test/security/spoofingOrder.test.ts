import {
  TRADE_POLICY,
  assessTrade,
  isObservationalSignal,
  type TradeInput,
  type TradeAssessment,
} from '../../services/auth/tradeAnomalyService'

// ─────────────────────────────────────────────────────────────
// [보안 검증] S10 허수주문(스푸핑) — 지정가 직후 즉시 취소 반복
//
// 체결 의사 없이 호가를 띄웠다 거두는 행위다. "단명 지정가"(생성→취소 지연이 아주 짧은
// 취소)의 반복(주 조건) 또는 비정상적으로 높은 취소율(보조 조건)로 판정한다.
// 관측 신호이므로 단독으로는 verdict 를 바꾸지 않고(ALLOW+기록), enforce 토글 시에만
// STEP_UP 으로 승격한다.
//
// 실행: cd server && npx ts-node src/test/security/spoofingOrder.test.ts
// ─────────────────────────────────────────────────────────────

let pass = 0
let fail = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass++
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`) }
}

const P = TRADE_POLICY.SPOOFING

// 금액 규칙(S1~S4)이 끼어들지 않도록 평범한 자기 이력을 준다.
const HISTORY = Array.from({ length: 40 }, (_, i) => 650_000 + (i % 7) * 20_000)
const NEUTRAL: Omit<TradeInput, 'cancelStats'> = {
  quantity: 10,
  price: 70_000,
  history: HISTORY,
  dailyTotals: [],
  recentTotal: 0,
  portfolioValue: null,
  side: 'buy',
}

function evaluate(
  cancelStats: TradeInput['cancelStats'],
  enforceManip = false,
): TradeAssessment {
  return assessTrade({ ...NEUTRAL, cancelStats, enforceManip })
}
const has = (a: TradeAssessment): boolean => a.signals.includes('SPOOFING_ORDER')

console.log('\n[보안 테스트] S10 허수주문(스푸핑)')
console.log(
  `\n정책: ${P.WINDOW_MS / 60000}분 창 · 단명 ${P.SHORT_LIVED_MS}ms 미만 ${P.MIN_SHORT_LIVED}건(주) · ` +
    `또는 취소율 ≥ ${P.CANCEL_RATIO} (모수 ${P.MIN_ORDERS}건 이상, 보조)`,
)

// ── 1) 주 조건: 단명 지정가 취소 반복 ───────────────────────────
const spoof = evaluate({ shortLivedCancels: P.MIN_SHORT_LIVED, totalCancels: 5, totalOrders: 6 })
check('단명 취소 임계 도달: 탐지', has(spoof), spoof.signals.join(','))
check('근거에 단명 표기', spoof.detail.includes('단명 지정가 취소'), spoof.detail)

const justBelow = evaluate({ shortLivedCancels: P.MIN_SHORT_LIVED - 1, totalCancels: 2, totalOrders: 3 })
check('단명 임계 미달 + 모수 부족: 미탐', !has(justBelow))

// ── 2) 보조 조건: 높은 취소율 ───────────────────────────────────
const highRatio = evaluate({ shortLivedCancels: 0, totalCancels: 8, totalOrders: 10 })
check('취소율 0.8(모수 10): 탐지', has(highRatio), highRatio.detail)
check('근거에 취소율 표기', highRatio.detail.includes('취소율'), highRatio.detail)

const smallSample = evaluate({ shortLivedCancels: 0, totalCancels: 3, totalOrders: 4 })
check('취소율 높아도 모수 부족(4<5): 미탐', !has(smallSample))

// ── 3) 정상 사용자 — 가끔 취소, 단명 아님 ───────────────────────
const normal = evaluate({ shortLivedCancels: 0, totalCancels: 1, totalOrders: 12 })
check('정상(취소율 0.08, 단명 0): 미탐', !has(normal))

// ── 4) 미전달 시 미평가(실거래 등 취소 미계측) ──────────────────
const absent = evaluate(null)
check('cancelStats null: 미탐', !has(absent))

// ── 5) 등급 분리 — 관측 기본, enforce 승격 ──────────────────────
check('SPOOFING_ORDER 이 관측 신호로 분류됨', isObservationalSignal('SPOOFING_ORDER'))
check('관측 기본: verdict 불변(ALLOW)', spoof.verdict === 'ALLOW', spoof.verdict)
check('관측 기본: 사용자 메시지 없음', spoof.userMessage === '')

const enforced = evaluate({ shortLivedCancels: P.MIN_SHORT_LIVED, totalCancels: 5, totalOrders: 6 }, true)
check('enforce 토글: STEP_UP 승격', enforced.verdict === 'STEP_UP', enforced.verdict)

console.log(`\n검증 항목: ${pass}건 통과 / ${fail}건 실패`)
if (fail > 0) { console.log('\n실패 목록:'); for (const f of failures) console.log(`  · ${f}`) }
console.log(`판정: ${fail === 0 ? 'PASS' : 'FAIL'}`)
process.exit(fail === 0 ? 0 : 1)
