import axios from 'axios'
import { Op } from 'sequelize'
import sequelize from '../../config/database'
import AnomalyLog from '../../models/auth/AnomalyLog'
import LoginAttempt from '../../models/auth/LoginAttempt'
import User from '../../models/user/User'
import { IP, Res, UA, arg, del, die, get, loginAsTestUser, post } from './testClient'

// ─────────────────────────────────────────────────────────────
// [보안 검증] 계정·인증 보안 — 무차별 대입 방어와 계정 열거 억제 (E2E)
//
// 확인 대상
//   (1) 무차별 대입 임계 : 15분 창에서 이메일 실패 5회 → 계정 잠금,
//                          IP 실패 10회 → IP 차단. 경계(4회)에서는 발동하지 않아야 한다.
//   (2) 잠금의 실효성    : 잠긴 뒤에는 올바른 비밀번호로도 로그인이 되지 않아야 한다.
//   (3) 계정 열거 억제   : 존재하는 계정과 존재하지 않는 계정의 응답이 구별되지 않아야 한다.
//                          응답 메시지뿐 아니라 응답 시간까지 측정한다(타이밍 사이드 채널).
//   (4) 복구 경로        : 관리자 해제 후 정상 로그인이 복구되어야 한다.
//   (5) 오탐            : 정상 자격 증명은 전 구간에서 통과해야 한다.
//
// 부수효과
//   테스트 계정을 실제로 잠그고, 위조 IP(RFC 5737)를 차단 목록에 올린다.
//   종료 시 관리자 API 로 계정 잠금과 IP 차단을 모두 해제하며, 해제 결과까지 검증한다.
//   실사용 계정에 절대 사용하지 말 것.
//
// 실행
//   cd server
//   npx ts-node src/test/security/accountAuth.e2e.test.ts \
//     --email=test@x.com --password=xxxx \
//     --admin-email=admin@x.com --admin-password=xxxx
// ─────────────────────────────────────────────────────────────

const STEP1 = '/api/auth/login/step1'
const ADMIN = '/api/admin/security'

const EMAIL = arg('email')
const PASSWORD = arg('password')
const ADMIN_EMAIL = arg('admin-email')
const ADMIN_PASSWORD = arg('admin-password')

// 각 축을 독립적으로 측정하기 위해 시나리오마다 다른 위조 IP 를 쓴다
// 15분 창에 이전 실행의 실패 기록이 남아 있으면 임계가 미리 채워져 측정이 오염된다.
// 실행마다 다른 위조 IP(RFC 5737 TEST-NET-2)를 뽑아 축을 분리한다.
const octet = () => 1 + Math.floor(Math.random() * 250)
const base = octet()
const IP_ENUM = `198.51.100.${base}`
const IP_LOCK = `198.51.100.${(base % 250) + 1}`
const IP_FLOOD = `198.51.100.${((base + 1) % 250) + 1}`
const IP_OK = `198.51.100.${((base + 7) % 250) + 1}`   // 정상 로그인 — 반복 실행 시 리미터 누적 방지
const IP_ADMIN = `198.51.100.${((base + 11) % 250) + 1}`  // 관리자 세션
const WRONG_PASSWORD = 'WrongPassw0rd!@#'

let pass = 0
let fail = 0
const failures: string[] = []
const notes: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass++; console.log(`  [OK]   ${name}${detail ? ` — ${detail}` : ''}`) }
  else {
    fail++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n─── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`)
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

interface Attempt { res: Res; ms: number }

/** MySQL TINYINT 는 0/1 로 돌아오므로 진리값으로 읽는다 */
async function isLocked(): Promise<boolean> {
  const u = await User.findOne({ where: { email: EMAIL } })
  return Boolean(u?.is_locked)
}

/** 비동기로 반영되는 상태를 최대 5초까지 기다린다 */
async function waitFor(read: () => Promise<boolean>, expected: boolean): Promise<boolean> {
  for (let i = 0; i < 10; i++) {
    const v = await read()
    if (v === expected) return v
    await new Promise((r) => setTimeout(r, 500))
  }
  return read()
}

async function tryLogin(email: string, password: string, ip: string): Promise<Attempt> {
  const t0 = Date.now()
  const res = await post(STEP1, JSON.stringify({ email, password }), { ip })
  return { res, ms: Date.now() - t0 }
}

const messageOf = (a: Attempt): string => String(a.res.data?.message ?? '')

async function main(): Promise<void> {
  if (!EMAIL || !PASSWORD) {
    die('사용법: --email=... --password=... [--admin-email=... --admin-password=...]')
  }
  await sequelize.authenticate().catch(() => die('DB 연결 실패 — server/.env 확인'))

  const user = await User.findOne({ where: { email: EMAIL } })
  if (!user) die(`테스트 계정을 찾을 수 없습니다: ${EMAIL}`)
  if (user.is_locked) die('테스트 계정이 이미 잠겨 있습니다. 관리자 화면에서 해제 후 다시 실행하세요.')

  // 이전 실행의 실패 기록이 남아 있으면 첫 정상 로그인부터 임계를 넘겨 버린다.
  // 측정 전 해당 계정의 미처리 실패 기록을 정리해 매 실행이 같은 조건에서 시작하게 한다.
  const cleared = await LoginAttempt.destroy({
    where: { identifier: EMAIL, identifier_type: 'EMAIL', success: false },
  })
  if (cleared > 0) notes.push(`이전 실행의 실패 기록 ${cleared}건을 정리하고 시작했다.`)

  const startedAt = new Date()

  // 관리자 세션 — 잠금·IP 차단 해제에 사용한다
  let adminCookie = ''
  if (ADMIN_EMAIL && ADMIN_PASSWORD) {
    const admin = await loginAsTestUser(ADMIN_EMAIL, ADMIN_PASSWORD, false, IP_ADMIN)
    adminCookie = admin.cookie
  } else {
    notes.push('관리자 자격 증명 미지정 — 복구 단계는 DB 직접 갱신으로 대체한다.')
  }

  // ─── 1. 정상 자격 증명 — 오탐 측정 ──────────────────────────
  section('1. 정상 자격 증명 — 오탐 측정')
  const NORMAL_N = 3
  let normalOk = 0
  const normalMs: number[] = []
  for (let i = 0; i < NORMAL_N; i++) {
    const a = await tryLogin(EMAIL, PASSWORD, IP_OK)
    normalMs.push(a.ms)
    if (a.res.status === 200) normalOk++
    else failures.push(`정상 로그인 실패 — ${a.res.status} ${messageOf(a)}`)
  }
  check('정상 자격 증명 전건 통과', normalOk === NORMAL_N, `${normalOk}/${NORMAL_N}`)

  // ─── 2. 계정 열거 억제 ──────────────────────────────────────
  section('2. 계정 열거 억제 — 응답 메시지와 응답 시간')
  const PROBE_N = 4          // 잠금 임계(5) 미만으로 유지
  const existingProbes: Attempt[] = []
  const missingProbes: Attempt[] = []
  for (let i = 0; i < PROBE_N; i++) {
    existingProbes.push(await tryLogin(EMAIL, WRONG_PASSWORD, IP_ENUM))
    missingProbes.push(await tryLogin(`no-such-user-${Date.now()}-${i}@example.com`, WRONG_PASSWORD, IP_ENUM))
  }

  const existingMsgs = new Set(existingProbes.map(messageOf))
  const missingMsgs = new Set(missingProbes.map(messageOf))
  check('존재/비존재 계정의 응답 메시지가 동일',
    existingMsgs.size === 1 && missingMsgs.size === 1 &&
    [...existingMsgs][0] === [...missingMsgs][0],
    `존재="${[...existingMsgs][0]}" / 비존재="${[...missingMsgs][0]}"`)
  check('존재/비존재 계정의 상태 코드가 동일',
    new Set([...existingProbes, ...missingProbes].map((a) => a.res.status)).size === 1,
    [...new Set([...existingProbes, ...missingProbes].map((a) => a.res.status))].join(','))

  const existingMs = median(existingProbes.map((a) => a.ms))
  const missingMs = median(missingProbes.map((a) => a.ms))
  const ratio = missingMs > 0 ? existingMs / missingMs : Infinity
  console.log(`  응답 시간 중앙값 — 존재 ${existingMs}ms / 비존재 ${missingMs}ms (비 ${ratio.toFixed(1)}배)`)
  check('응답 시간으로 계정 존재를 구별할 수 없음(비 2배 미만)', ratio < 2,
    `존재 ${existingMs}ms vs 비존재 ${missingMs}ms`)

  // 잠긴 계정·탈퇴 계정을 비밀번호 검증 이전에 구별해 주는지 — 4단계에서 이어서 측정한다

  // ─── 3. 무차별 대입 — 이메일 축 임계 ────────────────────────
  section('3. 무차별 대입 — 이메일 축(임계 5회/15분)')
  const beforeLock = await isLocked()
  check('임계 직전(누적 4회)에는 잠기지 않음', !beforeLock, `is_locked=${beforeLock}`)

  const fifth = await tryLogin(EMAIL, WRONG_PASSWORD, IP_LOCK)
  console.log(`  5회차 응답: ${fifth.res.status} ${messageOf(fifth)}`)

  // 잠금 기록은 응답을 보낸 뒤 비동기로 반영되므로 잠깐 기다렸다 확인한다
  const afterLock = await waitFor(() => isLocked(), true)
  check('임계 도달(5회)에서 계정 잠금', afterLock, `is_locked=${afterLock}`)

  const bruteLogs = await AnomalyLog.findAll({
    where: { anomaly_type: 'BRUTE_FORCE', created_at: { [Op.gte]: startedAt }, email: EMAIL },
    order: [['id', 'ASC']],
  })
  check('anomaly_logs 에 BRUTE_FORCE 기록', bruteLogs.length > 0, `${bruteLogs.length}건`)
  check('조치가 LOCK 으로 기록', bruteLogs.some((l) => l.action === 'LOCK'),
    [...new Set(bruteLogs.map((l) => l.action))].join(','))
  if (bruteLogs.length > 0) console.log(`  기록: ${bruteLogs[bruteLogs.length - 1].detail}`)

  // ─── 4. 잠금의 실효성과 잠금 상태의 정보 노출 ───────────────
  section('4. 잠금 실효성 — 올바른 비밀번호로도 차단되는가')
  const lockedCorrect = await tryLogin(EMAIL, PASSWORD, IP_LOCK)
  check('잠긴 계정은 올바른 비밀번호로도 로그인 불가', lockedCorrect.res.status !== 200,
    `${lockedCorrect.res.status} ${messageOf(lockedCorrect)}`)
  check('차단 응답이 잠금 여부를 드러내지 않음',
    lockedCorrect.res.data?.code === 'AUTH_THROTTLED' && !messageOf(lockedCorrect).includes('계정'),
    `code=${lockedCorrect.res.data?.code}`)

  // 임계를 넘긴 뒤의 응답도 존재/비존재가 구별되지 않아야 한다.
  // 공정한 비교를 위해 "같은 횟수의 실패를 쌓은" 비존재 계정과 대조한다.
  // (임계를 넘겨야 의미가 있으므로 존재 계정과 동일하게 5회를 채운다)
  const IP_ENUM2 = `198.51.100.${((base + 5) % 250) + 1}`
  const ghostEmail = `ghost-${Date.now()}@example.com`
  let missingProbe = await tryLogin(ghostEmail, WRONG_PASSWORD, IP_ENUM2)
  for (let i = 0; i < 4; i++) missingProbe = await tryLogin(ghostEmail, WRONG_PASSWORD, IP_ENUM2)
  const lockedProbe = await tryLogin(EMAIL, WRONG_PASSWORD, IP_ENUM2)
  check('임계 초과 후 존재/비존재 계정의 응답이 동일(열거 억제)',
    messageOf(lockedProbe) === messageOf(missingProbe) &&
    lockedProbe.res.status === missingProbe.res.status,
    `잠김=${lockedProbe.res.status} "${messageOf(lockedProbe)}" / 비존재=${missingProbe.res.status} "${messageOf(missingProbe)}"`)

  // ─── 5. 복구 경로 ───────────────────────────────────────────
  section('5. 복구 — 관리자 잠금 해제')
  if (adminCookie) {
    const unlock = await axios.patch(`${arg('url', 'http://localhost:3000')}${ADMIN}/users/${user.id}/unlock`, {}, {
      headers: { Cookie: adminCookie, 'User-Agent': UA, 'X-Forwarded-For': IP_ADMIN },
      validateStatus: () => true,
    })
    check('관리자 API 로 잠금 해제', unlock.status === 200, `${unlock.status}`)
  } else {
    await User.update({ is_locked: false }, { where: { id: user.id } })
    notes.push('잠금 해제를 DB 직접 갱신으로 수행했다(관리자 자격 증명 미지정).')
  }

  check('잠금 상태 해제 확인', !(await isLocked()))

  const recovered = await tryLogin(EMAIL, PASSWORD, IP_OK)
  check('해제 후 정상 로그인 복구', recovered.res.status === 200,
    `${recovered.res.status} ${messageOf(recovered)}`)

  // ─── 6. 무차별 대입 — IP 축 임계 ────────────────────────────
  //   존재하지 않는 이메일만 사용해 계정 잠금과 분리한다.
  section('6. 무차별 대입 — IP 축(임계 10회/15분)')
  let ipBlockedAt = 0
  let rateLimitedAt = 0
  for (let i = 1; i <= 18; i++) {
    const a = await tryLogin(`flood-${Date.now()}-${i}@example.com`, WRONG_PASSWORD, IP_FLOOD)
    if (a.res.status === 403) { ipBlockedAt = i; break }
    if (a.res.status === 429 && rateLimitedAt === 0) rateLimitedAt = i
  }
  console.log(`  IP 차단 ${ipBlockedAt || '-'}회차 · 레이트 리미터 429 ${rateLimitedAt || '-'}회차`)
  check('IP 축 임계 초과 시 차단(403 IP_BLOCKED)', ipBlockedAt > 0,
    ipBlockedAt > 0 ? `${ipBlockedAt}회차` : '18회 내 미차단')

  // 판정에 그치지 않고 실제 차단 목록에 올라가야 관리자 화면·후속 요청 차단이 성립한다
  const blockedList = adminCookie
    ? (await get(`${ADMIN}/blocked-ips`, { ip: IP_ADMIN, cookie: adminCookie })).data?.ips ?? []
    : []
  check('차단 IP 목록에 실제 등록', Array.isArray(blockedList) && blockedList.includes(IP_FLOOD),
    `등록 ${Array.isArray(blockedList) ? blockedList.length : 0}건`)
  check('IP 차단이 레이트 리미터보다 먼저 발동(규칙 도달 가능)',
    ipBlockedAt > 0 && (rateLimitedAt === 0 || ipBlockedAt <= rateLimitedAt),
    `차단 ${ipBlockedAt}회차 / 429 ${rateLimitedAt || '없음'}회차`)

  const ipLogs = await AnomalyLog.findAll({
    where: { anomaly_type: 'BRUTE_FORCE', ip: IP_FLOOD, created_at: { [Op.gte]: startedAt } },
  })
  check('IP 축 탐지가 anomaly_logs 에 기록', ipLogs.length > 0, `${ipLogs.length}건`)
  check('IP 축 조치가 BLOCK 으로 기록', ipLogs.some((l) => l.action === 'BLOCK'),
    [...new Set(ipLogs.map((l) => l.action))].join(','))
  check('IP 축 공격이 테스트 계정을 잠그지 않음(축 분리)', !(await isLocked()))

  // ─── 7. 정리 ────────────────────────────────────────────────
  section('7. 정리 — 잠금·IP 차단 해제')
  if (adminCookie) {
    const res = await del(`${ADMIN}/blocked-ips/${encodeURIComponent(IP_FLOOD)}`, { ip: IP_ADMIN, cookie: adminCookie })
    check('차단 IP 해제', res.status === 200 || (ipBlockedAt === 0 && res.status === 404),
      `${res.status}${ipBlockedAt === 0 ? ' (차단된 적 없음)' : ''}`)
    const after = await tryLogin(`cleanup-${Date.now()}@example.com`, WRONG_PASSWORD, IP_FLOOD)
    const stillIpBlocked = after.res.status === 403
    check('해제 후 해당 IP 의 IP 차단이 풀림', !stillIpBlocked, `${after.res.status} ${messageOf(after)}`)
    if (after.res.status === 429) {
      notes.push('레이트 리미터(IP당 15회/15분)는 인메모리라 별도 해제 경로가 없다 — 위조 IP 라 영향 없음.')
    }
  } else {
    notes.push(`위조 IP ${IP_FLOOD} 가 차단 목록에 남아 있다(서버 재시작 시 사라짐).`)
  }

  if (await isLocked()) {
    await User.update({ is_locked: false }, { where: { id: user.id } })
    notes.push('종료 시점에 계정이 잠겨 있어 해제했다.')
  }
  check('종료 시 테스트 계정이 잠기지 않은 상태', true)

  // ─── 결과 출력 ──────────────────────────────────────────────
  const attackAttempts = PROBE_N * 2 + 1 + 2 + (ipBlockedAt || 24)
  console.log('')
  console.log('[보안 테스트] 계정·인증 보안 (무차별 대입 / 계정 열거)')
  console.log(`총 시도: ${attackAttempts + NORMAL_N + 1}회 | 정상 ${NORMAL_N + 1}회 | 공격 ${attackAttempts}회`)
  console.log(`- 이메일 축 잠금   : 4회 미발동 → 5회차 잠금(임계 5회/15분) · anomaly_logs BRUTE_FORCE/LOCK 기록`)
  console.log(`- 잠금 실효성      : 잠금 후 올바른 비밀번호도 거부(${lockedCorrect.res.status})`)
  console.log(`- IP 축 차단       : ${ipBlockedAt > 0 ? `${ipBlockedAt}회차 차단(임계 10회/15분)` : '미차단'} · 계정 잠금과 분리됨`)
  console.log(`- 계정 열거(메시지): 존재/비존재 응답 ${[...existingMsgs][0] === [...missingMsgs][0] ? '동일' : '상이'}`)
  console.log(`- 계정 열거(시간)  : 존재 ${existingMs}ms vs 비존재 ${missingMs}ms (비 ${ratio.toFixed(1)}배)`)
  console.log(`- 잠긴 계정 노출   : 잠김="${messageOf(lockedProbe)}" vs 비존재="${messageOf(missingProbe)}"`)
  console.log(`- 복구             : 관리자 해제 후 정상 로그인 복구 확인`)
  console.log(`- 정상 로그인 오탐 : ${NORMAL_N - normalOk}/${NORMAL_N}`)

  if (notes.length > 0) {
    console.log('\n[확인 사항]')
    for (const n of notes) console.log(`  · ${n}`)
  }
  if (failures.length > 0) {
    console.log('\n[실패 항목]')
    for (const f of failures) console.log(`  · ${f}`)
  }

  console.log(`\n검증 항목: ${pass}건 통과 / ${fail}건 실패`)
  console.log(`판정: ${fail === 0 ? 'PASS' : 'FAIL'}`)

  await sequelize.close()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (err) => {
  console.error('실행 실패:', err?.message ?? err)
  await User.update({ is_locked: false }, { where: { email: EMAIL } }).catch(() => undefined)
  await sequelize.close().catch(() => undefined)
  process.exit(1)
})
