import { Request, Response, NextFunction } from 'express'

// ─────────────────────────────────────────────────────────────
// 본인 인증 등급별 이용 범위
//
//   모의투자(가상 자금) : 이메일 또는 휴대폰 중 하나 인증 — 가입 시 둘 중 하나를 인증하므로 가입 사용자 전원
//   실거래(실제 자산)   : 이메일·휴대폰 둘 다 인증
//
// 실거래는 실제 계좌로 주문이 나가므로 연락·복구 수단이 둘 다 확인된 사용자만 쓴다. 이메일은 보안 경보
// (신규 기기·이상 탐지)를 받는 채널이고 휴대폰은 본인 확인 수단이라, 한쪽만 있으면 탈취 시 알림이나
// 본인 확인 중 하나가 비어 있게 된다.
//
// 판정은 isAuthenticated 가 DB 에서 다시 읽은 사용자 행으로 한다(토큰·클라이언트 값을 쓰지 않는다).
// 반드시 isAuthenticated 다음에 둔다.
// ─────────────────────────────────────────────────────────────

const verificationOf = (req: Request) => {
  const user = (req as any).user
  return {
    email: Boolean(user?.is_email_verified),
    phone: Boolean(user?.is_phone_verified),
  }
}

export const requireAnyVerified = (req: Request, res: Response, next: NextFunction) => {
  const v = verificationOf(req)
  if (v.email || v.phone) return next()
  return res.status(403).json({
    message: '모의투자를 이용하려면 이메일 또는 휴대폰 인증이 필요합니다',
    code: 'VERIFICATION_REQUIRED',
    missing: ['email_or_phone'],
  })
}

export const requireFullyVerified = (req: Request, res: Response, next: NextFunction) => {
  const v = verificationOf(req)
  if (v.email && v.phone) return next()
  const missing = [!v.email ? 'email' : null, !v.phone ? 'phone' : null].filter(Boolean)
  const label = missing.map((m) => (m === 'email' ? '이메일' : '휴대폰')).join('·')
  return res.status(403).json({
    message: `실거래를 이용하려면 이메일과 휴대폰 인증이 모두 필요합니다 (미완료: ${label})`,
    code: 'FULL_VERIFICATION_REQUIRED',
    missing,
  })
}
