/**
 * [보안 검증] 회원가입 본인 인증 — 인증 성공·사용 처리 분리, 이메일 또는 휴대폰 단독 가입
 *
 * 결함: 가입 API 가 인증 기록의 is_used=1 만 보고 "인증 완료"로 판단했다. 그런데 is_used 는 코드 입력 성공뿐 아니라
 * 재발송 시 이전 코드 무효화, 5회 실패 폐기에서도 1 이 된다. 그래서 남의 이메일·번호로 코드를 발송하고 1분 뒤
 * 재발송하기만 하면 코드를 한 번도 입력하지 않고 가입할 수 있었고, 휴대폰이면 본인 확인 완료까지 기록됐다.
 *
 * 수정: verified_at(코드 입력 성공 시각)·consumed_at(가입에 사용한 시각)·purpose(가입/마이페이지/이메일 변경) 분리.
 *       가입은 최근 30분 이내 성공·미사용·가입용 기록만 인정하고, 소비를 사용자 생성과 같은 트랜잭션에서 한다.
 *       이메일·휴대폰 중 하나만 인증해도 가입 가능. 낸 이메일·번호는 전부 인증된 값이어야 한다
 *       (휴대폰으로 가입하면 이메일 없이 휴대폰 번호가 로그인 아이디 — 남의 이메일 선점 불가).
 *
 *   1) 우회 공격 — 재발송 무효화·5회 실패 폐기·30분 경과(이메일·휴대폰 각 3종), 마이페이지 휴대폰 인증·이메일 변경 인증의
 *      가입 재사용, 인증 한 번으로 두 계정, 동시 가입 경합, 미인증 번호 첨부, 인증 없이 가입 — 대조군(수정 전 판정)과 함께
 *   2) 정상 가입 — 정답 1회, 오답 후 정답, 29분 경과, 이메일 단독, 휴대폰 단독(이메일 없음), 둘 다
 *   3) 가입 후 — 휴대폰 가입자의 이메일 등록(이메일 변경 흐름), 미인증 이메일 계정(이전 데이터)에 보안 경보 미발송
 *
 * 발송·검증·가입 함수는 실제 코드를 호출하고, 인증·사용자·지갑 저장소와 메일·SMS 발송·체인만 메모리로 대체한다.
 *
 * 실행: cd server && npx ts-node src/test/security/signupVerification.test.ts
 */
import { Op, UniqueConstraintError } from 'sequelize'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import sequelize from '../../config/database'
import User from '../../models/user/User'
import Wallet from '../../models/user/Wallet'
import EmailVerification from '../../models/auth/EmailVerification'
import SmsVerification from '../../models/auth/SmsVerification'
import Blacklist from '../../models/auth/Blacklist'
import WithdrawnUser from '../../models/auth/WithdrawnUser'
import WalletNonceUse from '../../models/auth/WalletNonceUse'
import * as auth from '../../services/auth/authService'
import { isAlertRecipientVerified } from '../../services/auth/emailService'

/* eslint-disable @typescript-eslint/no-var-requires */
const CS: any = require('../../services/web3/contractService')
const EMAIL: any = require('../../services/auth/emailService')
const SMS: any = require('../../services/auth/smsService')

// ── 메모리 저장소 ──────────────────────────────────────────────
const matches = (row: any, where: any): boolean =>
  Object.entries(where).every(([k, cond]: [string, any]) => {
    const v = row[k]
    if (cond === null) return v === null || v === undefined
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if (Op.gte in cond) return v != null && new Date(v).getTime() >= new Date(cond[Op.gte]).getTime()
      if (Op.gt in cond) return v != null && new Date(v).getTime() > new Date(cond[Op.gt]).getTime()
      if (Op.ne in cond) return v !== cond[Op.ne]
      if (Op.in in cond) return (cond[Op.in] as unknown[]).includes(v)
      return false
    }
    if (typeof cond === 'boolean') return Boolean(v) === cond
    return v === cond
  })

function memModel(model: any, rows: any[]) {
  let seq = 0
  const wrap = (r: any) => {
    r.update = async (u: any) => Object.assign(r, u)
    r.increment = async (f: string) => { r[f] = (r[f] ?? 0) + 1 }
    r.destroy = async () => { rows.splice(rows.indexOf(r), 1) }
    return r
  }
  model.create = async (v: any) => wrap(rows[rows.push({ id: ++seq, created_at: new Date(), verified_at: null, consumed_at: null, purpose: 'SIGNUP', ...v }) - 1])
  model.findOne = async ({ where, order }: any = {}) => {
    const found = rows.filter((r) => matches(r, where ?? {}))
    if (order?.[0]) {
      const [col] = order[0]
      found.sort((a, b) => new Date(b[col] ?? 0).getTime() - new Date(a[col] ?? 0).getTime())
    }
    return found[0] ?? null
  }
  model.count = async ({ where }: any) => rows.filter((r) => matches(r, where)).length
  model.update = async (values: any, { where }: any) => {
    const hit = rows.filter((r) => matches(r, where))
    hit.forEach((r) => Object.assign(r, values))
    return [hit.length]
  }
}

const emailRows: any[] = []
const smsRows: any[] = []
const users: any[] = []
const wallets: any[] = []
memModel(EmailVerification, emailRows)
memModel(SmsVerification, smsRows)
;(User as any).findOne = async ({ where }: any) => users.find((u) => matches(u, where)) ?? null
;(User as any).findByPk = async (id: number) => users.find((u) => u.id === id) ?? null
;(User as any).create = async (v: any) => {
  // DB 유일 인덱스와 같게 — NULL(이메일 없는 휴대폰 가입 계정)은 여러 개 허용
  if (v.email != null && users.some((u) => u.email === v.email)) throw new UniqueConstraintError({ message: 'dup email' })
  const u = { id: 1000 + users.length, ...v }
  users.push(u)
  return u
}
;(User as any).update = async (v: any, { where }: any) => { users.filter((u) => matches(u, where)).forEach((u) => Object.assign(u, v)); return [1] }
;(Wallet as any).findOne = async ({ where }: any) => wallets.find((w) => matches(w, where)) ?? null
;(Wallet as any).create = async (v: any) => { wallets.push(v); return v }
;(Blacklist as any).findOne = async () => null
;(WithdrawnUser as any).findOne = async () => null
;(WalletNonceUse as any).findOne = async () => null
;(sequelize as any).transaction = async () => ({ commit: async () => undefined, rollback: async () => undefined })
CS.isWalletRegistered = async () => false
CS.registerWalletFor = async () => undefined

const lastCode = new Map<string, string>()
EMAIL.sendVerificationEmail = async (to: string, code: string) => { lastCode.set(to, code) }
SMS.sendVerificationSms = async (to: string, code: string) => { lastCode.set(to, code) }

// 시간 경과 — 저장된 시각을 과거로 민다
const age = (rows: any[], key: 'email' | 'phone', id: string, minutes: number) => {
  for (const r of rows.filter((x) => x[key] === id)) {
    for (const f of ['created_at', 'verified_at', 'expires_at']) if (r[f]) r[f] = new Date(new Date(r[f]).getTime() - minutes * 60_000)
  }
}

let n = 0
const uniq = (p: string) => `${p}${++n}`
const mail = () => `${uniq('u')}@test.local`
const phoneNo = () => `010${String(10_000_000 + ++n).slice(-8)}`

async function signup(email: string, phone = '') {
  const key = privateKeyToAccount(generatePrivateKey())
  // 클라이언트와 같은 신원 규칙 — 이메일, 없으면 phone:번호
  const sig = await key.signMessage({ message: { raw: CS.buildRegisterMessage(key.address, auth.signupIdentity(email || null, phone || null)) } })
  return auth.register(email, 'Passw0rd!x', 'tester', phone, key.address, sig, true, true, true, true, false)
}
const tries = async (fn: () => Promise<unknown>): Promise<{ ok: boolean; reason: string }> => {
  try { await fn(); return { ok: true, reason: '' } } catch (e: any) { return { ok: false, reason: e?.message ?? String(e) } }
}

// 수정 전 가입 판정 재현(대조군) — is_used=1 기록이 있으면 인증 완료
const legacyEmailOk = (email: string) => emailRows.some((r) => r.email === email && Boolean(r.is_used))
const legacyPhoneOk = (phone: string) => smsRows.some((r) => r.phone === phone && Boolean(r.is_used))

type Kind = 'attack' | 'normal' | 'control'
const rows: { kind: Kind; name: string; blocked: boolean; reason: string; ok: boolean }[] = []
const record = (kind: Kind, name: string, blocked: boolean, reason = '') =>
  rows.push({ kind, name, blocked, reason, ok: kind === 'attack' ? blocked : !blocked })

async function main() {
  console.log('\n[보안 테스트] 회원가입 본인 인증')

  // ═════ 1) 우회 공격 ══════════════════════════════════════════
  // (a) 재발송 무효화 — 코드를 입력하지 않고 재발송만
  {
    const e = mail()
    await auth.sendEmailCode(e); age(emailRows, 'email', e, 2); await auth.sendEmailCode(e)
    record('control', '대조군: 이메일 재발송만으로 인증 통과', !legacyEmailOk(e))
    const r = await tries(() => signup(e)); record('attack', '이메일 재발송 무효화로 가입', !r.ok, r.reason)
    const p = phoneNo()
    await auth.sendSmsCode(p); age(smsRows, 'phone', p, 2); await auth.sendSmsCode(p)
    record('control', '대조군: 휴대폰 재발송만으로 인증 통과', !legacyPhoneOk(p))
    const r2 = await tries(() => signup('', p)); record('attack', '휴대폰 재발송 무효화로 가입', !r2.ok, r2.reason)
  }
  // (b) 5회 실패 폐기
  {
    const e = mail()
    await auth.sendEmailCode(e)
    for (let i = 0; i < 6; i++) await tries(() => auth.verifyEmailCode(e, '000000'))
    record('control', '대조군: 이메일 5회 실패 폐기로 인증 통과', !legacyEmailOk(e))
    const r = await tries(() => signup(e)); record('attack', '이메일 5회 실패 폐기 후 가입', !r.ok, r.reason)
    const p = phoneNo()
    await auth.sendSmsCode(p)
    for (let i = 0; i < 6; i++) await tries(() => auth.verifySmsCode(p, '000000'))
    record('control', '대조군: 휴대폰 5회 실패 폐기로 인증 통과', !legacyPhoneOk(p))
    const r2 = await tries(() => signup('', p)); record('attack', '휴대폰 5회 실패 폐기 후 가입', !r2.ok, r2.reason)
  }
  // (c) 30분 경과한 인증 기록
  {
    const e = mail()
    await auth.sendEmailCode(e); await auth.verifyEmailCode(e, lastCode.get(e)!); age(emailRows, 'email', e, 31)
    record('control', '대조군: 31분 전 이메일 인증으로 통과', !legacyEmailOk(e))
    const r = await tries(() => signup(e)); record('attack', '31분 지난 이메일 인증으로 가입', !r.ok, r.reason)
    const p = phoneNo()
    await auth.sendSmsCode(p); await auth.verifySmsCode(p, lastCode.get(p)!); age(smsRows, 'phone', p, 31)
    const r2 = await tries(() => signup('', p)); record('attack', '31분 지난 휴대폰 인증으로 가입', !r2.ok, r2.reason)
  }
  // (d) 다른 용도의 인증을 가입에 재사용
  {
    const owner = { id: 9001, email: 'owner@test.local', status: 'active', email_changed_at: null, is_email_verified: true }
    users.push(owner)
    const p = phoneNo()
    await auth.sendPhoneCode(owner.id, p); await auth.verifyPhoneCode(owner.id, p, lastCode.get(p)!)
    users.find((u) => u.id === owner.id)!.phone = undefined // 마이페이지에서 인증만 하고 번호는 다른 계정으로 옮겨진 상황
    record('control', '대조군: 마이페이지 휴대폰 인증으로 가입 통과', !legacyPhoneOk(p))
    const r = await tries(() => signup('', p)); record('attack', '마이페이지 휴대폰 인증을 가입에 재사용', !r.ok, r.reason)
    const ne = mail()
    await auth.sendEmailChangeCode(owner.id, ne); await auth.verifyEmailChange(owner.id, ne, lastCode.get(ne)!)
    users.find((u) => u.id === owner.id)!.email = 'owner@test.local' // 변경 후 되돌린 상황 — ne 는 다시 비어 있음
    record('control', '대조군: 이메일 변경 인증으로 가입 통과', !legacyEmailOk(ne))
    const r2 = await tries(() => signup(ne)); record('attack', '이메일 변경 인증을 가입에 재사용', !r2.ok, r2.reason)
  }
  // (e) 인증 한 번으로 두 계정, 동시 가입 경합
  {
    const p = phoneNo()
    await auth.sendSmsCode(p); await auth.verifySmsCode(p, lastCode.get(p)!)
    const first = await tries(() => signup('', p))
    const second = await tries(() => signup('', p))
    record('normal', '휴대폰 인증 1회로 첫 계정 가입', !first.ok, first.reason)
    record('attack', '같은 휴대폰 인증으로 두 번째 계정', !second.ok, second.reason)

    const e = mail()
    await auth.sendEmailCode(e); await auth.verifyEmailCode(e, lastCode.get(e)!)
    const p2 = phoneNo()
    await auth.sendSmsCode(p2); await auth.verifySmsCode(p2, lastCode.get(p2)!)
    const race = await Promise.all([tries(() => signup('', p2)), tries(() => signup('', p2))])
    const okCount = race.filter((x) => x.ok).length
    // 방어 성공 = 정확히 1건만 가입(나머지는 소비 경합에서 되돌려짐)
    record('attack', '같은 인증으로 동시 가입 2건 — 1건만 성공', okCount === 1, race.find((x) => !x.ok)?.reason ?? '')
    void e
  }
  // (f) 미인증 번호 첨부, 인증 없이 가입
  {
    const e = mail()
    await auth.sendEmailCode(e); await auth.verifyEmailCode(e, lastCode.get(e)!)
    const r = await tries(() => signup(e, phoneNo())); record('attack', '이메일 인증 + 미인증 번호 첨부', !r.ok, r.reason)
    const r2 = await tries(() => signup(mail())); record('attack', '아무 인증 없이 가입', !r2.ok, r2.reason)
    const p3 = phoneNo()
    await auth.sendSmsCode(p3); await auth.verifySmsCode(p3, lastCode.get(p3)!)
    const victim = 'victim@test.local'
    const r3 = await tries(() => signup(victim, p3))
    record('attack', '휴대폰 인증 + 미인증 남의 이메일(이메일 선점)', !r3.ok, r3.reason)
  }

  // ═════ 2) 정상 가입 ══════════════════════════════════════════
  {
    const e = mail()
    await auth.sendEmailCode(e); await auth.verifyEmailCode(e, lastCode.get(e)!)
    const r = await tries(() => signup(e))
    const u = users.find((x) => x.email === e)
    record('normal', '이메일 단독 가입(정답 1회)', !(r.ok && u?.is_email_verified === true && u?.is_phone_verified === false), r.reason)
  }
  {
    const e = mail()
    await auth.sendEmailCode(e)
    await tries(() => auth.verifyEmailCode(e, '000000'))
    await auth.verifyEmailCode(e, lastCode.get(e)!)
    const r = await tries(() => signup(e)); record('normal', '오답 1회 후 정답', !r.ok, r.reason)
  }
  {
    const e = mail()
    await auth.sendEmailCode(e); await auth.verifyEmailCode(e, lastCode.get(e)!); age(emailRows, 'email', e, 29)
    const r = await tries(() => signup(e)); record('normal', '인증 29분 후 가입', !r.ok, r.reason)
  }
  let phoneOnlyUser: any = null
  {
    const p = phoneNo()
    await auth.sendSmsCode(p); await auth.verifySmsCode(p, lastCode.get(p)!)
    const r = await tries(() => signup('', p))
    phoneOnlyUser = users.find((x) => x.phone === p)
    if (!phoneOnlyUser) throw new Error(`휴대폰 단독 가입 실패: ${r.reason}`)
    record('normal', '휴대폰 단독 가입 — 이메일 없음, 휴대폰이 아이디',
      !(r.ok && phoneOnlyUser?.email === null && phoneOnlyUser?.is_email_verified === false && phoneOnlyUser?.is_phone_verified === true), r.reason)
    const wrongIdentity = await tries(async () => {
      const key = privateKeyToAccount(generatePrivateKey())
      const sig = await key.signMessage({ message: { raw: CS.buildRegisterMessage(key.address, 'phone:01099999999') } })
      const p2 = phoneNo()
      await auth.sendSmsCode(p2); await auth.verifySmsCode(p2, lastCode.get(p2)!)
      return auth.register('', 'Passw0rd!x', 'tester', p2, key.address, sig, true, true, true, true, false)
    })
    record('attack', '다른 번호에 묶인 가입 서명으로 휴대폰 가입', !wrongIdentity.ok, wrongIdentity.reason)
  }
  {
    const e = mail(), p = phoneNo()
    await auth.sendEmailCode(e); await auth.verifyEmailCode(e, lastCode.get(e)!)
    await auth.sendSmsCode(p); await auth.verifySmsCode(p, lastCode.get(p)!)
    const r = await tries(() => signup(e, p))
    const u = users.find((x) => x.email === e)
    record('normal', '이메일·휴대폰 둘 다 인증', !(r.ok && u?.is_email_verified && u?.is_phone_verified), r.reason)
  }

  // ═════ 3) 가입 후 ════════════════════════════════════════════
  {
    // 이전 규칙으로 만들어진 미인증 이메일 계정(데이터 이전분)에는 경보를 보내지 않는다
    users.push({ id: 9002, email: 'legacy-unverified@test.local', status: 'active', is_email_verified: false })
    record('attack', '미인증 이메일 계정에는 보안 경보 메일 미발송', !(await isAlertRecipientVerified('legacy-unverified@test.local')))
    record('normal', '인증 이메일 계정에는 보안 경보 메일 발송', !(await isAlertRecipientVerified(users.find((u) => u.is_email_verified && u.id !== 9001).email)))
    record('normal', '계정이 아닌 주소(관리자 경보 수신 등)는 발송', !(await isAlertRecipientVerified('ops@external.local')))
    // 휴대폰 가입자가 마이페이지에서 이메일 등록(인증 후)
    const added = mail()
    await auth.sendEmailChangeCode(phoneOnlyUser.id, added)
    await auth.verifyEmailChange(phoneOnlyUser.id, added, lastCode.get(added)!)
    record('normal', '휴대폰 가입자가 마이페이지에서 이메일 등록·인증', !(phoneOnlyUser.email === added && phoneOnlyUser.is_email_verified === true))
    record('normal', '이메일 등록 후 보안 경보 메일 발송', !(await isAlertRecipientVerified(added)))
  }

  // ── 출력 ─────────────────────────────────────────────────────
  const attacks = rows.filter((r) => r.kind === 'attack')
  const normals = rows.filter((r) => r.kind === 'normal')
  const controls = rows.filter((r) => r.kind === 'control')
  const blocked = attacks.filter((r) => r.blocked).length
  const failed = rows.filter((r) => !r.ok)
  console.log(`총 시도: ${attacks.length + normals.length}회 | 탐지: ${blocked}회 | 차단: ${blocked}회 | 탐지율: ${((blocked / attacks.length) * 100).toFixed(0)}%`)
  console.log(`  정상 가입·처리 오차단: ${normals.filter((r) => r.blocked).length}/${normals.length}`)
  console.log(`  대조군(수정 전 is_used 판정) 우회 성공: ${controls.filter((r) => !r.blocked).length}/${controls.length}`)
  for (const r of rows) {
    const tag = r.kind === 'attack' ? '공격' : r.kind === 'normal' ? '정상' : '대조'
    console.log(`  ${r.ok ? '✔' : '✘'} [${tag}] ${r.name} → ${r.blocked ? '차단' : '통과'}${r.reason ? `  ← ${r.reason}` : ''}`)
  }
  console.log(`검증 항목: ${rows.length - failed.length}건 통과 / ${failed.length}건 실패`)
  console.log(`판정: ${failed.length === 0 ? 'PASS' : 'FAIL'}`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('검증 실행 오류:', err)
  process.exit(1)
})
