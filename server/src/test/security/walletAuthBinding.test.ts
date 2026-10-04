/**
 * [보안 검증] 지갑 서명 인증의 신원 바인딩 (2026-10-01 결함 4건 수정)
 *
 * 블록체인 절을 쓰면서 코드와 대조하다 발견한 결함을 공격으로 재현하고, 수정 전 로직(대조군)과
 * 수정 후 실제 코드를 같은 입력으로 나란히 돌린다.
 *
 *   1) 로그인 2단계 신원 바인딩 — 본문 userId 바꿔치기, 1단계 생략, 챌린지 위조·재사용·만료,
 *      탈취한 신뢰 기기 쿠키만으로 로그인
 *   2) 비밀번호 변경 — 본문에 공격자 자신의 지갑을 넣어 2차 인증 통과
 *   3) 고액 주문 서명 — 서명 후 수량·방향·금액 바꿔치기, 지갑 없는 계정의 임의 서명
 *   4) 서명 재사용 — 블록 포함 전 같은 서명 재제출, 가입 서명을 첫 로그인 서명으로 사용,
 *      탈퇴 지갑 재등록
 *
 * 실제 코드를 그대로 호출하는 부분: loginStep2·changePassword 컨트롤러, authService.loginStep2·register,
 * verifyOrderSignature, 로그인 챌린지, 논스 소비 기록(submitVerified·claimNonce·usableNonce).
 * 메모리 스텁으로 바꾼 부분: DB 모델, 메일·위치 조회, 그리고 체인 — 체인 스텁은 컨트랙트와 같은
 * 규칙(등록 여부·논스 일치·ecrecover 서명자 복원)을 실제 secp256k1 서명으로 계산하며, 논스는
 * 테스트가 블록을 "채굴"할 때만 오른다(블록 포함 전 창 재현). 공유 DB·Sepolia 에 아무것도 쓰지 않는다.
 *
 * 실행: cd server && npx ts-node src/test/security/walletAuthBinding.test.ts
 */
import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { UniqueConstraintError } from 'sequelize'
import { recoverMessageAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import sequelize from '../../config/database'
import User from '../../models/user/User'
import Wallet from '../../models/user/Wallet'
import LoginRecord from '../../models/auth/LoginRecord'
import AnomalyLog from '../../models/auth/AnomalyLog'
import WalletNonceUse from '../../models/auth/WalletNonceUse'
import WithdrawnUser from '../../models/auth/WithdrawnUser'
import EmailVerification from '../../models/auth/EmailVerification'
import { changePassword, loginStep2 } from '../../controllers/auth/authController'
import * as authService from '../../services/auth/authService'
import { verifyOrderSignature, checkSignedAmount } from '../../services/trade/virtualTradeService'
import { issueLoginChallenge, LOGIN_CHALLENGE_COOKIE } from '../../services/auth/loginChallengeService'
import { SignatureReplayError } from '../../services/web3/contractService'

/* eslint-disable @typescript-eslint/no-var-requires */
const CS: any = require('../../services/web3/contractService')
const TD: any = require('../../services/auth/trustedDeviceService')
const EMAIL: any = require('../../services/auth/emailService')
const GEO: any = require('../../utils/getLocationFromIp')
const ANOMALY: any = require('../../services/auth/anomalyService')

// ── 집계 ───────────────────────────────────────────────────────
type Kind = 'attack' | 'normal' | 'control'
interface Row { group: string; name: string; kind: Kind; blocked: boolean; ok: boolean; reason: string }
const rows: Row[] = []
// 직전 차단 사유 — 공격이 "의도한 이유로" 막혔는지 출력으로 확인하기 위함
let lastReason = ''
// attack: 차단되어야 PASS / normal: 통과해야 PASS / control: 수정 전 로직 — 통과(=뚫림)를 재현해야 PASS
function record(group: string, name: string, kind: Kind, blocked: boolean): void {
  const ok = kind === 'attack' ? blocked : !blocked
  rows.push({ group, name, kind, blocked, ok, reason: blocked ? lastReason : '' })
  lastReason = ''
}
const attempt = async (fn: () => Promise<unknown>): Promise<boolean> => {
  try {
    await fn()
    return false
  } catch (e: any) {
    lastReason = e?.message ?? String(e)
    return true
  }
}

// ── 등장 인물 ──────────────────────────────────────────────────
const VICTIM = 101
const ATTACKER = 202
const NOWALLET = 303
const victimKey = privateKeyToAccount(generatePrivateKey())
const attackerKey = privateKeyToAccount(generatePrivateKey())
const strangerKey = privateKeyToAccount(generatePrivateKey())
const VICTIM_PW = 'Victim!2345'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/129.0 walletAuthBinding'
const IP_VICTIM = '198.51.100.21'
const IP_ATTACKER = '203.0.113.66'

// ── 체인 스텁 (컨트랙트와 같은 판정 규칙, 블록은 명시적으로 채굴) ─────────
const chain = {
  registered: new Set<string>(),
  authNonce: new Map<string, bigint>(),
  tradeNonce: new Map<string, bigint>(),
  pending: [] as { wallet: string; purpose: 'AUTH' | 'TRADE'; nonce: bigint; hash: string }[],
  mined: new Set<string>(),
  reverted: new Set<string>(),
  failNextSend: false,
}
const lc = (a: string) => a.toLowerCase()
let txSeq = 0
function mine(): void {
  for (const tx of chain.pending) {
    chain.mined.add(tx.hash)
    if (chain.reverted.has(tx.hash)) continue
    const m = tx.purpose === 'AUTH' ? chain.authNonce : chain.tradeNonce
    if ((m.get(tx.wallet) ?? 0n) === tx.nonce) m.set(tx.wallet, tx.nonce + 1n)
  }
  chain.pending = []
}
const send = (wallet: string, purpose: 'AUTH' | 'TRADE', nonce: bigint) => async (): Promise<`0x${string}`> => {
  if (chain.failNextSend) {
    chain.failNextSend = false
    throw new Error('RPC 전송 실패(모의)')
  }
  const hash = `0x${(++txSeq).toString(16).padStart(64, '0')}` as `0x${string}`
  chain.pending.push({ wallet: lc(wallet), purpose, nonce, hash })
  return hash
}
// simulateContract 와 같은 판정 — 등록·논스·서명자 복원
async function simulate(wallet: string, purpose: 'AUTH' | 'TRADE', nonce: bigint, message: `0x${string}`, sig: string) {
  const m = purpose === 'AUTH' ? chain.authNonce : chain.tradeNonce
  if (!chain.registered.has(lc(wallet))) throw new Error('Wallet not registered')
  if ((m.get(lc(wallet)) ?? 0n) !== nonce) throw new Error('Invalid nonce')
  let recovered = ''
  try {
    recovered = await recoverMessageAddress({ message: { raw: message }, signature: sig as `0x${string}` })
  } catch {
    throw new Error('Invalid signature')
  }
  if (lc(recovered) !== lc(wallet)) throw new Error('Invalid signature')
}
const simulateAuth = (w: string, n: bigint, sig: string) => simulate(w, 'AUTH', n, CS.buildAuthMessage(w, n), sig)

CS.getAuthNonce = async (w: string) => chain.authNonce.get(lc(w)) ?? 0n
CS.getTradeNonce = async (w: string) => chain.tradeNonce.get(lc(w)) ?? 0n
CS.isWalletRegistered = async (w: string) => chain.registered.has(lc(w))
CS.registerWalletFor = async (w: string) => { chain.registered.add(lc(w)) }
CS.verifySignature = async (w: string, n: bigint, sig: string) => {
  try {
    await simulateAuth(w, n, sig)
  } catch {
    throw new Error('MetaMask 서명이 올바르지 않습니다. 등록된 지갑 주소로 서명해주세요.')
  }
  await CS.submitVerified(w, 'AUTH', n, send(w, 'AUTH', n))
  return true
}
CS.verifyTradeSignature = async (w: string, n: bigint, amount: bigint, descriptor: string, sig: string) => {
  try {
    await simulate(w, 'TRADE', n, CS.buildTradeMessage(w, n, amount, descriptor), sig)
  } catch {
    throw new Error('MetaMask 서명이 올바르지 않습니다. 등록된 지갑 주소로 서명해주세요.')
  }
  await CS.submitVerified(w, 'TRADE', n, send(w, 'TRADE', n))
  return true
}
CS.chainProbe.getReceiptStatus = async (hash: string) => {
  if (!chain.mined.has(hash)) throw new Error('receipt not found')
  return chain.reverted.has(hash) ? 'reverted' : 'success'
}
CS.chainProbe.waitReceiptStatus = async (hash: string) => {
  mine()
  return chain.reverted.has(hash) ? 'reverted' : 'success'
}
CS.chainProbe.txExists = async () => true

// ── DB 스텁 ────────────────────────────────────────────────────
const nonceRows: any[] = []
const keyOf = (v: any) => `${v.wallet_address}|${v.purpose}|${v.nonce}`
const W = WalletNonceUse as any
W.create = async (v: any) => {
  if (nonceRows.some((r) => keyOf(r) === keyOf(v))) throw new UniqueConstraintError({ message: 'duplicate' })
  const row: any = { ...v, tx_hash: v.tx_hash ?? null, created_at: new Date() }
  row.destroy = async () => { const i = nonceRows.indexOf(row); if (i >= 0) nonceRows.splice(i, 1) }
  row.update = async (u: any) => Object.assign(row, u)
  nonceRows.push(row)
  return row
}
W.findOne = async ({ where }: any) =>
  nonceRows.find((r) => Object.entries(where).every(([k, v]) => String(r[k]) === String(v))) ?? null

const users = new Map<number, any>()
const wallets: any[] = []
;(User as any).findByPk = async (id: number) => users.get(Number(id)) ?? null
;(User as any).update = async (v: any, { where }: any) => { Object.assign(users.get(Number(where.id)) ?? {}, v) }
;(User as any).create = async (v: any) => { const u = { id: 900 + users.size, ...v }; users.set(u.id, u); return u }
;(Wallet as any).findOne = async ({ where }: any) =>
  wallets.find((w) =>
    (where.user_id === undefined || w.user_id === where.user_id) &&
    (where.address === undefined || lc(w.address) === lc(String(where.address)))) ?? null
;(Wallet as any).create = async (v: any) => { wallets.push(v); return v }
;(LoginRecord as any).create = async () => ({})
const anomalies: any[] = []
;(AnomalyLog as any).create = async (v: any) => { anomalies.push(v); return v }
;(AnomalyLog as any).findOne = async () => null
;(AnomalyLog as any).findAll = async () => []
;(WithdrawnUser as any).findOne = async () => null
;(EmailVerification as any).findOne = async () => ({ id: 1 })
;(EmailVerification as any).update = async () => [1]
// 가입은 인증 소비·사용자·지갑 생성을 트랜잭션으로 묶는다 — 실제 트랜잭션이 열리면 공유 DB 에 쓰게 되므로 막는다
;(sequelize as any).transaction = async () => ({ commit: async () => undefined, rollback: async () => undefined })

EMAIL.sendNewDeviceAlert = async () => undefined
EMAIL.sendAnomalyAlertEmail = async () => undefined
GEO.getLocationFromIp = async () => ({})
TD.verifyTrustedDevice = async (uid: number, token: string) => uid === VICTIM && token === 'victim-device-token'
ANOMALY.recordTradeAuthAttempt = async () => undefined

// ── 컨트롤러 호출 도우미 ──────────────────────────────────────
function mockRes() {
  const res: any = {
    locals: {}, cookies: {} as Record<string, string>, cleared: [] as string[], statusCode: 200, body: undefined,
    cookie(n: string, v: string) { this.cookies[n] = v; return this },
    clearCookie(n: string) { this.cleared.push(n); return this },
    status(c: number) { this.statusCode = c; return this },
    json(b: unknown) { this.body = b; return this },
  }
  return res
}
// 2단계 성공 = 액세스 토큰 발급
async function step2(cookies: Record<string, string>, body: Record<string, unknown>, ip: string): Promise<{ ok: boolean; res: any }> {
  const res = mockRes()
  const req: any = { body, cookies, headers: { 'user-agent': UA, 'x-forwarded-for': ip }, socket: { remoteAddress: ip } }
  await loginStep2(req, res, () => undefined)
  const ok = res.locals.loginSuccess === true && typeof res.cookies.accessToken === 'string'
  if (!ok) lastReason = String(res.locals.responseData?.message ?? '')
  return { ok, res }
}
const tokenOwner = (res: any): number | null => {
  try { return (jwt.verify(res.cookies.accessToken, process.env.JWT_SECRET as string) as any).id } catch { return null }
}
async function signAuth(key: typeof victimKey, wallet: string) {
  const nonce = await CS.getAuthNonce(wallet)
  return key.signMessage({ message: { raw: CS.buildAuthMessage(wallet, nonce) } })
}

// 수정 전 loginStep2 재현(대조군) — 본문 userId·walletAddress 를 그대로 신원으로 쓰고,
// 1단계 통과 여부와 지갑 소유를 확인하지 않았다. 반환값은 토큰이 발급되었을 사용자 번호.
async function legacyStep2(cookies: Record<string, string>, body: any): Promise<number | null> {
  const trusted = cookies.deviceToken ? await TD.verifyTrustedDevice(body.userId, cookies.deviceToken) : false
  if (!trusted && !body.signature) return null
  if (!trusted) {
    try {
      await simulateAuth(body.walletAddress, await CS.getAuthNonce(body.walletAddress), body.signature)
    } catch {
      return null
    }
  }
  return body.userId
}

async function main() {
  console.log('\n[보안 테스트] 지갑 서명 인증의 신원 바인딩')
  const vw = victimKey.address
  const aw = attackerKey.address
  users.set(VICTIM, { id: VICTIM, email: 'victim@test.local', name: 'victim', role: 'user', status: 'active', is_locked: false, password_hash: bcrypt.hashSync(VICTIM_PW, 4) })
  users.set(ATTACKER, { id: ATTACKER, email: 'mallory@test.local', name: 'mallory', role: 'user', status: 'active', is_locked: false, password_hash: bcrypt.hashSync('Mallory!2345', 4) })
  users.set(NOWALLET, { id: NOWALLET, email: 'nowallet@test.local', name: 'nowallet', role: 'user', status: 'active', is_locked: false, password_hash: '' })
  wallets.push({ user_id: VICTIM, address: vw.toLowerCase(), is_primary: true })
  wallets.push({ user_id: ATTACKER, address: aw.toLowerCase(), is_primary: true })
  chain.registered.add(lc(vw))
  chain.registered.add(lc(aw))

  // ═════ 1) 로그인 2단계 신원 바인딩 ═════════════════════════════
  const G1 = '로그인 2단계'
  {
    // 공격자는 자기 계정으로 1단계를 정상 통과하고(자기 비밀번호), 2단계 본문만 피해자 번호로 바꾼다.
    const sig = await signAuth(attackerKey, aw)
    const body = { userId: VICTIM, walletAddress: aw, signature: sig }
    record(G1, '대조군: 본문 userId 를 피해자로 바꿔 자기 지갑 서명', 'control', (await legacyStep2({}, body)) !== VICTIM)

    const challenge = issueLoginChallenge(ATTACKER, aw)
    const r = await step2({ [LOGIN_CHALLENGE_COOKIE]: challenge }, body, IP_ATTACKER)
    record(G1, '본문 userId 를 피해자로 바꿔 자기 지갑 서명', 'attack', !r.ok)
    const logged = anomalies.find((a) => a.anomaly_type === 'REQUEST_TAMPERING' && a.user_id === ATTACKER)
    record(G1, '바꿔치기 시도가 공격자 계정에 REQUEST_TAMPERING 으로 기록', 'normal', !logged)

    const r2 = await step2({}, body, IP_ATTACKER)
    record(G1, '1단계 없이(챌린지 없음) 2단계 직접 호출', 'attack', !r2.ok)

    const forged = jwt.sign({ typ: 'login_challenge', uid: VICTIM, wal: lc(aw) }, crypto.randomBytes(32), { expiresIn: 300, jwtid: 'x1' })
    record(G1, '임의 키로 위조한 챌린지', 'attack', !(await step2({ [LOGIN_CHALLENGE_COOKIE]: forged }, { signature: sig }, IP_ATTACKER)).ok)

    const accessTokenAsChallenge = jwt.sign({ id: VICTIM }, process.env.JWT_SECRET as string, { expiresIn: '10m' })
    record(G1, 'JWT_SECRET 서명 토큰(액세스 토큰)을 챌린지로 제출', 'attack',
      !(await step2({ [LOGIN_CHALLENGE_COOKIE]: accessTokenAsChallenge }, { signature: sig }, IP_ATTACKER)).ok)

    const noneAlg = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ typ: 'login_challenge', uid: VICTIM, wal: lc(aw), jti: 'n' })).toString('base64url')}.`
    record(G1, 'alg=none 무서명 챌린지', 'attack', !(await step2({ [LOGIN_CHALLENGE_COOKIE]: noneAlg }, { signature: sig }, IP_ATTACKER)).ok)

    const key = crypto.createHmac('sha256', process.env.JWT_SECRET as string).update('uptick/login-challenge/v1').digest()
    const expired = jwt.sign({ typ: 'login_challenge', uid: ATTACKER, wal: lc(aw), exp: Math.floor(Date.now() / 1000) - 10 }, key, { jwtid: 'e1' })
    record(G1, '만료된 챌린지', 'attack', !(await step2({ [LOGIN_CHALLENGE_COOKIE]: expired }, { signature: sig }, IP_ATTACKER)).ok)

    // 탈취한 신뢰 기기 쿠키만 가진 공격자(비밀번호 모름) — 수정 전에는 1단계를 건너뛰고 통과했다.
    const stolen = { deviceToken: 'victim-device-token' }
    record(G1, '대조군: 탈취한 신뢰 기기 쿠키만으로 2단계', 'control',
      (await legacyStep2(stolen, { userId: VICTIM, walletAddress: vw })) !== VICTIM)
    record(G1, '탈취한 신뢰 기기 쿠키만으로 2단계', 'attack',
      !(await step2(stolen, { userId: VICTIM, walletAddress: vw }, IP_ATTACKER)).ok)

    // 서비스 계층 단독 방어 — 컨트롤러를 우회해 호출돼도 남의 지갑 서명은 거부된다.
    const sig2 = await signAuth(attackerKey, aw)
    record(G1, 'authService.loginStep2 에 남의 지갑 서명 직접 전달', 'attack',
      await attempt(() => authService.loginStep2(VICTIM, aw, sig2, IP_ATTACKER, UA, false)))
    mine()
  }
  {
    // 정상 사용자 — 지갑 서명 로그인, 신뢰 기기 로그인, 그리고 같은 챌린지 재사용 차단
    const c = issueLoginChallenge(VICTIM, vw)
    const sig = await signAuth(victimKey, vw)
    const r = await step2({ [LOGIN_CHALLENGE_COOKIE]: c }, { userId: VICTIM, walletAddress: vw, signature: sig }, IP_VICTIM)
    record(G1, '정상: 1단계 → 지갑 서명 2단계', 'normal', !(r.ok && tokenOwner(r.res) === VICTIM))
    record(G1, '정상 로그인 후 챌린지 쿠키 삭제', 'normal', !r.res.cleared.includes(LOGIN_CHALLENGE_COOKIE))
    mine()

    const sigAgain = await signAuth(victimKey, vw)
    record(G1, '이미 사용된 챌린지로 2단계 재시도', 'attack',
      !(await step2({ [LOGIN_CHALLENGE_COOKIE]: c }, { userId: VICTIM, walletAddress: vw, signature: sigAgain }, IP_VICTIM)).ok)

    const c2 = issueLoginChallenge(VICTIM, vw)
    const t = await step2({ [LOGIN_CHALLENGE_COOKIE]: c2, deviceToken: 'victim-device-token' }, { userId: VICTIM, walletAddress: vw }, IP_VICTIM)
    record(G1, '정상: 1단계 → 신뢰 기기(서명 생략) 2단계', 'normal', !(t.ok && tokenOwner(t.res) === VICTIM))

    const c3 = issueLoginChallenge(VICTIM, vw)
    const sig3 = await signAuth(victimKey, vw)
    record(G1, '정상: 본문 신원값 없이 챌린지만으로 2단계(컨트롤러 단독)', 'normal',
      !(await step2({ [LOGIN_CHALLENGE_COOKIE]: c3 }, { signature: sig3 }, IP_VICTIM)).ok)
    mine()
  }

  {
    // 챌린지 쿠키는 1단계 "성공 응답"에만 실린다. 무차별 대입 차단(403) 응답에 실리면
    // 차단된 공격자도 2단계로 넘어갈 수 있다. 실제 analyzeAfterLogin 미들웨어로 확인한다.
    const { analyzeAfterLogin } = require('../../middleware/auth/anomalyMiddleware')
    const original = ANOMALY.analyzeLoginAttempt
    const runStep1Response = async (blocked: boolean) => {
      ANOMALY.analyzeLoginAttempt = async () => ({ blocked, locked: false, anomalies: blocked ? ['BRUTE_FORCE'] : [], reasons: [], userMessages: [] })
      const res = mockRes()
      res.locals = {
        loginSuccess: true, loginEmail: 'mallory@test.local', loginUserId: ATTACKER,
        loginChallenge: issueLoginChallenge(ATTACKER, aw), responseData: { message: 'ok' }, responseStatus: 200,
      }
      const req: any = { body: {}, cookies: {}, headers: { 'user-agent': UA, 'x-forwarded-for': IP_ATTACKER }, socket: { remoteAddress: IP_ATTACKER } }
      await analyzeAfterLogin(req, res, () => undefined)
      return res
    }
    const blockedRes = await runStep1Response(true)
    lastReason = `${blockedRes.statusCode} ${blockedRes.body?.code ?? ''}`
    record(G1, '무차별 대입 차단(403) 응답에 챌린지 쿠키 미포함', 'attack',
      blockedRes.statusCode === 403 && blockedRes.cookies[LOGIN_CHALLENGE_COOKIE] === undefined)
    const okRes = await runStep1Response(false)
    record(G1, '정상: 1단계 성공 응답에 챌린지 쿠키 포함', 'normal', typeof okRes.cookies[LOGIN_CHALLENGE_COOKIE] !== 'string')
    ANOMALY.analyzeLoginAttempt = original
  }

  // ═════ 2) 비밀번호 변경 ════════════════════════════════════════
  const G2 = '비밀번호 변경'
  {
    const call = async (body: any) => {
      const res = mockRes()
      await changePassword({ user: { id: VICTIM }, body } as any, res)
      if (res.statusCode !== 200) lastReason = `${res.statusCode} ${res.body?.message ?? ''}`
      return res.statusCode === 200
    }
    // 세션을 탈취했고 현재 비밀번호도 알지만 피해자 지갑은 없는 공격자
    const atkSig = await signAuth(attackerKey, aw)
    const legacyPasses = await (async () => {
      try {
        await simulateAuth(aw, await CS.getAuthNonce(aw), atkSig)
        return true
      } catch {
        return false
      }
    })()
    record(G2, '대조군: 본문에 공격자 지갑·서명', 'control', !legacyPasses)
    record(G2, '본문에 공격자 지갑·서명', 'attack',
      !(await call({ currentPassword: VICTIM_PW, newPassword: 'Hijack!2345', walletAddress: aw, signature: atkSig })))
    record(G2, '본문 지갑 생략 + 공격자 서명', 'attack',
      !(await call({ currentPassword: VICTIM_PW, newPassword: 'Hijack!2345', signature: atkSig })))
    record(G2, '서명 없이 변경', 'attack', !(await call({ currentPassword: VICTIM_PW, newPassword: 'Hijack!2345' })))
    record(G2, '피해자 서명 + 틀린 현재 비밀번호', 'attack',
      !(await call({ currentPassword: 'wrong!2345', newPassword: 'Hijack!2345', walletAddress: vw, signature: await signAuth(victimKey, vw) })))
    mine()
    record(G2, '정상: 본인 지갑 서명 + 현재 비밀번호', 'normal',
      !(await call({ currentPassword: VICTIM_PW, newPassword: 'Changed!2345', walletAddress: vw, signature: await signAuth(victimKey, vw) })))
    mine()
  }

  // ═════ 3) 고액 주문 서명 바인딩 ════════════════════════════════
  const G3 = '고액 주문 서명'
  {
    // 클라이언트(OrderPanel)와 같은 방식으로 서명한다.
    const clientSign = async (o: { side: 'buy' | 'sell'; orderType: 'market' | 'limit'; quantity: number; price: number; limitPrice?: number }) => {
      const nonce = await CS.getTradeNonce(vw)
      const amount = BigInt(Math.round(o.price * o.quantity))
      const descriptor = CS.buildTradeDescriptor({ stockCode: '005930', side: o.side, orderType: o.orderType, quantity: o.quantity, limitPrice: o.limitPrice })
      const sig = await victimKey.signMessage({ message: { raw: CS.buildTradeMessage(vw, nonce, amount, descriptor) } })
      return { sig, amount, nonce }
    }
    const verify = (o: any) => attempt(() => verifyOrderSignature({ userId: VICTIM, stockCode: '005930', ipAddress: IP_VICTIM, userAgent: UA, ...o }))
    // 수정 전 서버: 서명 대상 = (본문 signedAmount, 종목 코드). 수량·방향은 서명 밖이었다.
    const legacyVerify = async (signed: { sig: string; amount: bigint; nonce: bigint }) => {
      const legacyMsg = CS.buildTradeMessage(vw, signed.nonce, signed.amount, '005930')
      const legacySig = await victimKey.signMessage({ message: { raw: legacyMsg } })
      try {
        await simulate(vw, 'TRADE', signed.nonce, legacyMsg, legacySig)
        return true
      } catch {
        return false
      }
    }

    const s1 = await clientSign({ side: 'buy', orderType: 'market', quantity: 10, price: 70_000 })
    record(G3, '대조군: 수량이 서명 밖 — 10주 서명이 1,000주 주문에도 유효', 'control', !(await legacyVerify(s1)))
    record(G3, '10주 서명으로 1,000주 주문(금액도 1,000주로)', 'attack',
      await verify({ side: 'buy', orderType: 'market', quantity: 1000, signedAmount: 70_000_000n, tradeSignature: s1.sig, actualAmount: 70_000_000 }))
    record(G3, '10주 서명으로 1,000주 주문(서명 금액 유지)', 'attack',
      await verify({ side: 'buy', orderType: 'market', quantity: 1000, signedAmount: s1.amount, tradeSignature: s1.sig, actualAmount: 70_000_000 }))
    record(G3, '매수 서명을 매도 주문에 사용', 'attack',
      await verify({ side: 'sell', orderType: 'market', quantity: 10, signedAmount: s1.amount, tradeSignature: s1.sig, actualAmount: 700_000 }))
    record(G3, '시장가 서명을 지정가 주문에 사용', 'attack',
      await verify({ side: 'buy', orderType: 'limit', quantity: 10, limitPrice: 70_000, signedAmount: s1.amount, tradeSignature: s1.sig, actualAmount: 700_000 }))
    record(G3, '서명 금액 누락', 'attack',
      await verify({ side: 'buy', orderType: 'market', quantity: 10, tradeSignature: s1.sig, actualAmount: 700_000 }))
    record(G3, '정상: 시장가 — 서명 후 가격 +2.9% 변동', 'normal',
      await verify({ side: 'buy', orderType: 'market', quantity: 10, signedAmount: s1.amount, tradeSignature: s1.sig, actualAmount: 720_300 }))
    mine()

    const s2 = await clientSign({ side: 'buy', orderType: 'market', quantity: 10, price: 70_000 })
    record(G3, '시장가 — 서명 후 가격 +3.1% 변동(재서명 요구)', 'attack',
      await verify({ side: 'buy', orderType: 'market', quantity: 10, signedAmount: s2.amount, tradeSignature: s2.sig, actualAmount: 721_700 }))

    const s3 = await clientSign({ side: 'sell', orderType: 'limit', quantity: 5, price: 71_000, limitPrice: 71_000 })
    record(G3, '지정가 서명의 지정가를 바꿔 제출', 'attack',
      await verify({ side: 'sell', orderType: 'limit', quantity: 5, limitPrice: 75_000, signedAmount: 375_000n, tradeSignature: s3.sig, actualAmount: 375_000 }))
    record(G3, '정상: 지정가 매도', 'normal',
      await verify({ side: 'sell', orderType: 'limit', quantity: 5, limitPrice: 71_000, signedAmount: s3.amount, tradeSignature: s3.sig, actualAmount: 355_000 }))
    record(G3, '정상 매도 서명을 블록 포함 전 재제출', 'attack',
      await verify({ side: 'sell', orderType: 'limit', quantity: 5, limitPrice: 71_000, signedAmount: s3.amount, tradeSignature: s3.sig, actualAmount: 355_000 }))
    mine()

    // 수정 전: `if (tradeSignature && wallet)` — 지갑이 없으면 서명 검증 자체를 건너뛰고 주문을 진행했다.
    const legacyWalletless = async (tradeSignature: string) => {
      const wallet = await Wallet.findOne({ where: { user_id: NOWALLET } })
      return !(tradeSignature && wallet) // 검증 블록에 들어가지 않음 = 그대로 체결 단계로 진행
    }
    record(G3, '대조군: 지갑 없는 계정의 임의 서명(검증 생략)', 'control', !(await legacyWalletless('0xdead')))
    record(G3, '지갑 없는 계정의 임의 서명', 'attack',
      await attempt(() => verifyOrderSignature({ userId: NOWALLET, side: 'buy', stockCode: '005930', orderType: 'market', quantity: 1, signedAmount: 1n, tradeSignature: '0xdead', actualAmount: 1, ipAddress: IP_ATTACKER })))

    // 금액 판정 경계값(순수 함수)
    const edge: [string, 'market' | 'limit', bigint | undefined, number, boolean][] = [
      ['시장가 +3.0% 정확히', 'market', 1_000_000n, 1_030_000, false],
      ['시장가 −3.0% 정확히', 'market', 1_000_000n, 970_000, false],
      ['시장가 −3.1%', 'market', 1_000_000n, 969_000, true],
      ['지정가 1원 차이', 'limit', 1_000_000n, 1_000_001, true],
      ['서명 금액 0', 'market', 0n, 1_000_000, true],
    ]
    for (const [name, type, signed, actual, expectBlocked] of edge) {
      record(G3, `경계: ${name}`, expectBlocked ? 'attack' : 'normal', await attempt(async () => checkSignedAmount(type, signed, actual)))
    }
  }

  // ═════ 4) 서명 재사용 ══════════════════════════════════════════
  const G4 = '서명 재사용'
  {
    // (a) 블록 포함 전 창
    const n = await CS.getAuthNonce(vw)
    const sig = await signAuth(victimKey, vw)
    await CS.verifySignature(vw, n, sig) // 정상 소비, 아직 블록 미포함
    record(G4, '대조군: 포함 전 같은 서명 사전 실행(소비 기록 없음)', 'control', await attempt(() => simulateAuth(vw, n, sig)))
    let replayErr: unknown = null
    try { await CS.verifySignature(vw, n, sig) } catch (e) { replayErr = e }
    record(G4, '포함 전 같은 서명 재제출', 'attack', replayErr instanceof SignatureReplayError)

    // 2단계 컨트롤러 경유 — 가로챈 서명 재전송은 REPLAY_ATTACK 으로 기록된다
    const before = anomalies.length
    const r = await step2({ [LOGIN_CHALLENGE_COOKIE]: issueLoginChallenge(VICTIM, vw) }, { signature: sig }, IP_ATTACKER)
    record(G4, '포함 전 같은 서명으로 다른 세션 로그인', 'attack', !r.ok)
    record(G4, '재전송 시도가 REPLAY_ATTACK 으로 기록', 'normal',
      !anomalies.slice(before).some((a) => a.anomaly_type === 'REPLAY_ATTACK' && a.user_id === VICTIM))

    // 다음 서명용 논스 — 포함을 기다린 뒤 새 논스를 돌려줘야 한다(옛 논스면 정상 사용자가 막힌다)
    const next = await CS.usableNonce(vw, 'AUTH', () => CS.getAuthNonce(vw))
    record(G4, '정상: 포함 전 재로그인 시 새 논스 발급(대기 후)', 'normal', next !== n + 1n)
    record(G4, '포함 후 같은 서명 재제출', 'attack', await attempt(() => CS.verifySignature(vw, n, sig)))

    // (b) 전송 실패 시 소비 기록 회수 — 정당한 재시도가 막히지 않아야 한다
    const n2 = await CS.getAuthNonce(vw)
    const sig2 = await signAuth(victimKey, vw)
    chain.failNextSend = true
    await attempt(() => CS.verifySignature(vw, n2, sig2))
    record(G4, '정상: RPC 전송 실패 후 같은 서명 재시도', 'normal', await attempt(() => CS.verifySignature(vw, n2, sig2)))
    mine()

    // (c) 되돌려진 트랜잭션 — 체인에서 소비되지 않았으므로 같은 논스를 다시 쓸 수 있어야 한다
    const n3 = await CS.getAuthNonce(vw)
    const sig3 = await signAuth(victimKey, vw)
    await CS.verifySignature(vw, n3, sig3)
    chain.reverted.add(chain.pending[chain.pending.length - 1].hash)
    mine()
    record(G4, '정상: 되돌려진 검증 후 같은 논스 재서명', 'normal', await attempt(() => CS.verifySignature(vw, n3, sig3)))
    mine()

    // (d) 가입 서명 = 첫 로그인 서명이던 문제
    const fresh = privateKeyToAccount(generatePrivateKey())
    chain.registered.add(lc(fresh.address))
    const legacyRegSig = await fresh.signMessage({ message: { raw: CS.buildAuthMessage(fresh.address, 0n) } })
    record(G4, '대조군: 수정 전 가입 서명을 첫 로그인 서명으로 사용', 'control', await attempt(() => simulateAuth(fresh.address, 0n, legacyRegSig)))
    const regSig = await fresh.signMessage({ message: { raw: CS.buildRegisterMessage(fresh.address, 'new@test.local') } })
    record(G4, '가입 서명을 첫 로그인 서명으로 사용', 'attack', await attempt(() => simulateAuth(fresh.address, 0n, regSig)))
    const recoveredOther = await recoverMessageAddress({ message: { raw: CS.buildRegisterMessage(fresh.address, 'other@test.local') }, signature: regSig })
    record(G4, '가입 서명을 다른 이메일 가입에 사용', 'attack', lc(recoveredOther) !== lc(fresh.address))

    // (e) 탈퇴 지갑 재등록 — 과거 논스 사용 이력이 있는 지갑은 가입 거부
    const register = (wallet: string, email: string, signature: string) =>
      attempt(() => authService.register(email, 'Passw0rd!x', 'tester', '', wallet, signature, true, true, true, true, false))
    const victimRegSig = await victimKey.signMessage({ message: { raw: CS.buildRegisterMessage(vw, 'again@test.local') } })
    chain.registered.delete(lc(vw)) // 탈퇴로 온체인 등록 해제된 상태
    wallets.splice(wallets.findIndex((w) => w.user_id === VICTIM), 1)
    record(G4, '탈퇴 지갑으로 재가입(과거 서명 부활 경로)', 'attack', await register(vw, 'again@test.local', victimRegSig))
    const brandNew = privateKeyToAccount(generatePrivateKey())
    const brandSig = await brandNew.signMessage({ message: { raw: CS.buildRegisterMessage(brandNew.address, 'brand@test.local') } })
    record(G4, '정상: 새 지갑으로 가입', 'normal', await register(brandNew.address, 'brand@test.local', brandSig))
    record(G4, '가입 서명의 지갑과 다른 지갑 주소로 가입', 'attack',
      await register(strangerKey.address, 'stranger@test.local', brandSig))
  }

  // ── 출력 ─────────────────────────────────────────────────────
  const attacks = rows.filter((r) => r.kind === 'attack')
  const normals = rows.filter((r) => r.kind === 'normal')
  const controls = rows.filter((r) => r.kind === 'control')
  const blocked = attacks.filter((r) => r.blocked).length
  const falseBlocks = normals.filter((r) => r.blocked).length
  const controlBreached = controls.filter((r) => !r.blocked).length
  const failed = rows.filter((r) => !r.ok)

  console.log(`총 시도: ${attacks.length + normals.length}회 | 탐지: ${blocked}회 | 차단: ${blocked}회 | 탐지율: ${((blocked / attacks.length) * 100).toFixed(0)}%`)
  console.log(`  정상 요청 오차단: ${falseBlocks}/${normals.length} (오탐률 ${((falseBlocks / normals.length) * 100).toFixed(1)}%)`)
  console.log(`  대조군(수정 전 로직) 우회 성공: ${controlBreached}/${controls.length}`)
  for (const g of [...new Set(rows.map((r) => r.group))]) {
    const rs = rows.filter((r) => r.group === g)
    const a = rs.filter((r) => r.kind === 'attack')
    console.log(`  - ${g}: 공격 ${a.filter((r) => r.blocked).length}/${a.length} 차단 · 정상 ${rs.filter((r) => r.kind === 'normal' && !r.blocked).length}/${rs.filter((r) => r.kind === 'normal').length} 통과 · 대조군 우회 ${rs.filter((r) => r.kind === 'control' && !r.blocked).length}/${rs.filter((r) => r.kind === 'control').length}`)
    for (const r of rs) {
      const tag = r.kind === 'attack' ? '공격' : r.kind === 'normal' ? '정상' : '대조'
      console.log(`      ${r.ok ? '✔' : '✘'} [${tag}] ${r.name} → ${r.blocked ? '차단' : '통과'}${r.reason ? `  ← ${r.reason}` : ''}`)
    }
  }
  console.log(`검증 항목: ${rows.length - failed.length}건 통과 / ${failed.length}건 실패`)
  console.log(`판정: ${failed.length === 0 ? 'PASS' : 'FAIL'}`)
  await sequelize.close().catch(() => undefined)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch(async (err) => {
  console.error('검증 실행 오류:', err)
  await sequelize.close().catch(() => undefined)
  process.exit(1)
})
