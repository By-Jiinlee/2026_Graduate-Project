/**
 * [보안 검증] 휴대폰 번호 로그인 — 로그인 아이디 확장의 보안 불변식
 *
 * 휴대폰 인증만으로 가입한 계정은 이메일이 없어 휴대폰 번호로 로그인한다. 아이디가 둘이 되면서 지켜야 할 것:
 *   1) 아이디 해석 — 형식 검증, 인증된 번호만 아이디로 인정, 같은 번호 계정이 둘이면 거부
 *   2) 무차별 대입 — 같은 계정을 이메일·휴대폰으로 번갈아 시도해도 실패가 한 곳에 쌓여 5회에 잠긴다
 *      (대조군: 입력값 기준 집계는 4+4=8회를 시도해도 잠기지 않는다)
 *   3) 계정 열거 — 없는 번호·틀린 비밀번호·미인증 번호의 응답이 같다
 *   4) 개인정보 — 로그인 시도 기록·이상 로그에 휴대폰 번호 평문이 남지 않는다
 *   5) 잠금 해제 — 관리자 해제가 지우는 키와 집계 키가 같다(해제 직후 재잠금 방지)
 *   6) 실제 흐름 — 검증 미들웨어 → 1단계 컨트롤러가 휴대폰 아이디로 지갑 서명 단계까지 진행
 *
 * 실제 코드(parseLoginIdentifier·resolveLoginAccount·loginStep1·validateLoginStep1·컨트롤러·analyzeLoginAttempt)를
 * 호출하고 users·wallets·login_attempts·anomaly_logs 만 메모리로 대체한다. 공유 DB 에 쓰지 않는다.
 *
 * 실행: cd server && npx ts-node src/test/security/phoneLogin.test.ts
 */
import bcrypt from 'bcryptjs'
import { Op } from 'sequelize'
import sequelize from '../../config/database'
import User from '../../models/user/User'
import Wallet from '../../models/user/Wallet'
import LoginAttempt from '../../models/auth/LoginAttempt'
import AnomalyLog from '../../models/auth/AnomalyLog'
import * as auth from '../../services/auth/authService'
import { analyzeLoginAttempt } from '../../services/auth/anomalyService'
import { validateLoginStep1 } from '../../middleware/validation/authValidation'
import { loginStep1 } from '../../controllers/auth/authController'
import { accountLoginKey, parseLoginIdentifier } from '../../utils/loginIdentifier'

/* eslint-disable @typescript-eslint/no-var-requires */
const CS: any = require('../../services/web3/contractService')
const EMAIL: any = require('../../services/auth/emailService')

// ── 메모리 저장소 ──────────────────────────────────────────────
const users: any[] = []
const attempts: any[] = []
const logs: any[] = []
const matches = (row: any, where: any) => Object.entries(where).every(([k, c]: [string, any]) => {
  if (c && typeof c === 'object' && Op.gte in c) return new Date(row[k]).getTime() >= new Date(c[Op.gte]).getTime()
  if (typeof c === 'boolean') return Boolean(row[k]) === c
  return row[k] === c
})
;(User as any).findOne = async ({ where }: any) => users.find((u) => matches(u, where)) ?? null
;(User as any).findAll = async ({ where, limit }: any) => users.filter((u) => matches(u, where)).slice(0, limit ?? 99)
;(User as any).update = async (v: any, { where }: any) => { users.filter((u) => matches(u, where)).forEach((u) => Object.assign(u, v)); return [1] }
;(Wallet as any).findOne = async ({ where }: any) => (where.user_id ? { address: '0x' + 'ab'.repeat(20), user_id: where.user_id } : null)
;(LoginAttempt as any).create = async (v: any) => { attempts.push({ ...v, created_at: new Date() }); return v }
;(LoginAttempt as any).count = async ({ where }: any) => attempts.filter((a) => matches(a, where)).length
;(AnomalyLog as any).create = async (v: any) => { logs.push(v); return v }
EMAIL.sendAnomalyAlertEmail = async () => undefined
CS.getUsableAuthNonce = async () => 0n

const PW = 'Correct!234'
// 실제 저장 해시와 같은 cost(12) — 없는 계정용 더미 해시와 비용이 같아야 타이밍 비교가 의미 있다
const hash = bcrypt.hashSync(PW, 12)
const both = { id: 1, email: 'both@test.local', phone: '01011112222', is_phone_verified: true, password_hash: hash, is_locked: false, status: 'active' }
const phoneOnly = { id: 2, email: null, phone: '01033334444', is_phone_verified: true, password_hash: hash, is_locked: false, status: 'active' }
const unverifiedPhone = { id: 3, email: 'u3@test.local', phone: '01055556666', is_phone_verified: false, password_hash: hash, is_locked: false, status: 'active' }
const dupA = { id: 4, email: 'a@test.local', phone: '01077778888', is_phone_verified: true, password_hash: hash, is_locked: false, status: 'active' }
const dupB = { id: 5, email: 'b@test.local', phone: '01077778888', is_phone_verified: true, password_hash: hash, is_locked: false, status: 'active' }
const reset = () => {
  users.length = 0
  users.push(...[both, phoneOnly, unverifiedPhone, dupA, dupB].map((u) => ({ ...u })))
  attempts.length = 0
  logs.length = 0
}

const rows: { name: string; ok: boolean; detail: string }[] = []
const check = (name: string, ok: boolean, detail = '') => rows.push({ name, ok, detail })
const tryStep1 = async (raw: string, pw: string) => {
  const id = parseLoginIdentifier(raw)!
  const acc = await auth.resolveLoginAccount(id)
  try { const r = await auth.loginStep1(acc, pw); return { ok: true, msg: '', acc, r } } catch (e: any) { return { ok: false, msg: e.message, acc, r: null } }
}
// 실패 1회 = 1단계 실패 + 이상탐지(시도 기록·집계)
const failOnce = async (raw: string) => {
  const t = await tryStep1(raw, 'Wrong!234')
  return analyzeLoginAttempt({ email: t.acc.display, ip: '198.51.100.5', success: false, loginKey: t.acc.loginKey, accountId: t.acc.user?.id })
}

async function main() {
  console.log('\n[보안 테스트] 휴대폰 번호 로그인')
  const log = console.warn
  console.warn = () => undefined

  // ═════ 1) 아이디 해석 ════════════════════════════════════════
  const parse: [string, unknown, string | null][] = [
    ['이메일', 'user@test.local', 'email'],
    ['휴대폰(숫자만)', '01012345678', 'phone'],
    ['휴대폰(하이픈)', '010-1234-5678', 'phone'],
    ['휴대폰(공백)', ' 010 1234 5678 ', 'phone'],
    ['국번 오류', '02012345678', null],
    ['자릿수 부족', '0101234567', 'phone'],
    ['자릿수 초과', '010123456789', null],
    ['@ 있는 잘못된 이메일', 'a@b', null],
    ['빈 문자열', '', null],
    ['문자열 아님', 12345678901, null],
    ['과도한 길이', 'a'.repeat(120) + '@x.com', null],
  ]
  for (const [name, raw, kind] of parse) {
    const r = parseLoginIdentifier(raw)
    check(`아이디 형식: ${name}`, (r?.kind ?? null) === kind, r ? `${r.kind}:${r.kind === 'phone' ? r.value : '…'}` : 'null')
  }

  reset()
  const okPhone = await tryStep1('010-3333-4444', PW)
  check('이메일 없는 계정이 휴대폰 번호로 1단계 통과', okPhone.ok && okPhone.r?.userId === 2, okPhone.msg)
  const okBothPhone = await tryStep1('01011112222', PW)
  const okBothMail = await tryStep1('both@test.local', PW)
  check('이메일·휴대폰 둘 다 있는 계정은 어느 쪽으로도 같은 계정', okBothPhone.r?.userId === 1 && okBothMail.r?.userId === 1)
  const unver = await tryStep1('01055556666', PW)
  check('미인증 번호로는 로그인 불가(비밀번호가 맞아도)', !unver.ok, unver.msg)
  const dup = await tryStep1('01077778888', PW)
  check('같은 번호 계정이 둘이면 휴대폰 로그인 거부', !dup.ok, dup.msg)

  // ═════ 3) 계정 열거 ══════════════════════════════════════════
  const none = await tryStep1('01099990000', 'Wrong!234')
  const wrong = await tryStep1('01033334444', 'Wrong!234')
  check('없는 번호·틀린 비밀번호·미인증 번호의 응답 동일', none.msg === wrong.msg && wrong.msg === unver.msg, `"${none.msg}"`)
  const t0 = Date.now(); await tryStep1('01099990001', 'Wrong!234'); const tNone = Date.now() - t0
  const t1 = Date.now(); await tryStep1('01033334444', 'Wrong!234'); const tReal = Date.now() - t1
  check('없는 번호도 비밀번호 비교 수행(응답 시간 차 2배 미만)', Math.max(tNone, tReal) < 2 * Math.max(1, Math.min(tNone, tReal)) + 20, `${tNone}ms vs ${tReal}ms`)

  // ═════ 2) 무차별 대입 — 계정 기준 합산 ═══════════════════════
  reset()
  let lockedAt = 0
  const seq = ['both@test.local', '010-1111-2222', 'both@test.local', '01011112222', 'both@test.local']
  for (let i = 0; i < seq.length; i++) {
    const r = await failOnce(seq[i])
    if (r.locked && !lockedAt) lockedAt = i + 1
  }
  check('이메일·휴대폰 번갈아 실패해도 5회째 잠금', lockedAt === 5 && users.find((u) => u.id === 1).is_locked === true, `잠금 ${lockedAt}회차`)

  // 대조군 — 수정 전처럼 입력값(이메일/번호 문자열) 기준으로 집계하면
  reset()
  let legacyLocked = false
  for (const raw of ['both@test.local', '01011112222', 'both@test.local', '01011112222', 'both@test.local', '01011112222', 'both@test.local', '01011112222']) {
    const id = parseLoginIdentifier(raw)!
    const r = await analyzeLoginAttempt({ email: id.value, ip: '198.51.100.6', success: false, loginKey: id.value })
    if (r.locked) legacyLocked = true
  }
  check('대조군: 입력값 기준 집계는 8회 시도해도 잠기지 않음', legacyLocked === false)

  reset()
  for (let i = 0; i < 5; i++) await failOnce('01033334444')
  check('이메일 없는 계정도 휴대폰 실패 5회에 잠금', users.find((u) => u.id === 2).is_locked === true)

  // ═════ 4) 개인정보 ═══════════════════════════════════════════
  const plain = /01[016789]\d{7,8}/
  check('로그인 시도 기록에 휴대폰 번호 평문 없음', attempts.every((a) => !plain.test(String(a.identifier))), attempts.map((a) => a.identifier).slice(0, 1).join(''))
  check('이상 로그에 휴대폰 번호 평문 없음(가린 값)', logs.length > 0 && logs.every((l) => !plain.test(String(l.email ?? '')) && !plain.test(String(l.detail ?? ''))),
    logs.map((l) => l.email).slice(0, 1).join(''))

  // ═════ 5) 잠금 해제 키 ═══════════════════════════════════════
  const keyUsed = attempts.find((a) => a.identifier_type === 'EMAIL')?.identifier
  check('관리자 해제가 지우는 키 = 집계 키', keyUsed === accountLoginKey(users.find((u) => u.id === 2)))
  check('이메일 있는 계정의 키는 이메일(기존 기록과 호환)', accountLoginKey(both) === 'both@test.local')

  // ═════ 6) 실제 흐름: 검증 미들웨어 → 1단계 컨트롤러 ══════════
  reset()
  const req: any = { body: { loginId: '010-3333-4444', password: PW }, cookies: {}, headers: { 'user-agent': 'phoneLogin' }, socket: { remoteAddress: '198.51.100.7' } }
  const res: any = { locals: {}, statusCode: 200, status(c: number) { this.statusCode = c; return this }, json(b: any) { this.body = b; return this } }
  let validated = false
  validateLoginStep1(req, res, () => { validated = true })
  await loginStep1(req, res, () => undefined)
  check('검증 미들웨어가 휴대폰 아이디 통과', validated)
  check('1단계 컨트롤러: 휴대폰 아이디로 지갑 서명 단계 진입', res.locals.loginSuccess === true && res.locals.responseData?.userId === 2,
    String(res.locals.responseData?.message ?? ''))
  check('1단계 컨트롤러: 이상탐지에 넘기는 표시값은 가린 번호', res.locals.loginEmail === '010-****-4444', res.locals.loginEmail)
  const bad: any = { locals: {}, status(c: number) { this.statusCode = c; return this }, json(b: any) { this.body = b; return this } }
  validateLoginStep1({ body: { loginId: '010-12', password: PW } } as any, bad, () => undefined)
  check('검증 미들웨어: 잘못된 형식 거부', bad.statusCode === 400, bad.body?.message)
  const legacy: any = { locals: {}, status(c: number) { this.statusCode = c; return this }, json(b: any) { this.body = b; return this } }
  let legacyOk = false
  validateLoginStep1({ body: { email: 'both@test.local', password: PW } } as any, legacy, () => { legacyOk = true })
  check('구버전 클라이언트(email 필드)도 통과', legacyOk)

  console.warn = log
  const failed = rows.filter((r) => !r.ok)
  for (const r of rows) console.log(`  ${r.ok ? '✔' : '✘'} ${r.name}${r.detail ? `  (${r.detail})` : ''}`)
  console.log(`검증 항목: ${rows.length - failed.length}건 통과 / ${failed.length}건 실패`)
  console.log(`판정: ${failed.length === 0 ? 'PASS' : 'FAIL'}`)
  await sequelize.close().catch(() => undefined)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('검증 실행 오류:', err)
  process.exit(1)
})
