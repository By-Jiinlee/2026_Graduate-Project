console.log('[anomalyMiddleware] 로드됨')
import { Request, Response, NextFunction } from 'express'
import { analyzeLoginAttempt, isAccountLocked } from '../../services/auth/anomalyService'

// ─────────────────────────────────────────────
// 1. 로그인 전 — 계정 잠금 확인
// authRouter의 /login/step1 앞에 배치
// ─────────────────────────────────────────────
export async function checkAccountLock(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const { email } = req.body

  if (!email) {
    next()
    return
  }

  try {
    const { locked } = await isAccountLocked(email)

    if (locked) {
      res.status(423).json({
        message: '계정이 잠겼습니다. 관리자에게 문의하세요',
        code: 'ACCOUNT_LOCKED',
      })
      return
    }

    next()
  } catch (err) {
    console.error('[anomalyMiddleware] checkAccountLock error:', err)
    next()
  }
}

// ─────────────────────────────────────────────
// 2. 로그인 후 — 이상탐지 분석
// authRouter의 /login/step1,2 핸들러 뒤에 배치
// authController에서 res.locals 설정 필요:
//   res.locals.loginSuccess   = true/false
//   res.locals.loginEmail     = email
//   res.locals.loginUserId    = userId (성공 시)
//   res.locals.responseData   = 응답 JSON 객체
//   res.locals.responseStatus = HTTP 상태코드
// ─────────────────────────────────────────────
export async function analyzeAfterLogin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const { loginSuccess, loginEmail, loginUserId, responseData, responseStatus } = res.locals

  console.log('[anomaly] analyzeAfterLogin 실행됨')
  console.log('[anomaly] locals:', { loginSuccess, loginEmail, loginUserId })

  // loginEmail 없으면 이상탐지 대상 아님 — 그대로 응답
  if (!loginEmail) {
    res.status(responseStatus ?? 400).json(responseData)
    return
  }

  const ip =
    (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'unknown'

  try {
    const anomalyResult = await analyzeLoginAttempt({
      userId: loginUserId,
      email: loginEmail,
      ip,
      userAgent: req.headers['user-agent'],
      success: loginSuccess ?? false,
    })

    console.log('[anomaly] 분석 결과:', anomalyResult)

    // 계정 잠금
    if (anomalyResult.locked) {
      res.status(423).json({
        message: '비정상 로그인 시도가 감지되어 계정이 잠겼습니다. 이메일을 확인해주세요.',
        code: 'ACCOUNT_LOCKED',
        anomalies: anomalyResult.anomalies,
      })
      return
    }

    // IP 차단
    if (anomalyResult.blocked) {
      res.status(403).json({
        message: '비정상적인 접근으로 차단되었습니다.',
        code: 'IP_BLOCKED',
        anomalies: anomalyResult.anomalies,
      })
      return
    }

    // 이상 감지됐지만 차단 수준 아님 → 경고 헤더 추가
    if (anomalyResult.anomalies.length > 0) {
      res.setHeader('X-Security-Warning', anomalyResult.anomalies.join(','))
    }

    // 정상 응답
    res.status(responseStatus ?? 200).json(responseData)

  } catch (err) {
    console.error('[anomalyMiddleware] analyzeAfterLogin error:', err)
    // fail-open — 이상탐지 실패해도 원래 응답은 정상 전송
    res.status(responseStatus ?? 200).json(responseData)
  }
}