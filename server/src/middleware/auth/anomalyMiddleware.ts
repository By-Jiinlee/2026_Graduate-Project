import { Request, Response, NextFunction } from 'express'
import { analyzeLoginAttempt, isAccountLocked } from '../../services/auth/anomalyService'
import { checkIPAbuse } from '../../services/auth/abuseIPDBService'
import { blockIP } from '../security/ipBlockMiddleware'
import AnomalyLog from '../../models/auth/AnomalyLog'
import { getClientIp } from '../../utils/getClientIp'

// ─────────────────────────────────────────────
// 0. AbuseIPDB — 알려진 악성 IP 차단
// login/step1 및 register 앞에 배치
// ─────────────────────────────────────────────
export async function checkAbuseIP(req: Request, res: Response, next: NextFunction): Promise<void> {
  const ip = getClientIp(req)

  try {
    const { isAbusive, score } = await checkIPAbuse(ip)
    if (!isAbusive) {
      next()
      return
    }

    blockIP(ip)

    await AnomalyLog.create({
      user_id: null,
      email: req.body.email ?? null,
      ip,
      user_agent: req.headers['user-agent'] ?? null,
      anomaly_type: 'ABUSE_IP',
      action: 'BLOCK',
      detail: `AbuseIPDB 악성 IP 탐지: 점수 ${score}/100`,
      country: null,
    })

    res.status(403).json({
      message: '비정상적인 접근으로 차단되었습니다.',
      code: 'IP_BLOCKED',
    })
  } catch {
    next() // fail-open: AbuseIPDB 장애 시 정상 처리
  }
}

// ─────────────────────────────────────────────
// 1. 로그인 전 — 계정 잠금 확인
// authRouter의 /login/step1 앞에 배치
//
// 잠금 여부를 여기서 응답으로 알려주면, 비밀번호를 모르는 공격자도 문구만 보고
// 그 이메일의 가입 여부를 알 수 있다(계정 열거). 그래서 이 미들웨어는 잠금 상태를
// res.locals 에 실어 넘기기만 하고 차단하지 않는다. 실제 거부는 비밀번호 검증을
// 통과한 뒤 authService.loginStep1 이 수행한다.
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
    res.locals.accountLocked = locked
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
      isStep2: res.locals.isStep2 ?? false,
    })

    // 임계 초과 차단 — 계정 잠금과 IP 차단을 같은 응답으로 돌려준다.
    //
    // 이전에는 잠금이면 423/ACCOUNT_LOCKED, 그 외 차단이면 403/IP_BLOCKED 로 갈렸다.
    // 그런데 잠금은 "그 이메일이 실제로 존재할 때만" 발생하므로, 공격자는 임의 이메일에
    // 실패를 5회 쌓아 보고 응답이 423 인지 403 인지만 보면 가입 여부를 알 수 있었다
    // (비용이 조금 더 드는 계정 열거). 응답을 통일해 이 채널을 없앤다.
    // 잠금 사실과 대응 방법은 소유자에게 이메일로 안내되며, 상세 사유는 anomaly_logs 에 남는다.
    if (anomalyResult.locked || anomalyResult.blocked) {
      res.status(403).json({
        message: '반복된 인증 실패가 감지되어 접근이 차단되었습니다. 잠시 후 다시 시도해주세요.',
        code: 'AUTH_THROTTLED',
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