import crypto from 'crypto'
import jwt from 'jsonwebtoken'

// ─────────────────────────────────────────────────────────────
// 로그인 1단계 → 2단계 바인딩
//
// 2단계는 요청 본문의 userId·walletAddress 를 그대로 믿었고, 1단계를 거쳤는지도 확인하지
// 않았다. 그 결과 자신의 등록 지갑으로 서명만 하면 본문의 userId 를 남의 번호로 바꿔
// 비밀번호 없이 그 계정의 토큰을 받을 수 있었다. 신뢰 기기 쿠키를 탈취한 경우에도
// 1단계(비밀번호)를 건너뛰고 2단계만으로 로그인되었다.
//
// 1단계가 성공하면 서버가 (사용자 번호, 등록 지갑) 을 서명한 단기 토큰을 httpOnly 쿠키로
// 내려주고, 2단계는 이 토큰에서만 신원을 꺼낸다. 본문 값은 비교 대상일 뿐 신원의 근거가 아니다.
//
// 서명 키는 JWT_SECRET 에서 용도별로 파생한다. 같은 키를 쓰면 이 토큰이 액세스 토큰
// 검증을 통과할 수 있기 때문이다(형식이 달라도 서명만 맞으면 통과하는 검증부가 있을 수 있다).
// ─────────────────────────────────────────────────────────────

export const LOGIN_CHALLENGE_COOKIE = 'loginChallenge'
export const LOGIN_CHALLENGE_TTL_MS = 5 * 60 * 1000
const TOKEN_TYPE = 'login_challenge'

const challengeKey = (): Buffer => {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error('JWT_SECRET 이 설정되지 않았습니다')
  return crypto.createHmac('sha256', secret).update('uptick/login-challenge/v1').digest()
}

export interface LoginChallenge {
  userId: number
  walletAddress: string
  jti: string
}

export class LoginChallengeError extends Error {
  constructor(message = '로그인 1단계부터 다시 진행해주세요') {
    super(message)
    this.name = 'LoginChallengeError'
  }
}

// 사용된 챌린지 — 같은 1단계 결과로 2단계를 두 번 통과하지 못하게 한다.
// 만료 시각까지만 보관하면 되므로 메모리로 충분하다(재시작 시 비는 창은 만료 5분 이내로 한정).
const consumed = new Map<string, number>()

const sweep = (now: number) => {
  for (const [jti, exp] of consumed) if (exp <= now) consumed.delete(jti)
}

export const issueLoginChallenge = (userId: number, walletAddress: string): string =>
  jwt.sign(
    { typ: TOKEN_TYPE, uid: userId, wal: walletAddress.toLowerCase() },
    challengeKey(),
    { algorithm: 'HS256', expiresIn: Math.floor(LOGIN_CHALLENGE_TTL_MS / 1000), jwtid: crypto.randomUUID() },
  )

export const readLoginChallenge = (token: unknown): LoginChallenge => {
  if (typeof token !== 'string' || token.length === 0) throw new LoginChallengeError()
  let payload: any
  try {
    payload = jwt.verify(token, challengeKey(), { algorithms: ['HS256'] })
  } catch {
    throw new LoginChallengeError()
  }
  if (
    payload?.typ !== TOKEN_TYPE ||
    !Number.isSafeInteger(payload.uid) || payload.uid <= 0 ||
    typeof payload.wal !== 'string' || !/^0x[0-9a-f]{40}$/.test(payload.wal) ||
    typeof payload.jti !== 'string'
  ) {
    throw new LoginChallengeError()
  }
  if (consumed.has(payload.jti)) throw new LoginChallengeError()
  return { userId: payload.uid, walletAddress: payload.wal, jti: payload.jti }
}

export const consumeLoginChallenge = (c: LoginChallenge): void => {
  const now = Date.now()
  sweep(now)
  consumed.set(c.jti, now + LOGIN_CHALLENGE_TTL_MS)
}

// 본문이 1단계와 다른 계정·지갑을 지정했는가. 값이 없으면 비교하지 않는다(구버전 클라이언트 호환).
export const describeBodyMismatch = (
  c: LoginChallenge,
  body: { userId?: unknown; walletAddress?: unknown },
): string | null => {
  const parts: string[] = []
  if (body.userId !== undefined && body.userId !== null && Number(body.userId) !== c.userId) {
    parts.push(`userId ${String(body.userId)} ≠ 1단계 ${c.userId}`)
  }
  if (
    typeof body.walletAddress === 'string' && body.walletAddress.length > 0 &&
    body.walletAddress.toLowerCase() !== c.walletAddress
  ) {
    parts.push(`walletAddress ${body.walletAddress} ≠ 1단계 ${c.walletAddress}`)
  }
  return parts.length > 0 ? parts.join(', ') : null
}
