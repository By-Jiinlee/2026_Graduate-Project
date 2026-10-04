import crypto from 'crypto'

// ─────────────────────────────────────────────────────────────
// 로그인 아이디 — 이메일 또는 휴대폰 번호
//
// 휴대폰 인증만으로 가입한 계정은 이메일이 없으므로 휴대폰 번호로 로그인한다. 이메일·휴대폰을 둘 다 가진
// 계정은 어느 쪽으로든 로그인할 수 있다.
//
// 무차별 대입 집계 키(loginKey)는 "입력값"이 아니라 "계정"을 기준으로 한다. 입력값 기준이면 같은 계정을
// 이메일로 5회, 휴대폰으로 5회 시도해 잠금 임계를 두 배로 늘릴 수 있다. 계정이 없을 때만 입력값으로 집계한다.
//
// 휴대폰 번호는 로그인 시도 기록·이상 로그에 평문으로 남기지 않는다. 집계 키는 해시, 표시용은 가운데를 가린다.
// ─────────────────────────────────────────────────────────────

export type LoginIdentifier = { kind: 'email'; value: string } | { kind: 'phone'; value: string }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_RE = /^01[016789][0-9]{7,8}$/

export const normalizePhone = (raw: string): string => raw.replace(/[\s-]/g, '')

export const isValidPhone = (phone: string): boolean => PHONE_RE.test(phone)

export const parseLoginIdentifier = (raw: unknown): LoginIdentifier | null => {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (s.length === 0 || s.length > 100) return null
  if (s.includes('@')) return EMAIL_RE.test(s) ? { kind: 'email', value: s } : null
  const phone = normalizePhone(s)
  return PHONE_RE.test(phone) ? { kind: 'phone', value: phone } : null
}

export const maskPhone = (phone: string): string =>
  phone.length >= 10 ? `${phone.slice(0, 3)}-****-${phone.slice(-4)}` : '***'

const phoneKey = (phone: string): string =>
  `phone:${crypto.createHash('sha256').update(phone).digest('hex').slice(0, 32)}`

// 계정이 있으면 계정 기준 — 이메일이 있으면 이메일(기존 기록과 호환), 없으면 휴대폰 해시
export const accountLoginKey = (user: { email?: string | null; phone?: string | null; id: number }): string =>
  user.email ? user.email : user.phone ? phoneKey(user.phone) : `user:${user.id}`

// 계정이 없을 때 — 입력값 기준
export const identifierLoginKey = (id: LoginIdentifier): string =>
  id.kind === 'email' ? id.value : phoneKey(id.value)

// 이상 로그·관리자 화면에 남길 표시값
export const accountDisplay = (user: { email?: string | null; phone?: string | null }): string =>
  user.email ? user.email : user.phone ? maskPhone(user.phone) : ''

export const identifierDisplay = (id: LoginIdentifier): string =>
  id.kind === 'email' ? id.value : maskPhone(id.value)
