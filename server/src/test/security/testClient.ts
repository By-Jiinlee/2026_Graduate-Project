import axios from 'axios'
import User from '../../models/user/User'
import { registerTrustedDevice, DEVICE_COOKIE_NAME } from '../../services/auth/trustedDeviceService'

// ─────────────────────────────────────────────────────────────
// 보안 E2E 테스트 공통 클라이언트
//
// 실제 실행 중인 서버에 HTTP 요청을 보내기 위한 최소 도구 모음이다.
// 공격 트래픽은 RFC 5737 문서용 예약 대역(203.0.113.0/24)에서 오는 것으로 위조하여,
// 로컬 요청이 아닌 외부 접속으로 서버가 인식하도록 한다(app.set('trust proxy', true)).
// ─────────────────────────────────────────────────────────────

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) UpTick-SecurityTest/1.0 Chrome/120'

export const IP = {
  LOGIN:      '203.0.113.10',
  NORMAL:     '203.0.113.11',
  TAMPER:     '203.0.113.21',
  EXPIRE:     '203.0.113.22',
  REPLAY:     '203.0.113.23',
  MALFORMED:  '203.0.113.31',
  EXTRACTION: '203.0.113.32',
  ANON:       '203.0.113.33',
  TRADE:      '203.0.113.41',
} as const

const args = process.argv.slice(2)

export function arg(name: string, fallback?: string): string {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : (process.env[`TEST_${name.toUpperCase()}`] ?? fallback ?? '')
}

export function hasFlag(name: string): boolean {
  return args.includes(`--${name}`)
}

export const BASE = arg('url', 'http://localhost:3000').replace(/\/$/, '')

export function die(msg: string): never {
  console.error(`\n[중단] ${msg}\n`)
  process.exit(2)
}

export interface Res { status: number; data: any; headers: Record<string, any> }

export interface ReqOptions {
  ip: string
  cookie?: string
  /** HMAC 서명 헤더 */
  sign?: { ts: string; nonce: string; sig: string }
  headers?: Record<string, string>
}

/** 본문 문자열을 그대로(재직렬화 없이) 전송한다 — 서명 대상과 바이트 단위로 일치시키기 위함 */
export async function post(path: string, body: string, opts: ReqOptions): Promise<Res> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': UA,
    'X-Forwarded-For': opts.ip,
    ...(opts.headers ?? {}),
  }
  if (opts.cookie) headers['Cookie'] = opts.cookie
  if (opts.sign) {
    headers['X-Signature'] = opts.sign.sig
    headers['X-Timestamp'] = opts.sign.ts
    headers['X-Nonce'] = opts.sign.nonce
  }

  const res = await axios.post(`${BASE}${path}`, body, {
    headers,
    validateStatus: () => true,
    transformRequest: [(d: unknown) => d],
  } as any)
  return { status: res.status, data: res.data, headers: res.headers as any }
}

export async function get(path: string, opts: ReqOptions): Promise<Res> {
  const headers: Record<string, string> = {
    'User-Agent': UA,
    'X-Forwarded-For': opts.ip,
    ...(opts.headers ?? {}),
  }
  if (opts.cookie) headers['Cookie'] = opts.cookie

  const res = await axios.get(`${BASE}${path}`, { headers, validateStatus: () => true })
  return { status: res.status, data: res.data, headers: res.headers as any }
}

// DELETE 도 상태 변경 요청이라 hmacMiddleware 의 검증 대상이다(GET/HEAD 만 통과).
// 본문이 없는 요청은 서버 rawBody 가 빈 문자열이므로 빈 문자열에 서명해야 한다 —
// 클라이언트 tradeSigning.signedFetch 와 동일한 규약.
export async function del(path: string, opts: ReqOptions): Promise<Res> {
  const headers: Record<string, string> = {
    'User-Agent': UA,
    'X-Forwarded-For': opts.ip,
    ...(opts.headers ?? {}),
  }
  if (opts.cookie) headers['Cookie'] = opts.cookie
  if (opts.sign) {
    headers['X-Signature'] = opts.sign.sig
    headers['X-Timestamp'] = opts.sign.ts
    headers['X-Nonce'] = opts.sign.nonce
  }

  const res = await axios.delete(`${BASE}${path}`, { headers, validateStatus: () => true })
  return { status: res.status, data: res.data, headers: res.headers as any }
}

export function parseCookies(setCookie: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of setCookie ?? []) {
    const [pair] = line.split(';')
    const idx = pair.indexOf('=')
    if (idx > 0) out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim()
  }
  return out
}

export interface TestSession {
  userId: number
  cookie: string
  /** 로그인 2단계에서 발급된 HMAC 세션 서명키 */
  signingSecret: string
}

/**
 * 테스트 계정으로 로그인해 세션을 확보한다.
 *
 * 2단계 지갑 서명은 운영 기능인 "이 기기 기억하기"(신뢰 기기) 경로로 생략한다.
 * 테스트를 위한 우회 경로를 서버에 새로 만들지 않기 위한 선택이며, 신뢰 기기 등록은
 * 실사용자와 동일한 서비스 API·검증 로직을 그대로 통과한다.
 *
 * ※ 신뢰 기기는 device_type(PC/모바일)별로 upsert 되므로 테스트 계정의 기존 PC 기기
 *   신뢰가 덮어써진다. 반드시 전용 테스트 계정으로 실행할 것.
 */
export async function loginAsTestUser(
  email: string,
  password: string,
  requirePhoneVerified = true,
  // 로그인 레이트 리미터는 IP 단위(15회/15분)라 고정 IP 로 반복 실행하면 스크립트 자신이
  // 막힌다. 반복 실행하는 검증에서는 실행마다 다른 위조 IP 를 넘긴다.
  loginIp: string = IP.LOGIN,
): Promise<TestSession> {
  const user = await User.findOne({ where: { email } })
  if (!user) die(`테스트 계정을 찾을 수 없습니다: ${email}`)
  if (requirePhoneVerified && !user.is_phone_verified) {
    die('테스트 계정의 휴대폰 인증이 완료되지 않아 거래 라우트에 도달할 수 없습니다.')
  }

  const deviceToken = await registerTrustedDevice(user.id, UA, loginIp)
  const deviceCookie = `${DEVICE_COOKIE_NAME}=${deviceToken}`

  const step1 = await post('/api/auth/login/step1', JSON.stringify({ email, password }), {
    ip: loginIp,
    cookie: deviceCookie,
  })
  if (step1.status !== 200) die(`1단계 로그인 실패: ${step1.status} ${JSON.stringify(step1.data)}`)
  if (!step1.data.isTrustedDevice) die('신뢰 기기로 인정되지 않았습니다(지갑 서명 필요 상태).')

  const step2 = await post(
    '/api/auth/login/step2',
    JSON.stringify({ userId: step1.data.userId, walletAddress: step1.data.walletAddress }),
    { ip: loginIp, cookie: deviceCookie },
  )
  if (step2.status !== 200) die(`2단계 로그인 실패: ${step2.status} ${JSON.stringify(step2.data)}`)

  const jar = parseCookies(step2.headers['set-cookie'] as string[] | undefined)
  if (!jar.accessToken) die('accessToken 쿠키를 받지 못했습니다.')
  if (!step2.data.signingSecret) die('세션 서명키(signingSecret)를 받지 못했습니다.')

  return {
    userId: user.id,
    cookie: `accessToken=${jar.accessToken}`,
    signingSecret: step2.data.signingSecret,
  }
}
