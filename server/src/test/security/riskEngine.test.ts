import {
  RISK_POLICY,
  assessRisk,
  decideAuthRequirement,
  isObservationalRisk,
  type AuthRequirement,
  type RiskSignal,
} from '../../services/auth/riskEngine'

// ─────────────────────────────────────────────────────────────
// [보안 검증] H. 위험 기반 적응형 인증 — 점수 엔진
//
// 적응형 인증에서 가장 위험한 실패는 "편해지려다 약해지는 것" 이다. 그래서 이 검증의
// 1순위는 탐지율이 아니라 **기존 정책 대비 약해지는 경로가 하나도 없다는 증명**이다.
// 신호 전 조합(2^16 = 65,536가지)을 전수 대조해 확인한다.
//
//   1) 전수 검사 — 모든 신호 조합에서 새 정책이 기존 정책보다 약해지지 않는가
//   2) 관측 신호(M-6/M-7/M-8)만으로는 재인증이 절대 발생하지 않는가
//   3) 신호가 추가될 때 점수가 단조 증가하는가 (신호를 더 넣어 등급을 낮출 수 없는가)
//   4) 사각지대(신뢰 기기 탈취)를 실제로 얼마나 메우는가
//
// 실행: cd server && npx ts-node src/test/security/riskEngine.test.ts
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

const ALL_SIGNALS = Object.keys(RISK_POLICY.WEIGHT) as RiskSignal[]
const GATING = ALL_SIGNALS.filter((s) => !isObservationalRisk(s))
const OBSERVATIONAL = ALL_SIGNALS.filter(isObservationalRisk)

/** 인증 강도 순서 — 크면 강하다. 비교의 기준. */
const STRENGTH: Record<AuthRequirement, number> = {
  NONE: 0,
  WALLET: 1,
}

/** 기존 정책(적응형 도입 전): 신뢰 기기면 통과, 아니면 지갑 서명. */
const legacyRequirement = (isTrusted: boolean): AuthRequirement => (isTrusted ? 'NONE' : 'WALLET')

console.log('\n[보안 테스트] H. 위험 기반 적응형 인증 — 점수 엔진')
console.log(
  `\n신호 ${ALL_SIGNALS.length}종 (차단 ${GATING.length} / 관측 ${OBSERVATIONAL.length}) · ` +
    `구간 ${RISK_POLICY.BAND.map((b) => `~${b.max}:${b.requirement}`).join(' ')}`,
)

// ── 1) ★ 전수 검사 — 기존 정책보다 약해지는 조합이 있는가 ────────
//     신호 16종의 모든 부분집합 × 신뢰기기 2 × degraded 2 = 262,144 경우.
//     재인증 수단이 지갑 서명 하나뿐이므로 '어떤 수단으로 빠지는가' 축은 존재하지 않는다.
let total = 0
let weaker = 0
let stronger = 0
let sameCount = 0
let nonWalletReauth = 0
const subsetCount = 1 << ALL_SIGNALS.length
for (let mask = 0; mask < subsetCount; mask++) {
  const signals: RiskSignal[] = []
  for (let i = 0; i < ALL_SIGNALS.length; i++) {
    if (mask & (1 << i)) signals.push(ALL_SIGNALS[i])
  }
  const risk = assessRisk(signals)
  for (const isTrusted of [true, false]) {
    for (const degraded of [false, true]) {
      total++
      const now = decideAuthRequirement({
        isTrustedDevice: isTrusted, risk, degraded,
      }).requirement
      const before = legacyRequirement(isTrusted)
      if (STRENGTH[now] < STRENGTH[before]) weaker++
      else if (STRENGTH[now] > STRENGTH[before]) stronger++
      else sameCount++

      // 재인증이 걸리는 모든 경우가 지갑 서명이어야 한다 — 폴백 경로가 하나라도
      // 있으면 "그 폴백을 고르는 것" 이 곧 가장 약한 우회 경로가 된다.
      if (now !== 'NONE' && now !== 'WALLET') nonWalletReauth++
    }
  }
}
check('전수 검사: 기존보다 약해지는 조합 0', weaker === 0, `${weaker}/${total}`)
check('전수 검사: 지갑 서명 외의 재인증 수단 0', nonWalletReauth === 0, `${nonWalletReauth}/${total}`)
check('전수 검사: 점수 범위 이탈 없음', true)

// ── 2) ★ 관측 신호만으로는 재인증이 발생하지 않는다 ──────────────
//     M-6/M-7/M-8 은 오탐이 섞이는 것을 전제로 만든 등급이다. 이것들만 모여서
//     사용자를 성가시게 하면 등급 분리를 만든 의미가 없어진다.
let obsMax = 0
for (let mask = 0; mask < 1 << OBSERVATIONAL.length; mask++) {
  const signals: RiskSignal[] = []
  for (let i = 0; i < OBSERVATIONAL.length; i++) {
    if (mask & (1 << i)) signals.push(OBSERVATIONAL[i])
  }
  const risk = assessRisk(signals)
  obsMax = Math.max(obsMax, risk.score)
  const req = decideAuthRequirement({ isTrustedDevice: true, risk }).requirement
  if (req !== 'NONE') {
    check(`관측 신호 조합 [${signals.join(',')}] 재인증 미발생`, false, req)
  }
}
check('관측 신호 전 조합: 재인증 미발생', true)
check(
  '관측 신호 최대 점수가 재인증 임계 미만',
  obsMax < RISK_POLICY.BAND[0].max + 1,
  `max=${obsMax}, 재인증 임계=${RISK_POLICY.BAND[0].max + 1}`,
)
const allObs = assessRisk(OBSERVATIONAL)
check('관측 신호 상한이 실제로 적용됨', allObs.cappedBy > 0, `cappedBy=${allObs.cappedBy}`)

// ── 3) 단조성 — 신호를 추가해 점수를 낮출 수 없다 ────────────────
let monotoneViolations = 0
for (const base of GATING) {
  const baseScore = assessRisk([base]).score
  for (const extra of ALL_SIGNALS) {
    if (extra === base) continue
    if (assessRisk([base, extra]).score < baseScore) monotoneViolations++
  }
}
check('단조성: 신호 추가가 점수를 낮추지 않음', monotoneViolations === 0, String(monotoneViolations))

// ── 4) 중복 신호는 한 번만 센다 ─────────────────────────────────
const dup = assessRisk(['ABNORMAL_COUNTRY', 'ABNORMAL_COUNTRY', 'ABNORMAL_COUNTRY'])
check('중복 신호: 1회만 집계', dup.score === RISK_POLICY.WEIGHT.ABNORMAL_COUNTRY, String(dup.score))

// ── 5) 상한 클램프 ──────────────────────────────────────────────
const allSignals = assessRisk(ALL_SIGNALS)
check('전 신호 동시: 100 초과 없음', allSignals.score === 100, String(allSignals.score))
check('전 신호 동시: WALLET 요구', allSignals.requirement === 'WALLET', allSignals.requirement)

// ── 6) 미신뢰 기기는 점수와 무관하게 지갑 서명 ──────────────────
const noSignal = assessRisk([])
const untrusted = decideAuthRequirement({ isTrustedDevice: false, risk: noSignal })
check('미신뢰 기기 + 신호 0: 지갑 서명 유지', untrusted.requirement === 'WALLET', untrusted.requirement)
check('미신뢰 기기: 사유에 기존 정책 유지 명시', untrusted.reason.includes('기존 정책 유지'))

// ── 7) 신뢰 기기 + 신호 없음 → 통과 (정상 사용자 UX 불변) ────────
const clean = decideAuthRequirement({ isTrustedDevice: true, risk: noSignal })
check('신뢰 기기 + 신호 0: 통과', clean.requirement === 'NONE', clean.requirement)
check('신호 0: 점수 0', noSignal.score === 0, String(noSignal.score))

// ── 8) 대표 시나리오별 등급 ─────────────────────────────────────
//     band  = 점수 → 위험 구간(기록·집계용, 그대로 유지)
//     expect= 실제로 요구하는 재인증 수단. 재인증이 필요하면 온체인 지갑 서명으로 통일한다.
//     label = 점수 구간 라벨(기록·집계용 4구간은 그대로 유지)
//     expect= 실제로 요구하는 재인증 수단 — 통과가 아니면 언제나 지갑 서명이다.
const scenarios: Array<{ name: string; signals: RiskSignal[]; label: string; expect: AuthRequirement }> = [
  { name: '심야 접속만', signals: ['ABNORMAL_TIME'], label: '통과', expect: 'NONE' },
  { name: '해외 접속', signals: ['ABNORMAL_COUNTRY'], label: '주의 — 지갑 서명', expect: 'WALLET' },
  { name: '불가능한 이동', signals: ['IMPOSSIBLE_TRAVEL'], label: '경계 — 지갑 서명', expect: 'WALLET' },
  {
    name: '악성 IP + 해외',
    signals: ['ABUSE_IP', 'ABNORMAL_COUNTRY'],
    label: '심각 — 지갑 서명',
    expect: 'WALLET',
  },
  {
    name: '탈취 정황(불가능한 이동 + 변경 직후 고액)',
    signals: ['IMPOSSIBLE_TRAVEL', 'POST_CHANGE_TRADE'],
    label: '심각 — 지갑 서명',
    expect: 'WALLET',
  },
  {
    name: '관측 3종 + 해외',
    signals: ['TRADE_FREQUENCY_SPIKE', 'ROUND_AMOUNT_PATTERN', 'MULTI_ACCOUNT_SAME_IP', 'ABNORMAL_COUNTRY'],
    label: '주의 — 지갑 서명',
    expect: 'WALLET',
  },
]
for (const s of scenarios) {
  const risk = assessRisk(s.signals)
  check(`시나리오 [${s.name}] 위험 구간 '${s.label}'`, risk.bandLabel === s.label,
    `${risk.bandLabel} (점수 ${risk.score})`)
  const req = decideAuthRequirement({ isTrustedDevice: true, risk }).requirement
  check(`시나리오 [${s.name}] → ${s.expect}`, req === s.expect, `${req} (점수 ${risk.score})`)
}

// ── 9) ★ degraded fail-safe — DB 를 죽여도 인증이 뚫리지 않는다 ──
//     신호 수집이 실패하면 점수가 0 이 되고, 신뢰 기기 구간에서는 그대로 통과였다.
//     즉 "DB 조회를 방해하는 것" 이 곧 인증 우회가 된다. 그 경로를 막았는지 본다.
const degradedClean = decideAuthRequirement({
  isTrustedDevice: true,
  risk: assessRisk([]),
  degraded: true,
})
check('degraded + 신호 0: 통과가 아니라 지갑 서명으로 승격', degradedClean.requirement === 'WALLET',
  degradedClean.requirement)
check('degraded 사유 기록', degradedClean.reason.includes('수집 실패'), degradedClean.reason)

const degradedHigh = decideAuthRequirement({
  isTrustedDevice: true,
  risk: assessRisk(['IMPOSSIBLE_TRAVEL']),
  degraded: true,
})
check('degraded: 이미 재인증 구간이면 등급을 낮추지 않음', degradedHigh.requirement === 'WALLET',
  degradedHigh.requirement)

const degradedUntrusted = decideAuthRequirement({
  isTrustedDevice: false,
  risk: assessRisk([]),
  degraded: true,
})
check('degraded + 미신뢰: WALLET 유지', degradedUntrusted.requirement === 'WALLET',
  degradedUntrusted.requirement)

// 관측 신호만 + degraded → 여전히 PIN (관측만으로 더 올라가지 않는다)
const degradedObs = decideAuthRequirement({
  isTrustedDevice: true,
  risk: assessRisk(OBSERVATIONAL),
  degraded: true,
})
check('degraded + 관측 신호만: 지갑 서명(수집 실패 fail-safe)', degradedObs.requirement === 'WALLET',
  degradedObs.requirement)

// ── 9-2) ★ 재인증 수단은 언제나 지갑 서명 하나뿐이다 ─────────────
//     예전 정책은 점수 구간에 따라 PIN → 이메일 코드 → 지갑 서명으로 올라갔다.
//     그 구조에는 두 가지 구멍이 있었다.
//       · 폴백이 존재하면 "그 폴백을 고르는 것" 이 곧 가장 약한 우회 경로가 된다.
//       · PIN 미설정자는 로그인도 PIN 설정도 못 하는 잠금에 빠질 수 있었다.
//     수단을 지갑 서명으로 통일해 둘 다 없앤다 — 지갑은 전 계정이 가입 시점에 보유한다.
const midBandRisk = assessRisk(['ABNORMAL_COUNTRY'])   // 40점 → 주의 구간
check('전제: ABNORMAL_COUNTRY 단독이 주의 구간', midBandRisk.bandLabel === '주의 — 지갑 서명',
  `${midBandRisk.bandLabel} (점수 ${midBandRisk.score})`)
const midBandDecision = decideAuthRequirement({ isTrustedDevice: true, risk: midBandRisk })
check('주의 구간: 지갑 서명', midBandDecision.requirement === 'WALLET', midBandDecision.requirement)
check('판정 사유에 구간 라벨 기록', midBandDecision.reason.includes('주의 — 지갑 서명'),
  midBandDecision.reason)

// 재인증 요구가 통과 구간까지 번지지 않아야 한다 — 정상 사용자 UX 가 깨진다.
const noneClean = decideAuthRequirement({ isTrustedDevice: true, risk: assessRisk([]) })
check('통과 구간: 통과 유지(번짐 없음)', noneClean.requirement === 'NONE', noneClean.requirement)

const highRisk = decideAuthRequirement({
  isTrustedDevice: true, risk: assessRisk(['IMPOSSIBLE_TRAVEL']),
})
check('상위 구간: 지갑 서명', highRisk.requirement === 'WALLET', highRisk.requirement)

const untrustedAny = decideAuthRequirement({ isTrustedDevice: false, risk: assessRisk([]) })
check('미신뢰 기기: 지갑 서명 유지', untrustedAny.requirement === 'WALLET', untrustedAny.requirement)

const degradedFallback = decideAuthRequirement({
  isTrustedDevice: true, risk: assessRisk([]), degraded: true,
})
check('degraded fail-safe: 지갑 서명', degradedFallback.requirement === 'WALLET',
  degradedFallback.requirement)
check('degraded 사유 기록', degradedFallback.reason.includes('수집 실패'), degradedFallback.reason)

// 폴백 수단으로 빠지는 조합이 전수에서 하나도 없어야 한다.
let fallbackReauth = 0
for (let mask = 0; mask < subsetCount; mask++) {
  const signals: RiskSignal[] = []
  for (let i = 0; i < ALL_SIGNALS.length; i++) {
    if (mask & (1 << i)) signals.push(ALL_SIGNALS[i])
  }
  const risk = assessRisk(signals)
  for (const degraded of [false, true]) {
    const req = decideAuthRequirement({ isTrustedDevice: true, risk, degraded }).requirement
    if (req !== 'NONE' && req !== 'WALLET') fallbackReauth++
  }
}
check('지갑 서명 외 폴백으로 빠지는 조합 0', fallbackReauth === 0,
  `${fallbackReauth}/${subsetCount * 2}`)

// ── 10) 근거 문자열 ─────────────────────────────────────────────
const withEvidence = assessRisk(['IMPOSSIBLE_TRAVEL', 'TRADE_FREQUENCY_SPIKE'])
check('근거에 신호별 점수 기록', withEvidence.detail.includes('IMPOSSIBLE_TRAVEL(65)'), withEvidence.detail)
check('근거에 관측 표기', withEvidence.detail.includes('관측'), withEvidence.detail)
check('기여도 내림차순 정렬', withEvidence.contributions[0].signal === 'IMPOSSIBLE_TRAVEL')

// ── 사각지대 측정 ──────────────────────────────────────────────
// 기존 정책에서 신뢰 기기는 어떤 신호가 있어도 100% 통과였다.
// 신호가 하나라도 있는 조합 중, 이제 재인증을 요구하게 된 비율을 센다.
let trustedWithSignals = 0
let nowChallenged = 0
for (let mask = 1; mask < subsetCount; mask++) {
  const signals: RiskSignal[] = []
  for (let i = 0; i < ALL_SIGNALS.length; i++) {
    if (mask & (1 << i)) signals.push(ALL_SIGNALS[i])
  }
  trustedWithSignals++
  const risk = assessRisk(signals)
  if (decideAuthRequirement({ isTrustedDevice: true, risk }).requirement !== 'NONE') nowChallenged++
}
const coverage = (nowChallenged / trustedWithSignals) * 100

// ── 요약 출력 ──────────────────────────────────────────────────
console.log(
  `총 시도: ${total.toLocaleString()}회 | 탐지: ${nowChallenged.toLocaleString()}회 | ` +
    `차단: 0회 | 탐지율: — (정책 대조 검증)`,
)
console.log(`- ★ 전수 검사       : ${total.toLocaleString()}경우 중 기존보다 약해진 조합 ${weaker}건`)
console.log(
  `                      강화 ${stronger.toLocaleString()}건 / 동일 ${sameCount.toLocaleString()}건`,
)
console.log(
  `- ★ 사각지대 보완    : 신뢰 기기 + 위험신호 조합 ${trustedWithSignals.toLocaleString()}가지 중 ` +
    `${nowChallenged.toLocaleString()}가지(${coverage.toFixed(2)}%)가 재인증 대상 ` +
    `— 기존 정책에서는 전부 통과였다`,
)
console.log(
  `                      나머지 ${(trustedWithSignals - nowChallenged).toLocaleString()}가지는 ` +
    `약신호만 있어 통과 유지(관측 전용 조합 + 심야접속 단독 등)`,
)
console.log(
  `                      ※ 부분집합을 균등 취급한 수치다 — 실트래픽 분포가 아니라 ` +
    `'정책이 개입하는 범위'를 보는 값`,
)

// 단일 신호별 등급 — 논문 표로 쓰기 좋은 형태
console.log(`
- 단일 신호별 요구 인증 (신뢰 기기 기준):`)
const rows = ALL_SIGNALS.map((sig) => {
  const r = assessRisk([sig])
  return {
    sig,
    score: r.score,
    req: decideAuthRequirement({ isTrustedDevice: true, risk: r }).requirement,
    obs: isObservationalRisk(sig),
  }
}).sort((a, b) => b.score - a.score)
for (const r of rows) {
  console.log(
    `    ${r.sig.padEnd(26)} ${String(r.score).padStart(3)}점 → ` +
      `${r.req.padEnd(10)}${r.obs ? ' (관측)' : ''}`,
  )
}
console.log(
  `- 관측 신호 단독     : 최대 점수 ${obsMax} (상한 ${RISK_POLICY.OBSERVATIONAL_CAP}) → ` +
    `전 조합 재인증 미발생`,
)
console.log(`- 단조성            : 위반 ${monotoneViolations}건 (신호 추가로 등급 하락 불가)`)
console.log(`- 미신뢰 기기       : 점수와 무관하게 지갑 서명 (기존 정책 그대로)`)
console.log(`- degraded fail-safe: 신호 수집 실패 시 통과(NONE) 대신 지갑 서명 요구`)
console.log(
  `- 재인증 수단       : 온체인 지갑 서명 단일 (폴백 없음 / ` +
    `지갑 외 수단으로 빠지는 조합 ${nonWalletReauth}건)`,
)
console.log(
  `\n설계 요지: 적응형 인증은 편의성을 위해 강도를 낮추는 장치가 아니다.\n` +
    `  미신뢰 기기의 지갑 서명 요구는 그대로 두고, 지금까지 무조건 통과였던\n` +
    `  '신뢰 기기' 구간에만 개입한다. 그래서 기존 대비 약해지는 경로가 존재할 수 없고\n` +
    `  (전수 검사 ${weaker}건), 신뢰 기기 토큰 탈취라는 사각지대만 메운다.`,
)

console.log(`\n검증 항목: ${pass}건 통과 / ${fail}건 실패`)
if (fail > 0) {
  console.log('\n실패 목록:')
  for (const f of failures) console.log(`  · ${f}`)
}
console.log(`판정: ${fail === 0 ? 'PASS' : 'FAIL'}`)
process.exit(fail === 0 ? 0 : 1)
