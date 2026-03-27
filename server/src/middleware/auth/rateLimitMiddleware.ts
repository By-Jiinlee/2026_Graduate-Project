import { Request, Response, NextFunction } from 'express'

interface RateLimitEntry {
  count: number
  firstAttempt: number
  blockedUntil?: number
}

// IP 기반 인메모리 저장소
const loginStore = new Map<string, RateLimitEntry>()
const emailStore = new Map<string, RateLimitEntry>()
const smsStore = new Map<string, RateLimitEntry>()

const getIp = (req: Request): string =>
  (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() ||
  req.socket.remoteAddress ||
  'unknown'

const createLimiter = (
  store: Map<string, RateLimitEntry>,
  options: {
    maxAttempts: number
    windowMs: number
    blockMs: number
    message: string
  },
) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = getIp(req)
    const now = Date.now()
    const entry = store.get(ip)

    // 차단 상태 확인
    if (entry?.blockedUntil && now < entry.blockedUntil) {
      const remaining = Math.ceil((entry.blockedUntil - now) / 1000 / 60)
      return res.status(429).json({
        message: `${options.message} (${remaining}분 후 재시도 가능)`,
      })
    }

    // 윈도우 초과 시 초기화
    if (!entry || now - entry.firstAttempt > options.windowMs) {
      store.set(ip, { count: 1, firstAttempt: now })
      return next()
    }

    // 시도 횟수 초과 시 차단
    if (entry.count >= options.maxAttempts) {
      store.set(ip, {
        ...entry,
        blockedUntil: now + options.blockMs,
      })
      return res.status(429).json({ message: options.message })
    }

    entry.count++
    store.set(ip, entry)
    next()
  }
}

// 로그인 Rate Limiter: 5회 실패 시 15분 차단
export const loginRateLimiter = createLimiter(loginStore, {
  maxAttempts: 5,
  windowMs: 15 * 60 * 1000,
  blockMs: 15 * 60 * 1000,
  message: '로그인 시도 횟수를 초과했습니다. 15분 후 다시 시도해주세요',
})

// 이메일 인증 Rate Limiter: 분당 3회 제한
export const emailCodeRateLimiter = createLimiter(emailStore, {
  maxAttempts: 3,
  windowMs: 60 * 1000,
  blockMs: 60 * 1000,
  message: '이메일 인증 요청이 너무 많습니다. 잠시 후 다시 시도해주세요',
})

// SMS 인증 Rate Limiter: 분당 3회 제한
export const smsCodeRateLimiter = createLimiter(smsStore, {
  maxAttempts: 3,
  windowMs: 60 * 1000,
  blockMs: 60 * 1000,
  message: 'SMS 인증 요청이 너무 많습니다. 잠시 후 다시 시도해주세요',
})