import { TRADE_POLICY, assessTrade } from '../../services/auth/tradeAnomalyService'

// ─────────────────────────────────────────────────────────────
// [보안 검증] 위험 맥락 기반 거래 탐지 (M-2 / M-3)
//
// M-2 계정 정보 변경 직후 고액 거래 — 탈취 계정의 전형적 순서다. 공격자는 소유자가
//     되돌리지 못하도록 비밀번호·이메일을 먼저 바꾸고 곧바로 자산을 옮긴다.
// M-3 장기 미사용 계정의 갑작스러운 고액 거래 — 방치된 계정은 소유자 감시가 느슨해
//     탈취 후 악용 표적이 되기 쉽다.
//
// 두 규칙은 "새 임계"를 만드는 대신 **기존 임계를 맥락에 따라 낮춘다**.
//   평상시 : 단건 z ≥ 3.5  또는 평가액 대비 20%
//   위험 창: 단건 z ≥ 2.0  또는 평가액 대비  5%
//
// 그래서 이 검증의 핵심 질문은 두 가지다.
//   (1) 위험 창 안에서, 평상시라면 통과했을 금액이 탐지되는가  ← 규칙의 존재 이유
//   (2) 위험 창 밖에서는 동작이 이전과 완전히 동일한가          ← 오탐을 늘리지 않았는가
//
// (2)가 무너지면 이 규칙은 순이익이 아니라 순손실이다. 그래서 같은 입력을 창 안/밖으로만
// 바꿔가며 대조하는 방식으로 구성했다.
//
// 실행: cd server && npx ts-node src/test/security/contextualTrade.test.ts
// ─────────────────────────────────────────────────────────────

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass++
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`) }
}

// 습관 중심 30만원, 편차가 작은 안정적 사용자. 표본 60건.
const HABIT = 300_000
const rng = (seed: number) => {
  let s = seed
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
}
const rand = rng(20260820)
const history = Array.from({ length: 60 }, () => Math.round(HABIT * (0.85 + rand() * 0.3)))
const dailyTotals = Array.from({ length: 30 }, () => Math.round(HABIT * 2 * (0.85 + rand() * 0.3)))
const PORTFOLIO = 10_000_000

interface Ctx {
  minutesSinceCredentialChange?: number | null
  daysSinceLastActivity?: number | null
}

function evaluate(amount: number, ctx: Ctx = {}) {
  return assessTrade({
    quantity: 1,
    price: amount,
    portfolioValue: PORTFOLIO,
    history,
    dailyTotals,
    recentTotal: 0,
    ...ctx,
  })
}

// 평상시 임계는 넘지 않지만 완화 임계는 넘는 금액을 찾는다.
// (이 금액이 존재해야 두 규칙이 의미를 갖는다 — 없으면 규칙이 무용지물이라는 뜻)
const MID_AMOUNT = 900_000            // 평가액의 9% — 완화 5% 초과, 평상시 20% 미만
const SMALL_AMOUNT = 320_000          // 습관 범위 안 — 어떤 임계도 넘지 않음
const HUGE_AMOUNT = 3_000_000         // 평가액의 30% — 평상시 임계도 초과

const midBaseline = evaluate(MID_AMOUNT)
check('전제: 중간 금액은 평상시 임계로는 미탐', midBaseline.verdict === 'ALLOW',
  `z=${midBaseline.amountZ?.toFixed(2)} ratio=${midBaseline.ratio?.toFixed(3)} → ${midBaseline.verdict}`)
check('전제: 소액은 평상시에도 미탐', evaluate(SMALL_AMOUNT).verdict === 'ALLOW')
check('전제: 초고액은 평상시에도 탐지', evaluate(HUGE_AMOUNT).verdict !== 'ALLOW')

// ─────────────────────────────────────────────
// 1) M-2 공격 — 자격증명 변경 직후 고액 거래
// ─────────────────────────────────────────────
const M2_ATTACKS: Array<[string, number, Ctx]> = [
  ['비밀번호 변경 1분 후 고액 거래',      MID_AMOUNT, { minutesSinceCredentialChange: 1 }],
  ['이메일 변경 5분 후 고액 거래',        MID_AMOUNT, { minutesSinceCredentialChange: 5 }],
  ['변경 15분 후 고액 거래',              MID_AMOUNT, { minutesSinceCredentialChange: 15 }],
  ['변경 직후 초고액 거래',               HUGE_AMOUNT, { minutesSinceCredentialChange: 2 }],
  ['변경 30분(창 경계) 고액 거래',        MID_AMOUNT, { minutesSinceCredentialChange: 30 }],
]

let m2Detected = 0
for (const [label, amount, ctx] of M2_ATTACKS) {
  const r = evaluate(amount, ctx)
  const ok = r.signals.includes('POST_CREDENTIAL_CHANGE')
  if (ok) m2Detected++
  check(`M-2 탐지: ${label}`, ok, `signals=[${r.signals.join(',')}]`)
}

// ─────────────────────────────────────────────
// 2) M-3 공격 — 휴면 계정의 갑작스러운 고액 거래
// ─────────────────────────────────────────────
const M3_ATTACKS: Array<[string, number, Ctx]> = [
  ['30일(경계) 미사용 후 고액 거래',   MID_AMOUNT, { daysSinceLastActivity: 30 }],
  ['90일 미사용 후 고액 거래',         MID_AMOUNT, { daysSinceLastActivity: 90 }],
  ['1년 미사용 후 고액 거래',          MID_AMOUNT, { daysSinceLastActivity: 365 }],
  ['휴면 후 초고액 거래',              HUGE_AMOUNT, { daysSinceLastActivity: 120 }],
]

let m3Detected = 0
for (const [label, amount, ctx] of M3_ATTACKS) {
  const r = evaluate(amount, ctx)
  const ok = r.signals.includes('DORMANT_ACTIVITY')
  if (ok) m3Detected++
  check(`M-3 탐지: ${label}`, ok, `signals=[${r.signals.join(',')}]`)
}

// 두 맥락이 동시에 성립하는 경우 — 둘 다 기록돼야 한다
const both = evaluate(MID_AMOUNT, { minutesSinceCredentialChange: 3, daysSinceLastActivity: 200 })
check('복합 맥락 — 두 신호 모두 기록',
  both.signals.includes('POST_CREDENTIAL_CHANGE') && both.signals.includes('DORMANT_ACTIVITY'),
  `signals=[${both.signals.join(',')}]`)

// ─────────────────────────────────────────────
// 3) 오탐 — 이 규칙의 성패가 갈리는 지점
//
// 핵심: 위험 창 "밖"에서는 이 규칙이 존재하지 않는 것과 동일해야 한다.
// ─────────────────────────────────────────────
const NORMALS: Array<[string, number, Ctx]> = [
  ['맥락 없음(평상시) 중간 금액',            MID_AMOUNT, {}],
  ['변경 31분 후(창 밖) 고액 거래',          MID_AMOUNT, { minutesSinceCredentialChange: 31 }],
  ['변경 2시간 후 고액 거래',                MID_AMOUNT, { minutesSinceCredentialChange: 120 }],
  ['변경 하루 뒤 고액 거래',                 MID_AMOUNT, { minutesSinceCredentialChange: 1440 }],
  ['변경 직후지만 평소 금액',                SMALL_AMOUNT, { minutesSinceCredentialChange: 1 }],
  ['변경 직후지만 소액(평소보다 작음)',      100_000, { minutesSinceCredentialChange: 1 }],
  ['29일 미사용 후 고액(임계 아래)',         MID_AMOUNT, { daysSinceLastActivity: 29 }],
  ['매일 거래하는 사용자 고액',              MID_AMOUNT, { daysSinceLastActivity: 1 }],
  ['휴면 후지만 평소 금액으로 재개',         SMALL_AMOUNT, { daysSinceLastActivity: 200 }],
  ['첫 거래(활동 이력 없음)',                MID_AMOUNT, { daysSinceLastActivity: null }],
  ['자격증명 변경 이력 없음',                MID_AMOUNT, { minutesSinceCredentialChange: null }],
]

let falsePositives = 0
for (const [label, amount, ctx] of NORMALS) {
  const r = evaluate(amount, ctx)
  const flagged = r.signals.includes('POST_CREDENTIAL_CHANGE') || r.signals.includes('DORMANT_ACTIVITY')
  if (flagged) falsePositives++
  check(`정상 통과: ${label}`, !flagged, `signals=[${r.signals.join(',')}]`)
}

// ─────────────────────────────────────────────
// 4) 회귀 — 평상시 판정이 이전과 완전히 동일한가
//
// 맥락 필드를 아예 넘기지 않은 결과와, 창 밖 값을 넘긴 결과가 같아야 한다.
// 다르면 이 규칙이 평상시 동작을 바꿔버린 것이다.
// ─────────────────────────────────────────────
const AMOUNTS = [100_000, 300_000, 500_000, MID_AMOUNT, 1_500_000, HUGE_AMOUNT, 5_000_000]
let identical = 0
for (const amt of AMOUNTS) {
  const withoutCtx = evaluate(amt)
  const outsideWindow = evaluate(amt, { minutesSinceCredentialChange: 999, daysSinceLastActivity: 1 })
  const same =
    withoutCtx.verdict === outsideWindow.verdict &&
    withoutCtx.signals.join(',') === outsideWindow.signals.join(',')
  if (same) identical++
  check(`평상시 판정 불변: ${amt.toLocaleString('ko-KR')}원`, same,
    `${withoutCtx.verdict}[${withoutCtx.signals}] vs ${outsideWindow.verdict}[${outsideWindow.signals}]`)
}

// ─────────────────────────────────────────────
// 5) 비정상 입력 안전 처리
// ─────────────────────────────────────────────
const INVALID: Array<[string, Ctx]> = [
  ['NaN 경과 시간',        { minutesSinceCredentialChange: NaN }],
  ['Infinity 경과 시간',   { minutesSinceCredentialChange: Infinity }],
  ['음수 경과(시계 역전)', { minutesSinceCredentialChange: -10 }],
  ['NaN 휴면 일수',        { daysSinceLastActivity: NaN }],
  ['Infinity 휴면 일수',   { daysSinceLastActivity: Infinity }],
]
// Infinity 는 임계를 "넘기는" 값이라 탐지시키고 싶어지지만, 그렇게 하면 손상된
// 타임스탬프 하나가 정상 사용자를 공격자로 만든다. 유한하지 않은 값은 전부 미평가가 맞다.
let invalidSafe = 0
for (const [label, ctx] of INVALID) {
  const r = evaluate(MID_AMOUNT, ctx)
  const flagged = r.signals.includes('POST_CREDENTIAL_CHANGE') || r.signals.includes('DORMANT_ACTIVITY')
  if (!flagged) invalidSafe++
  check(`비정상 입력 미평가: ${label}`, !flagged, `flagged=${flagged}`)
}

// ─────────────────────────────────────────────
// 결과 출력
// ─────────────────────────────────────────────
const attacks = M2_ATTACKS.length + M3_ATTACKS.length
const detected = m2Detected + m3Detected
const fpr = (falsePositives / NORMALS.length) * 100

console.log('')
console.log('[보안 테스트] 위험 맥락 기반 거래 탐지 (M-2 계정변경 직후 / M-3 휴면 계정)')
console.log(`총 시도: ${attacks + NORMALS.length}회 | 탐지: ${detected}회 | 차단: ${detected}회(STEP_UP) | 탐지율: ${((detected / attacks) * 100).toFixed(0)}%`)
console.log(`- M-2 자격증명 변경 직후 : ${m2Detected}/${M2_ATTACKS.length} 탐지 (창 ${TRADE_POLICY.ELEVATED.CREDENTIAL_CHANGE_WINDOW_MIN}분)`)
console.log(`- M-3 휴면 계정 재개     : ${m3Detected}/${M3_ATTACKS.length} 탐지 (임계 ${TRADE_POLICY.ELEVATED.DORMANT_DAYS}일)`)
console.log(`- 정상 사용자 오탐       : ${falsePositives}/${NORMALS.length} (오탐률 ${fpr.toFixed(1)}%)`)
console.log(`- 평상시 판정 불변       : ${identical}/${AMOUNTS.length} (창 밖에서는 규칙이 없는 것과 동일)`)
console.log(`- 비정상 입력 처리       : ${invalidSafe}/${INVALID.length}`)
console.log(`- 임계 완화              : 단건 z ${TRADE_POLICY.Z.STEP_UP} → ${TRADE_POLICY.ELEVATED.Z} · 평가액 비율 ${(TRADE_POLICY.RATIO.STEP_UP * 100).toFixed(0)}% → ${(TRADE_POLICY.ELEVATED.RATIO * 100).toFixed(0)}%`)
console.log(`- [대조군] 같은 금액(${MID_AMOUNT.toLocaleString('ko-KR')}원, 평가액의 ${((MID_AMOUNT / PORTFOLIO) * 100).toFixed(0)}%)이 평상시엔 통과, 위험 창에선 탐지`)

if (failures.length > 0) {
  console.log('\n[실패 항목]')
  for (const f of failures.slice(0, 20)) console.log(`  · ${f}`)
  if (failures.length > 20) console.log(`  · ... 외 ${failures.length - 20}건`)
}

console.log(`\n검증 항목: ${pass}건 통과 / ${fail}건 실패`)
console.log(`판정: ${fail === 0 ? 'PASS' : 'FAIL'}`)
process.exit(fail === 0 ? 0 : 1)
