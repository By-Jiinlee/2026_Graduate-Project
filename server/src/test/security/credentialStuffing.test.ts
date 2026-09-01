export {} // 이 파일을 모듈로 만들어 전역 스코프 변수 충돌을 막는다
// ─────────────────────────────────────────────────────────────
// [보안 검증] 크리덴셜 스터핑 (M-5) — 거래 인증 반복 실패 후 성공
//
// 배경: 무차별 대입 방어는 "실패"를 센다. 그런데 크리덴셜 스터핑의 본질은 **결국
// 성공한다**는 것이다. 성공한 순간 기존 규칙은 카운터를 지우고 조용해진다 —
// 가장 위험한 시점에 아무 기록도 남지 않는다.
// 이 규칙은 반대로 성공 시점에 직전 실패 이력을 조회해 고위험으로 태깅한다.
//
// 오탐이 이 규칙의 최대 난제다. PIN 을 몇 번 틀리는 것은 정당한 사용자에게 흔한 일이라
// 단순히 "실패 후 성공"을 잡으면 오탐 덩어리가 된다. 그래서 세 신호로 구분한다.
//   A. 짧은 창에서 잠금 직전까지 밀어붙인 뒤 성공 (30분 내 4회 이상 — PIN 잠금 임계가 5회)
//   B. 실패가 서로 다른 IP 2곳 이상          ← 사람은 보통 한 자리에서 입력한다
//   C. 잠금 주기를 넘겨가며 누적 실패 후 성공 (24시간 8회 이상, low-and-slow)
//
// 판정 로직을 그대로 재현해 검증한다. DB·서버를 쓰지 않는 결정적 검증이다.
// 실행: cd server && npx ts-node src/test/security/credentialStuffing.test.ts
// ─────────────────────────────────────────────────────────────

const POLICY = {
  SHORT_WINDOW_MS: 30 * 60 * 1000,
  SHORT_MIN_FAILURES: 4,
  LONG_WINDOW_MS: 24 * 60 * 60 * 1000,
  LONG_MIN_FAILURES: 8,
  DISTINCT_IP_MIN: 2,
} as const

interface Attempt { success: boolean; ip: string; at: number }
type Verdict = 'NONE' | 'WEAK' | 'STRONG'

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass++
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`) }
}

/**
 * 서비스의 detectCredentialStuffing 판정을 그대로 재현한다.
 * history 는 시간 오름차순이며, 마지막 항목이 방금 발생한 성공이다.
 */
function evaluate(history: Attempt[], now: number): { verdict: Verdict; streak: number; ips: number; short: number } {
  const recent = [...history].reverse() // 최신순

  // 직전 성공 이후의 실패만 센다. 성공으로 한 번 끊긴 뒤의 오타는 이번 성공과 무관하다.
  const streak: Attempt[] = []
  let skippedOwnSuccess = false
  for (const a of recent) {
    if (a.at < now - POLICY.LONG_WINDOW_MS) break
    if (a.success) {
      if (!skippedOwnSuccess) { skippedOwnSuccess = true; continue } // 방금 이번 성공
      break
    }
    streak.push(a)
  }

  if (streak.length === 0) return { verdict: 'NONE', streak: 0, ips: 0, short: 0 }

  const shortStart = now - POLICY.SHORT_WINDOW_MS
  const short = streak.filter((a) => a.at >= shortStart).length
  const ips = new Set(streak.map((a) => a.ip)).size

  const signalA = short >= POLICY.SHORT_MIN_FAILURES
  const signalB = ips >= POLICY.DISTINCT_IP_MIN
  const signalC = streak.length >= POLICY.LONG_MIN_FAILURES

  if (!signalA && !signalB && !signalC) return { verdict: 'NONE', streak: streak.length, ips, short }
  return { verdict: signalB || signalC ? 'STRONG' : 'WEAK', streak: streak.length, ips, short }
}

const NOW = 1_700_000_000_000
const min = (m: number) => m * 60_000
const hour = (h: number) => h * 3_600_000

// 헬퍼 — 실패 n회를 간격 gap(ms)으로 만들고 마지막에 성공을 붙인다
function build(fails: Array<{ ip: string; ago: number }>, successIp = '1.1.1.1'): Attempt[] {
  const list: Attempt[] = fails.map((f) => ({ success: false, ip: f.ip, at: NOW - f.ago }))
  list.push({ success: true, ip: successIp, at: NOW })
  return list.sort((a, b) => a.at - b.at)
}

// ─────────────────────────────────────────────
// 1) 공격 시나리오 — 탐지돼야 한다
// ─────────────────────────────────────────────
const ATTACKS: Array<[string, Attempt[], Verdict]> = [
  [
    '잠금 직전까지 밀어붙인 뒤 성공 (30분 내 4회, 단일 IP)',
    build([{ ip: '1.1.1.1', ago: min(20) }, { ip: '1.1.1.1', ago: min(15) },
           { ip: '1.1.1.1', ago: min(10) }, { ip: '1.1.1.1', ago: min(5) }]),
    'WEAK',
  ],
  [
    '분산 시도 — 서로 다른 IP 2곳에서 실패 후 성공',
    build([{ ip: '203.0.113.5', ago: min(10) }, { ip: '198.51.100.9', ago: min(4) }]),
    'STRONG',
  ],
  [
    '봇넷 — IP 5곳에서 각 1회씩 실패 후 성공',
    build([{ ip: '203.0.113.1', ago: min(25) }, { ip: '203.0.113.2', ago: min(20) },
           { ip: '203.0.113.3', ago: min(15) }, { ip: '203.0.113.4', ago: min(10) },
           { ip: '203.0.113.5', ago: min(5) }]),
    'STRONG',
  ],
  [
    'low-and-slow — 24시간에 걸쳐 8회 실패 후 성공 (잠금 주기 회피)',
    build(Array.from({ length: 8 }, (_, i) => ({ ip: '1.1.1.1', ago: hour(20 - i * 2) }))),
    'STRONG',
  ],
  [
    '잠금 해제 직후 재개 — 30분 창에 4회 + 이전 창에 4회',
    build([...Array.from({ length: 4 }, (_, i) => ({ ip: '1.1.1.1', ago: hour(2) + min(i) })),
           ...Array.from({ length: 4 }, (_, i) => ({ ip: '1.1.1.1', ago: min(25 - i * 5) }))]),
    'STRONG',
  ],
  [
    // 실패가 모두 한 IP 라 신호 B(분산)는 서지 않는다. 신호 A 단독이므로 '주의' 등급이
    // 맞다 — 정당한 사용자가 한 자리에서 4번 틀린 경우와 구별되지 않기 때문이다.
    // (실패 IP ≠ 성공 IP 를 추가 신호로 쓸 수 있으나, 모바일 캐리어 NAT 로 IP 가 바뀌는
    //  정상 사용자를 오탐할 위험이 있어 현재는 채택하지 않았다 — 한계로 기록)
    '세션 탈취 후 PIN 추측 — 단일 IP 에서 4회 실패 후 성공',
    build(Array.from({ length: 4 }, (_, i) => ({ ip: '203.0.113.77', ago: min(20 - i * 4) }))),
    'WEAK',
  ],
]

let detected = 0
let strongCorrect = 0
for (const [label, history, expected] of ATTACKS) {
  const r = evaluate(history, NOW)
  const ok = r.verdict !== 'NONE'
  if (ok) detected++
  if (r.verdict === expected) strongCorrect++
  check(`공격 탐지: ${label}`, ok, `실패연속 ${r.streak} · IP ${r.ips} · 30분내 ${r.short} → ${r.verdict}`)
  check(`  등급 정확: ${label}`, r.verdict === expected, `기대 ${expected} / 실제 ${r.verdict}`)
}

// ─────────────────────────────────────────────
// 2) 정상 시나리오 — 오탐률(FPR). 이 규칙의 성패가 갈리는 지점.
// ─────────────────────────────────────────────
const NORMALS: Array<[string, Attempt[]]> = [
  ['오타 1회 후 성공',                    build([{ ip: '1.1.1.1', ago: min(1) }])],
  ['오타 2회 후 성공',                    build([{ ip: '1.1.1.1', ago: min(2) }, { ip: '1.1.1.1', ago: min(1) }])],
  ['오타 3회 후 성공 (잠금 임계 미만)',   build([{ ip: '1.1.1.1', ago: min(3) }, { ip: '1.1.1.1', ago: min(2) },
                                                { ip: '1.1.1.1', ago: min(1) }])],
  ['실패 없이 성공',                      build([])],
  ['어제 3회 틀렸고 오늘 한 번에 성공',   build([{ ip: '1.1.1.1', ago: hour(20) }, { ip: '1.1.1.1', ago: hour(19) },
                                                { ip: '1.1.1.1', ago: hour(18) }])],
  ['24시간 밖 실패는 무시 (30시간 전 6회)', build(Array.from({ length: 6 }, (_, i) => ({ ip: '1.1.1.1', ago: hour(30 + i) })))],
]

let falsePositives = 0
for (const [label, history] of NORMALS) {
  const r = evaluate(history, NOW)
  const ok = r.verdict === 'NONE'
  if (!ok) falsePositives++
  check(`정상 통과: ${label}`, ok, `실패연속 ${r.streak} · IP ${r.ips} → ${r.verdict}`)
}

// ─────────────────────────────────────────────
// 3) 연속 실패 절단 — 직전 "성공"이 카운터를 끊는가
//
// 이게 없으면 하루 종일 쌓인 오타가 다음 성공 때마다 계속 재탐지된다(반복 오탐).
// ─────────────────────────────────────────────
// 과거에 8회를 틀렸다가 성공한 이력이 있고(그때 이미 탐지·경보됨), 그 뒤 오늘 1회
// 틀리고 성공한 상황. 절단이 없으면 누적 9회로 다시 STRONG 이 떠 같은 사건이 반복 경보된다.
const CUT_AT = NOW - hour(2)
const withPriorSuccess: Attempt[] = [
  ...Array.from({ length: 8 }, (_, i) => ({ success: false, ip: '1.1.1.1', at: NOW - hour(20 - i * 2) })),
  { success: true,  ip: '1.1.1.1', at: CUT_AT },   // ← 여기서 끊겨야 한다
  { success: false, ip: '1.1.1.1', at: NOW - min(3) },
  { success: true,  ip: '1.1.1.1', at: NOW },
]
const cut = evaluate(withPriorSuccess, NOW)
check('직전 성공이 실패 연속을 끊음', cut.streak === 1, `연속 ${cut.streak}건 (기대 1)`)
check('끊긴 뒤에는 미탐지', cut.verdict === 'NONE', cut.verdict)

// 절단이 없었다면 같은 사건이 반복 탐지됐을 것임을 대조로 보인다
const withoutCut = evaluate(withPriorSuccess.filter((a) => a.at !== CUT_AT), NOW)
check('[대조군] 절단 없으면 반복 오탐 발생', withoutCut.verdict !== 'NONE', `${withoutCut.streak}건 → ${withoutCut.verdict}`)

// ─────────────────────────────────────────────
// 4) 임계 경계
// ─────────────────────────────────────────────
const b3 = build(Array.from({ length: 3 }, (_, i) => ({ ip: '1.1.1.1', ago: min(10 - i) })))
const b4 = build(Array.from({ length: 4 }, (_, i) => ({ ip: '1.1.1.1', ago: min(10 - i) })))
check('30분 창 실패 3회 → 미탐(경계 아래)', evaluate(b3, NOW).verdict === 'NONE')
check('30분 창 실패 4회 → 탐지(경계 도달)', evaluate(b4, NOW).verdict === 'WEAK')

const ip1 = build([{ ip: '1.1.1.1', ago: min(5) }])
const ip2 = build([{ ip: '1.1.1.1', ago: min(6) }, { ip: '2.2.2.2', ago: min(5) }])
check('단일 IP 실패 1회 → 미탐', evaluate(ip1, NOW).verdict === 'NONE')
check('서로 다른 IP 2곳 → 즉시 STRONG(횟수 무관)', evaluate(ip2, NOW).verdict === 'STRONG')

const long7 = build(Array.from({ length: 7 }, (_, i) => ({ ip: '1.1.1.1', ago: hour(20 - i * 2) })))
const long8 = build(Array.from({ length: 8 }, (_, i) => ({ ip: '1.1.1.1', ago: hour(20 - i * 2) })))
check('24시간 누적 7회 → 미탐(경계 아래)', evaluate(long7, NOW).verdict === 'NONE', `${evaluate(long7, NOW).streak}건`)
check('24시간 누적 8회 → STRONG(경계 도달)', evaluate(long8, NOW).verdict === 'STRONG')

// ─────────────────────────────────────────────
// 결과 출력
// ─────────────────────────────────────────────
const totalAttempts = ATTACKS.length + NORMALS.length
const fpr = (falsePositives / NORMALS.length) * 100

console.log('')
console.log('[보안 테스트] 크리덴셜 스터핑 (M-5) — 거래 인증 반복 실패 후 성공')
console.log(`총 시도: ${totalAttempts}회 | 탐지: ${detected}회 | 차단: 0회(ALERT 정책) | 탐지율: ${((detected / ATTACKS.length) * 100).toFixed(0)}%`)
console.log(`- 공격 탐지          : ${detected}/${ATTACKS.length} (등급 정확 ${strongCorrect}/${ATTACKS.length})`)
console.log(`- 정상 사용자 오탐   : ${falsePositives}/${NORMALS.length} (오탐률 ${fpr.toFixed(1)}%) — 오타 1~3회 후 성공 포함`)
console.log(`- 신호 구분          : A 30분내 ${POLICY.SHORT_MIN_FAILURES}회↑ = 주의 · B IP ${POLICY.DISTINCT_IP_MIN}곳↑ / C 24h ${POLICY.LONG_MIN_FAILURES}회↑ = 고위험`)
console.log(`- 연속 절단          : 직전 성공이 카운터를 끊음 (대조군: 절단 없으면 반복 오탐)`)
console.log(`- 임계 경계          : 3회 미탐 / 4회 탐지 · 누적 7회 미탐 / 8회 탐지`)
console.log(`- [설계 근거] PIN 잠금 임계가 5회이므로 4회는 "잠금 직전까지 밀어붙인" 상태다`)
console.log(`- [정책] 성공을 되돌리지 않는다 — 정당한 사용자의 오타를 자산 접근 차단으로 처벌할 수 없다`)

if (failures.length > 0) {
  console.log('\n[실패 항목]')
  for (const f of failures.slice(0, 20)) console.log(`  · ${f}`)
  if (failures.length > 20) console.log(`  · ... 외 ${failures.length - 20}건`)
}

console.log(`\n검증 항목: ${pass}건 통과 / ${fail}건 실패`)
console.log(`판정: ${fail === 0 ? 'PASS' : 'FAIL'}`)
process.exit(fail === 0 ? 0 : 1)
