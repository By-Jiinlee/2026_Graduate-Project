import { judgeConcurrentSession } from '../../services/auth/anomalyService'

// ─────────────────────────────────────────────────────────────
// [보안 검증] 동시 다중 세션(CONCURRENT_SESSION) — 판정 기준 정정
//
// 배경: 논문 6.3 은 "30분 내 동일 계정 3개 이상 IP" 를 경보 기준으로 적었지만, 실제 코드는
//   "현재 IP 가 최근 30분 로그인 기록에 없으면" 경보였다. 로그인 기록은 2단계 성공 뒤에야 쌓이므로
//   30분 만의 첫 로그인은 기록이 비어 있어 매번 '새 IP' 경보가 났다. 운영 DB 의 CONCURRENT_SESSION
//   166건 중 145건이 "기존 활성 IP: []"(다른 세션 0개)였다. 이 신호는 위험 점수 30점이라
//   심야 접속(15점)과 겹치면 신뢰 기기에서도 지갑 서명을 요구하게 된다.
//
// 확인하려는 것
//   (1) 서로 다른 IP 3개 이상(현재 포함)이면 탐지한다
//   (2) 첫 로그인·같은 IP 재로그인·IP 2개(집↔모바일 전환)는 경보하지 않는다
//   (3) 표기 차이(::ffff: 매핑, 대소문자, 공백)·중복·unknown 이 IP 수를 부풀리지 않는다
//   (4) 대조군: 수정 전 규칙은 같은 입력에서 어떤 정상 시나리오를 오탐하는가
//
// 판정 함수를 직접 호출하는 결정적 검증이다. DB·서버·외부 API 를 쓰지 않는다.
// 실행: cd server && npx ts-node src/test/security/concurrentSession.test.ts
// ─────────────────────────────────────────────────────────────

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass++
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`) }
}

// 수정 전 판정 재현(대조군) — anomalyService 이전 버전과 같은 식.
function legacyDetect(recentIps: string[], currentIp: string, maxIps = 3): boolean {
  const isNewIp = !recentIps.includes(currentIp)
  return !(recentIps.length < maxIps && !isNewIp)
}

type Scenario = { name: string; kind: 'attack' | 'normal'; recent: string[]; current: string }

const SCENARIOS: Scenario[] = [
  // ── 공격: 같은 계정이 짧은 시간에 여러 위치에서 쓰인다 ──
  { name: '탈취: 기존 2개 IP + 새 IP', kind: 'attack', recent: ['211.1.1.1', '175.2.2.2'], current: '45.3.3.3' },
  { name: '자격 공유: 4개 IP 순환', kind: 'attack', recent: ['211.1.1.1', '175.2.2.2', '45.3.3.3'], current: '98.4.4.4' },
  { name: '현재 IP 가 이미 기록된 3개 IP 중 하나', kind: 'attack', recent: ['211.1.1.1', '175.2.2.2', '45.3.3.3'], current: '175.2.2.2' },
  { name: '프록시 로테이션 6개 IP', kind: 'attack', recent: ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4', '5.5.5.5'], current: '6.6.6.6' },
  { name: 'IPv6 혼재 3개 주소', kind: 'attack', recent: ['2001:db8::1', '211.1.1.1'], current: '2001:db8::2' },
  // ── 정상 ──
  { name: '30분 만의 첫 로그인(기록 없음)', kind: 'normal', recent: [], current: '211.1.1.1' },
  { name: '같은 IP 재로그인', kind: 'normal', recent: ['211.1.1.1'], current: '211.1.1.1' },
  { name: '집 Wi-Fi → 모바일 전환(2개)', kind: 'normal', recent: ['211.1.1.1'], current: '223.38.5.5' },
  { name: '노트북·휴대폰 동시 사용(2개)', kind: 'normal', recent: ['211.1.1.1', '223.38.5.5'], current: '223.38.5.5' },
  { name: '::ffff: 매핑 표기 차이 + 1개(실제 2개)', kind: 'normal', recent: ['::ffff:211.1.1.1', '223.38.5.5'], current: '211.1.1.1' },
  { name: 'IPv6 대소문자·공백 차이(실제 2개)', kind: 'normal', recent: ['2001:DB8::1 ', '211.1.1.1'], current: '2001:db8::1' },
  { name: 'unknown 기록 혼입(실제 2개)', kind: 'normal', recent: ['unknown', '211.1.1.1'], current: '223.38.5.5' },
  { name: '로컬 개발(::1 → ::1)', kind: 'normal', recent: ['::1'], current: '::1' },
]

let attacks = 0, detected = 0, normals = 0, falsePos = 0, legacyFalsePos = 0, legacyDetected = 0
for (const s of SCENARIOS) {
  const v = judgeConcurrentSession(s.recent, s.current)
  const legacy = legacyDetect(s.recent, s.current)
  if (s.kind === 'attack') {
    attacks++
    if (v.detected) detected++
    if (legacy) legacyDetected++
    check(`[공격] ${s.name} → 탐지`, v.detected, `IP ${v.distinctIps.length}개`)
  } else {
    normals++
    if (v.detected) falsePos++
    if (legacy) legacyFalsePos++
    check(`[정상] ${s.name} → 미경보`, !v.detected, `IP ${v.distinctIps.length}개`)
  }
}

// ── 경계값: 정확히 2개는 미탐, 3개는 탐지 ──
check('경계: 2개 IP → 미탐', !judgeConcurrentSession(['1.1.1.1'], '2.2.2.2').detected)
check('경계: 3개 IP → 탐지', judgeConcurrentSession(['1.1.1.1', '2.2.2.2'], '3.3.3.3').detected)
check('경계: 임계 파라미터 4 → 3개 IP 미탐', !judgeConcurrentSession(['1.1.1.1', '2.2.2.2'], '3.3.3.3', 4).detected)

// ── 정규화: 같은 주소의 표기 변형은 1개로 센다 ──
const norm = judgeConcurrentSession(['::ffff:10.0.0.1', '10.0.0.1 ', '10.0.0.1'], '10.0.0.1')
check('정규화: ::ffff:/공백/중복 → 1개', norm.distinctIps.length === 1, norm.distinctIps.join(','))
check('정규화: 순수 IPv6 ::ffff 접두는 IPv4 꼴일 때만 제거', judgeConcurrentSession([], '::ffff:abcd').distinctIps[0] === '::ffff:abcd')

// ── 비정상 입력: 판정이 예외 없이 끝난다 ──
let threw = false
try {
  judgeConcurrentSession([null as unknown as string, undefined as unknown as string, ''], '')
} catch { threw = true }
check('비정상 입력(null·undefined·빈 문자열) → 예외 없음·미탐', !threw && !judgeConcurrentSession([null as unknown as string], '').detected)

// ── 대조군: 수정 전 규칙은 정상 시나리오를 오탐한다 ──
check('대조군: 수정 전 규칙이 "첫 로그인" 을 오탐', legacyDetect([], '211.1.1.1'))
check('대조군: 수정 전 규칙이 "IP 2개 전환" 을 오탐', legacyDetect(['211.1.1.1'], '223.38.5.5'))
check('수정 후 공격 탐지는 수정 전 이상', detected >= legacyDetected, `${detected} vs ${legacyDetected}`)

const pct = (a: number, b: number) => (b === 0 ? '—' : `${((a / b) * 100).toFixed(1)}%`)
console.log('\n[보안 테스트] 동시 다중 세션(CONCURRENT_SESSION)')
console.log(
  `총 시도: ${attacks + normals}회 | 탐지: ${detected}회 | 차단: 0회(경보 신호) | 탐지율: ${pct(detected, attacks)}`,
)
console.log(`- 정상 오탐률       : ${pct(falsePos, normals)} (${falsePos}/${normals})`)
console.log(`- 대조군(수정 전)   : 탐지 ${legacyDetected}/${attacks} · 정상 오탐 ${legacyFalsePos}/${normals} (${pct(legacyFalsePos, normals)})`)
console.log('- 판정 기준         : 30분 창 로그인 IP ∪ 현재 IP 의 서로 다른 개수 ≥ 3')

console.log(`\n검증 항목: ${pass}건 통과 / ${fail}건 실패`)
if (fail > 0) {
  console.log('\n실패 목록:')
  for (const f of failures) console.log(`  · ${f}`)
}
console.log(`판정: ${fail === 0 ? 'PASS' : 'FAIL'}`)
process.exit(fail === 0 ? 0 : 1)
