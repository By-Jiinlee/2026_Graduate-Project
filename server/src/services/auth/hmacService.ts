import crypto from 'crypto'

// ─────────────────────────────────────────────────────────────
// HMAC 기반 API 요청 서명 (무결성 + 재전송 방어)
//
// 클라이언트는 요청마다 `${timestamp}.${nonce}.${rawBody}` 를 세션 서명키로
// HMAC-SHA256 서명해 X-Signature / X-Timestamp / X-Nonce 헤더에 첨부한다.
// 서버는 (1) timestamp ±30초 검증 → (2) 서명 재계산·상수시간 비교 → (3) nonce
// 재사용 검사 순으로 검증하여 본문 변조·재전송(Replay)을 차단한다.
// ─────────────────────────────────────────────────────────────

const TIMESTAMP_WINDOW_MS = 30_000
const NONCE_TTL_MS = 60_000 // 시각 윈도우보다 넉넉히 — 만료 전 재사용을 모두 포착

// 세션별 서명 비밀키 저장소 (인메모리 — 서버 재시작 시 초기화, 재로그인으로 재발급)
const sessionSecrets = new Map<number, string>()

export function issueSessionSecret(userId: number): string {
  const secret = crypto.randomBytes(32).toString('hex')
  sessionSecrets.set(userId, secret)
  return secret
}

export function getSessionSecret(userId: number): string | undefined {
  return sessionSecrets.get(userId)
}

export function revokeSessionSecret(userId: number): void {
  sessionSecrets.delete(userId)
}

// nonce 재사용 방지 저장소: nonce → 만료 시각(ms)
const seenNonces = new Map<string, number>()

function cleanupNonces(now: number): void {
  if (seenNonces.size < 1000) return
  for (const [n, exp] of seenNonces) {
    if (exp <= now) seenNonces.delete(n)
  }
}

// nonce 소비: 처음 보는 nonce면 true, 아직 유효한 nonce의 재사용이면 false
export function consumeNonce(nonce: string, now: number = Date.now()): boolean {
  cleanupNonces(now)
  const exp = seenNonces.get(nonce)
  if (exp !== undefined && exp > now) return false
  seenNonces.set(nonce, now + NONCE_TTL_MS)
  return true
}

export function computeSignature(
  secret: string,
  timestamp: string,
  nonce: string,
  rawBody: string,
): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${nonce}.${rawBody}`)
    .digest('hex')
}

export interface VerifyInput {
  secret: string
  signature: string
  timestamp: string
  nonce: string
  rawBody: string
  now?: number
}

export type VerifyReason = 'MISSING_HEADERS' | 'BAD_TIMESTAMP' | 'EXPIRED' | 'BAD_SIGNATURE' | 'REPLAY'
export interface VerifyResult {
  valid: boolean
  reason?: VerifyReason
}

export function verifyRequestSignature(input: VerifyInput): VerifyResult {
  const { secret, signature, timestamp, nonce, rawBody } = input
  const now = input.now ?? Date.now()

  if (!signature || !timestamp || !nonce) return { valid: false, reason: 'MISSING_HEADERS' }

  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return { valid: false, reason: 'BAD_TIMESTAMP' }
  if (Math.abs(now - ts) > TIMESTAMP_WINDOW_MS) return { valid: false, reason: 'EXPIRED' }

  // 상수 시간 비교 — 타이밍 공격 방지
  const expected = computeSignature(secret, timestamp, nonce, rawBody)
  let sigBuf: Buffer
  const expBuf = Buffer.from(expected, 'hex')
  try {
    sigBuf = Buffer.from(signature, 'hex')
  } catch {
    return { valid: false, reason: 'BAD_SIGNATURE' }
  }
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { valid: false, reason: 'BAD_SIGNATURE' }
  }

  // 서명·시각이 유효할 때만 nonce 소비 → 실패 요청이 정상 nonce를 소모하지 못하게 함
  if (!consumeNonce(nonce, now)) return { valid: false, reason: 'REPLAY' }

  return { valid: true }
}
