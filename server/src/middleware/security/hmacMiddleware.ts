import { Request, Response, NextFunction } from 'express'
import { verifyRequestSignature, getSessionSecret } from '../../services/auth/hmacService'
import { recordSignatureFailure } from '../../services/auth/anomalyService'
import { getClientIp } from '../../utils/getClientIp'

// 거래 등 상태 변경 요청에 HMAC 서명 검증을 강제한다.
// 반드시 isAuthenticated(JWT) 미들웨어 "다음"에 배치 — req.user.id 로 세션 서명키를 조회한다.
export function hmacMiddleware(req: Request, res: Response, next: NextFunction): void {
  // 안전한 메서드(GET/HEAD)는 본문이 없어 서명 대상이 아님
  if (req.method === 'GET' || req.method === 'HEAD') return next()

  const userId = (req as any).user?.id
  if (!userId) {
    res.status(401).json({ message: '로그인이 필요합니다' })
    return
  }

  const secret = getSessionSecret(userId)
  if (!secret) {
    res.status(401).json({ message: '서명 세션이 만료되었습니다. 다시 로그인해주세요.' })
    return
  }

  const signature = req.header('X-Signature') ?? ''
  const timestamp = req.header('X-Timestamp') ?? ''
  const nonce = req.header('X-Nonce') ?? ''
  const rawBody = (req as any).rawBody ?? ''

  const result = verifyRequestSignature({ secret, signature, timestamp, nonce, rawBody })
  if (!result.valid) {
    console.warn(`[HMAC] 서명 검증 실패: userId=${userId} reason=${result.reason} ${req.method} ${req.path}`)

    // 탐지 기록·경보는 응답을 지연시키지 않도록 비동기로 처리 (내부에서 오류를 흡수함)
    void recordSignatureFailure({
      userId,
      email: (req as any).user?.email,
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'],
      method: req.method,
      path: req.path,
      reason: result.reason!,
    })

    res.status(403).json({ message: '요청 서명 검증에 실패했습니다', reason: result.reason })
    return
  }

  next()
}
