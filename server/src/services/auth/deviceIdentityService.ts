import crypto from 'crypto'

// ─────────────────────────────────────────────────────────────
// 단말 식별자 (1인 1계정 감시용)
//
// 신뢰 기기 쿠키는 "이 기기 기억하기"를 고른 계정에만, 그 계정 단위로 발급되므로
// 한 단말에서 여러 계정이 쓰이는지를 셀 수 없다. 계정과 무관하게 브라우저마다 하나씩
// 발급되는 식별 쿠키를 따로 둔다.
//
// - 원문은 브라우저 쿠키에만 있고, 서버 DB 에는 서버 비밀키로 계산한 HMAC 만 저장한다.
//   DB 가 유출되어도 쿠키를 복원해 다른 단말을 사칭할 수 없다.
// - 인증 수단이 아니다. 지우면 새 단말로 보일 뿐이고, 그 회피 가능성은 한계로 명시한다.
// ─────────────────────────────────────────────────────────────

export const DEVICE_ID_COOKIE = 'uptick_did'
export const DEVICE_ID_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000
// 32바이트 base64url (패딩 없음) = 43자
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/

const deviceKey = (): Buffer => {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error('JWT_SECRET 이 설정되지 않았습니다')
  return crypto.createHmac('sha256', secret).update('uptick/device-id/v1').digest()
}

export const newDeviceId = (): string => crypto.randomBytes(32).toString('base64url')

export const isValidDeviceId = (v: unknown): v is string =>
  typeof v === 'string' && DEVICE_ID_PATTERN.test(v)

export const hashDeviceId = (raw: string): string =>
  crypto.createHmac('sha256', deviceKey()).update(raw).digest('hex')
