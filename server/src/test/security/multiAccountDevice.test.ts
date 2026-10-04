/**
 * [보안 검증] 단말 다계정 탐지 (1인 1계정 원칙)
 *
 * 지갑은 무제한으로 만들 수 있고 휴대폰 인증은 공인 본인확인이 아니어서, 가입 단계의 중복
 * 검사만으로는 한 사람이 여러 계정을 운용하는 것을 막지 못한다. 서버가 발급한 단말 식별
 * 쿠키(HMAC 저장)를 기준으로 한 단말에서 쓰이는 계정을 관측한다.
 *
 *   1) 공격 — 계정 농장 가입, 계정 전환 로그인, 순환 다계정, 한 단말 크리덴셜 스터핑,
 *             쿠키를 버리는 스크립트 가입, 기존 계정 간 빠른 전환
 *   2) 정상 — 1인 다단말, 같은 단말 반복 로그인, 가족 공용 PC, 탈퇴 후 재가입, 오래된 공용 이력
 *   3) 회피 — 쿠키 삭제·시크릿 창(새 단말로 보임): 탐지하지 못함을 그대로 측정해 한계로 보고
 *   4) 경계 — 전환 창 10분, 관측 창 30일, 가입 한도
 *
 * 판정·기록 코드는 실제 서비스(anomalyService)를 그대로 호출하고, device_account_links·users·
 * anomaly_logs 만 메모리 저장소로 바꾼다. 시간 경과는 저장된 시각을 과거로 미는 방식으로 재현한다.
 * 공유 DB 에 아무것도 쓰지 않는다.
 *
 * 실행: cd server && npx ts-node src/test/security/multiAccountDevice.test.ts
 */
import crypto from 'crypto'
import { Op, UniqueConstraintError } from 'sequelize'
import sequelize from '../../config/database'
import AnomalyLog from '../../models/auth/AnomalyLog'
import DeviceAccountLink from '../../models/auth/DeviceAccountLink'
import User from '../../models/user/User'
import {
  assertRegistrationDeviceAllowed,
  detectMultiAccountDevice,
  judgeDeviceLogin,
  judgeDeviceRegistration,
  linkRegisteredAccount,
  MULTI_ACCOUNT_DEVICE_POLICY as P,
} from '../../services/auth/anomalyService'
import { hashDeviceId, isValidDeviceId, newDeviceId } from '../../services/auth/deviceIdentityService'

// ── 메모리 저장소 ──────────────────────────────────────────────
interface LinkRow { device_hash: string; user_id: number; first_event: string; first_seen_at: Date; last_seen_at: Date; update: (v: any) => Promise<void> }
const links: LinkRow[] = []
const userStatus = new Map<number, string>()
const logs: { user_id: number | null; action: string; detail: string }[] = []

const L = DeviceAccountLink as any
L.findAll = async ({ where }: any) => links.filter((r) => r.device_hash === where.device_hash)
L.findOne = async ({ where }: any) =>
  links.find((r) => r.device_hash === where.device_hash && r.user_id === where.user_id) ?? null
L.create = async (v: any) => {
  if (links.some((r) => r.device_hash === v.device_hash && r.user_id === v.user_id)) {
    throw new UniqueConstraintError({ message: 'duplicate' })
  }
  const row: LinkRow = { ...v, update: async (u: any) => { Object.assign(row, u) } }
  links.push(row)
  return row
}
;(User as any).findAll = async ({ where }: any) =>
  (where.id[Op.in] as number[]).map((id) => ({ id, status: userStatus.get(id) ?? 'active' }))
;(AnomalyLog as any).create = async (v: any) => { logs.push({ user_id: v.user_id, action: v.action, detail: v.detail }); return v }

// 시간 경과 — 이 단말에 저장된 모든 시각을 과거로 민다(= 그만큼 시간이 흐름)
function advance(device: string, minutes: number): void {
  for (const r of links) {
    if (r.device_hash !== device) continue
    r.last_seen_at = new Date(r.last_seen_at.getTime() - minutes * 60_000)
    r.first_seen_at = new Date(r.first_seen_at.getTime() - minutes * 60_000)
  }
}

let seq = 1000
const newUser = (): number => { const id = ++seq; userStatus.set(id, 'active'); return id }
const newDevice = (): string => hashDeviceId(newDeviceId())

// 한 사건 = 로그인 1단계 성공 또는 가입 시도
type Outcome = 'ALERT' | 'BLOCK' | 'NONE'
async function login(device: string, userId: number): Promise<Outcome> {
  const r = await detectMultiAccountDevice({
    userId, email: `${userId}@test.local`, ip: '198.51.100.9', userAgent: 'multiAccountDevice', success: true, deviceHash: device,
  })
  return r ? 'ALERT' : 'NONE'
}
async function register(device: string, fresh = false): Promise<{ outcome: Outcome; userId?: number }> {
  const before = logs.length
  try {
    const { sharedWith } = await assertRegistrationDeviceAllowed({
      deviceHash: device, deviceFresh: fresh, email: 'new@test.local', ip: '198.51.100.9',
    })
    const userId = newUser()
    await linkRegisteredAccount({ deviceHash: device, userId, email: 'new@test.local', ip: '198.51.100.9', sharedWith })
    return { outcome: logs.length > before ? 'ALERT' : 'NONE', userId }
  } catch {
    return { outcome: 'BLOCK' }
  }
}

// ── 집계 ───────────────────────────────────────────────────────
type Kind = 'attack' | 'normal' | 'evasion'
// quiet: 정상 시나리오 중 경보도 없어야 하는 것(가족 공용 단말은 설계상 1회 경보가 난다)
interface Scenario { kind: Kind; name: string; events: Outcome[]; note?: string; quiet?: boolean }
const scenarios: Scenario[] = []
const checks: { name: string; ok: boolean }[] = []
const check = (name: string, ok: boolean) => checks.push({ name, ok })

async function main() {
  console.log('\n[보안 테스트] 단말 다계정 탐지 (1인 1계정)')

  // ═════ 공격 ═══════════════════════════════════════════════════
  {
    // A1 계정 농장 — 한 브라우저에서 연속 가입
    const d = newDevice()
    const ev: Outcome[] = []
    for (let i = 0; i < 5; i++) ev.push((await register(d)).outcome)
    scenarios.push({ kind: 'attack', name: '계정 농장: 한 단말에서 5개 연속 가입', events: ev })
    check('A1 첫 가입은 기록 없음', ev[0] === 'NONE')
    check('A1 두 번째 가입은 허용·경보', ev[1] === 'ALERT')
    check('A1 세 번째부터 가입 차단', ev.slice(2).every((e) => e === 'BLOCK'))
  }
  {
    // A2 계정 전환 — 다른 곳에서 만든 두 계정을 같은 단말에서 2분 간격으로 로그인
    const d = newDevice()
    const x = newUser(), y = newUser()
    const ev = [await login(d, x)]
    advance(d, 2)
    ev.push(await login(d, y))
    scenarios.push({ kind: 'attack', name: '계정 전환: 2분 간격으로 다른 계정 로그인', events: ev })
    check('A2 두 번째 계정 로그인에서 경보', ev[1] === 'ALERT')
    const d2 = logs[logs.length - 1].detail
    check('A2 경보 상세에 신규 연결·전환·이전 계정 번호 포함', d2.includes('신규 계정 연결') && d2.includes('계정 전환') && d2.includes(String(x)))
  }
  {
    // A3 순환 다계정 — 5개 계정을 1분 간격으로
    const d = newDevice()
    const ids = [newUser(), newUser(), newUser(), newUser(), newUser()]
    const ev: Outcome[] = []
    for (const id of ids) { ev.push(await login(d, id)); advance(d, 1) }
    scenarios.push({ kind: 'attack', name: '순환 다계정: 5개 계정을 1분 간격 로그인', events: ev })
    check('A3 두 번째 계정부터 모두 경보', ev.slice(1).every((e) => e === 'ALERT'))
  }
  {
    // A4 한 단말 크리덴셜 스터핑 — 20개 계정의 비밀번호가 맞은 1단계 성공(지갑 서명 전)
    const d = newDevice()
    const ev: Outcome[] = []
    for (let i = 0; i < 20; i++) { ev.push(await login(d, newUser())); advance(d, 0.25) }
    scenarios.push({ kind: 'attack', name: '크리덴셜 스터핑: 한 단말에서 20계정 비밀번호 적중', events: ev })
    check('A4 첫 계정 외 19건 경보', ev.filter((e) => e === 'ALERT').length === 19)
  }
  {
    // A5 쿠키를 버리는 스크립트 가입 — 매 요청 새 식별자(deviceFresh)
    const ev: Outcome[] = []
    for (let i = 0; i < 5; i++) ev.push((await register(newDevice(), true)).outcome)
    scenarios.push({ kind: 'attack', name: '스크립트 가입: 식별 쿠키 없이 5회', events: ev })
    check('A5 식별자 없는 가입 전부 차단', ev.every((e) => e === 'BLOCK'))
  }
  {
    // A6 이미 연결된 두 계정 사이 빠른 전환 — 연결은 이틀 전에 생김
    const d = newDevice()
    const a = newUser(), b = newUser()
    await login(d, a); await login(d, b)
    advance(d, 2 * 24 * 60)
    const ev: Outcome[] = []
    ev.push(await login(d, a)); advance(d, 3)
    ev.push(await login(d, b)); advance(d, 3)
    ev.push(await login(d, a))
    scenarios.push({ kind: 'attack', name: '기존 두 계정 3분 간격 반복 전환', events: ev, note: '경보 반복 억제 30분' })
    check('A6 첫 전환 경보 1건, 이후 30분 억제', ev.filter((e) => e === 'ALERT').length === 1 && ev[1] === 'ALERT')
  }

  // ═════ 정상 ═══════════════════════════════════════════════════
  {
    // N1 1인 다단말 — PC·휴대폰·태블릿
    const u = newUser()
    const ev: Outcome[] = []
    for (const d of [newDevice(), newDevice(), newDevice()]) for (let i = 0; i < 3; i++) ev.push(await login(d, u))
    scenarios.push({ kind: 'normal', name: '1인 다단말: 한 계정을 3개 단말에서 9회', events: ev, quiet: true })
  }
  {
    // N2 같은 단말 반복 로그인
    const d = newDevice()
    const u = newUser()
    const ev: Outcome[] = []
    for (let i = 0; i < 30; i++) { ev.push(await login(d, u)); advance(d, 5) }
    scenarios.push({ kind: 'normal', name: '같은 단말 반복 로그인 30회(5분 간격)', events: ev, quiet: true })
  }
  {
    // N3 가족 공용 PC — 각자 다른 곳에서 가입한 두 계정이 하루 간격으로 번갈아 사용
    const d = newDevice()
    const mom = newUser(), son = newUser()
    const ev: Outcome[] = []
    for (let day = 0; day < 10; day++) { ev.push(await login(d, day % 2 === 0 ? mom : son)); advance(d, 24 * 60) }
    scenarios.push({ kind: 'normal', name: '가족 공용 PC: 두 계정 하루 간격 교대 10일', events: ev, note: '두 번째 계정 첫 등장 1회 경보(설계상 관측)' })
  }
  {
    // N4 가족 공용 PC 에서 두 번째 가입
    const d = newDevice()
    const ev = [(await register(d)).outcome, (await register(d)).outcome]
    scenarios.push({ kind: 'normal', name: '가족 공용 PC: 두 번째 가입', events: ev, note: '허용 + 경보 1회' })
  }
  {
    // N5 탈퇴 후 같은 단말에서 재가입
    const d = newDevice()
    const first = await register(d)
    userStatus.set(first.userId!, 'withdrawn')
    const second = await register(d)
    scenarios.push({ kind: 'normal', name: '탈퇴 후 같은 단말 재가입', events: [first.outcome, second.outcome], note: '탈퇴 계정은 세지 않음', quiet: true })
  }
  {
    // N6 오래된 공용 이력 — 45일 전 다른 계정이 쓴 중고 PC
    const d = newDevice()
    await login(d, newUser())
    advance(d, 45 * 24 * 60)
    const ev = [await login(d, newUser())]
    scenarios.push({ kind: 'normal', name: '45일 전 다른 계정 이력이 있는 단말에서 로그인', events: ev, quiet: true })
  }
  {
    // N7 일반 신규 가입자
    const ev: Outcome[] = []
    for (let i = 0; i < 10; i++) ev.push((await register(newDevice())).outcome)
    scenarios.push({ kind: 'normal', name: '서로 다른 단말의 신규 가입 10건', events: ev, quiet: true })
  }

  // ═════ 회피 (탐지 실패를 측정) ═══════════════════════════════
  {
    // E1 가입할 때마다 쿠키를 지우고 페이지를 새로 연다 → 매번 새 단말(첫 요청에서 식별자 발급)
    const ev: Outcome[] = []
    for (let i = 0; i < 5; i++) ev.push((await register(newDevice())).outcome)
    scenarios.push({ kind: 'evasion', name: '쿠키 삭제 후 페이지 재방문 → 가입 5회', events: ev })
  }
  {
    // E2 계정마다 다른 브라우저/시크릿 창으로 로그인
    const ev: Outcome[] = []
    for (let i = 0; i < 5; i++) ev.push(await login(newDevice(), newUser()))
    scenarios.push({ kind: 'evasion', name: '계정마다 시크릿 창으로 로그인 5계정', events: ev })
  }

  // ═════ 경계·구성 요소 ═════════════════════════════════════════
  {
    const now = new Date('2026-10-01T12:00:00Z')
    const at = (min: number) => new Date(now.getTime() - min * 60_000)
    const j = (lastMin: number, isNew = false) =>
      judgeDeviceLogin({ userId: 1, isNewLink: isNew, now, links: [{ userId: 2, lastSeenAt: at(lastMin), active: true }] }).flagged
    check(`경계 전환 창 ${P.SWITCH_WINDOW_MINUTES}분 안(9분)`, j(9) === true)
    check(`경계 전환 창 정확히 ${P.SWITCH_WINDOW_MINUTES}분`, j(P.SWITCH_WINDOW_MINUTES) === true)
    check('경계 전환 창 밖(11분, 기존 연결)', j(11) === false)
    check(`경계 관측 창 ${P.WINDOW_DAYS}일 안 신규 연결`, j(P.WINDOW_DAYS * 1440 - 1, true) === true)
    check(`경계 관측 창 ${P.WINDOW_DAYS}일 밖 신규 연결`, j(P.WINDOW_DAYS * 1440 + 1, true) === false)
    check('탈퇴 계정만 있는 단말 신규 연결', judgeDeviceLogin({ userId: 1, isNewLink: true, now, links: [{ userId: 2, lastSeenAt: at(1), active: false }] }).flagged === false)
    const reg = (n: number) => judgeDeviceRegistration({ deviceFresh: false, links: Array.from({ length: n }, (_, i) => ({ userId: i + 10, lastSeenAt: now, active: true })) })
    check(`가입 한도: 활성 ${P.REGISTER_BLOCK_AT - 1}개 → 허용`, reg(P.REGISTER_BLOCK_AT - 1).allow === true)
    check(`가입 한도: 활성 ${P.REGISTER_BLOCK_AT}개 → 차단`, reg(P.REGISTER_BLOCK_AT).allow === false)
    check('가입 한도: 같은 계정 연결 중복은 1개로 셈',
      judgeDeviceRegistration({ deviceFresh: false, links: [{ userId: 7, lastSeenAt: now, active: true }, { userId: 7, lastSeenAt: now, active: true }] }).allow === true)

    // 식별자 — DB 에는 HMAC 만, 형식 검증
    const raw = newDeviceId()
    check('식별자 형식(43자 base64url)', isValidDeviceId(raw) && !isValidDeviceId(raw + 'x') && !isValidDeviceId('../../etc') && !isValidDeviceId(undefined))
    check('저장값은 원문이 아닌 HMAC(64 hex)', /^[0-9a-f]{64}$/.test(hashDeviceId(raw)) && hashDeviceId(raw) !== raw)
    const plainSha = crypto.createHash('sha256').update(raw).digest('hex')
    check('비밀키 없는 SHA-256 으로는 저장값 재현 불가', plainSha !== hashDeviceId(raw))
    check('같은 원문은 같은 저장값(결정적)', hashDeviceId(raw) === hashDeviceId(raw))
  }

  // ── 출력 ─────────────────────────────────────────────────────
  const atk = scenarios.filter((s) => s.kind === 'attack')
  const nor = scenarios.filter((s) => s.kind === 'normal')
  const eva = scenarios.filter((s) => s.kind === 'evasion')
  const hit = (s: Scenario) => s.events.some((e) => e !== 'NONE')
  const count = (ss: Scenario[], o: Outcome) => ss.reduce((n, s) => n + s.events.filter((e) => e === o).length, 0)
  const events = (ss: Scenario[]) => ss.reduce((n, s) => n + s.events.length, 0)
  const atkHit = atk.filter(hit).length
  const norBlocked = count(nor, 'BLOCK')
  const norAlert = count(nor, 'ALERT')
  const evaHit = eva.filter(hit).length

  console.log(`총 시도: ${events(scenarios)}회 | 탐지: ${count(atk, 'ALERT') + count(atk, 'BLOCK')}회 | 차단: ${count(atk, 'BLOCK')}회 | 탐지율: ${((atkHit / atk.length) * 100).toFixed(0)}% (공격 시나리오 ${atkHit}/${atk.length})`)
  console.log(`  정상 사용 오차단: ${norBlocked}/${events(nor)}건 (${((norBlocked / events(nor)) * 100).toFixed(1)}%) · 정상 경보: ${norAlert}/${events(nor)}건 (${((norAlert / events(nor)) * 100).toFixed(1)}%) — 가족 공용 단말의 두 번째 계정 첫 등장`)
  console.log(`  회피(쿠키 삭제·시크릿 창) 탐지: ${evaHit}/${eva.length} 시나리오 — 탐지 불가, 한계로 보고`)
  for (const s of scenarios) {
    const tag = s.kind === 'attack' ? '공격' : s.kind === 'normal' ? '정상' : '회피'
    const a = s.events.filter((e) => e === 'ALERT').length
    const b = s.events.filter((e) => e === 'BLOCK').length
    console.log(`  - [${tag}] ${s.name}: ${s.events.length}건 중 경보 ${a} · 차단 ${b}${s.note ? ` (${s.note})` : ''}`)
  }
  check('공격 시나리오 전부 탐지', atkHit === atk.length)
  check('정상 사용 차단 0건', norBlocked === 0)
  check('정상 경보는 가족 공용 단말 2건뿐(N3·N4 각 1)', norAlert === 2)
  check('1인 다단말·반복 로그인·재가입·오래된 이력·일반 가입은 경보 0', nor.filter((s) => s.quiet).every((s) => !hit(s)))
  check('회피 시나리오는 탐지되지 않음(한계 확인)', evaHit === 0)
  const failed = checks.filter((c) => !c.ok)
  for (const c of failed) console.log(`  ✘ ${c.name}`)
  console.log(`검증 항목: ${checks.length - failed.length}건 통과 / ${failed.length}건 실패`)
  console.log(`판정: ${failed.length === 0 ? 'PASS' : 'FAIL'}`)
  await sequelize.close().catch(() => undefined)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch(async (err) => {
  console.error('검증 실행 오류:', err)
  await sequelize.close().catch(() => undefined)
  process.exit(1)
})
