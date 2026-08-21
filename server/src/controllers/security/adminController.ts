import { Request, Response } from 'express'
import { Op, fn, col, literal } from 'sequelize'
import AnomalyLog from '../../models/auth/AnomalyLog'
import LoginAttempt from '../../models/auth/LoginAttempt'
import InferenceLog from '../../models/ai/InferenceLog'
import User from '../../models/user/User'
import { blockedIPs } from '../../middleware/security/ipBlockMiddleware'

// 대시보드 요약 통계
export async function getStats(req: Request, res: Response): Promise<void> {
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)

  const [total, today, locked, honeypotHits, integrityViolations, tradeAnomalies, tradeBlocked] =
    await Promise.all([
      AnomalyLog.count(),
      AnomalyLog.count({ where: { created_at: { [Op.gte]: todayStart } } }),
      User.count({ where: { is_locked: true } }),
      AnomalyLog.count({ where: { anomaly_type: 'HONEYPOT' } }).catch(() => 0),
      // HMAC 서명 검증 실패 — 요청 위·변조 + 재전송
      AnomalyLog.count({
        where: { anomaly_type: { [Op.in]: ['REQUEST_TAMPERING', 'REPLAY_ATTACK'] } },
      }).catch(() => 0),
      // M-1 거래 이상탐지 — 주문 무결성 위반 + 베이스라인 이탈
      AnomalyLog.count({ where: { anomaly_type: 'ABNORMAL_TRADE_AMOUNT' } }).catch(() => 0),
      AnomalyLog.count({
        where: { anomaly_type: 'ABNORMAL_TRADE_AMOUNT', action: 'BLOCK' },
      }).catch(() => 0),
    ])

  res.json({
    total, today, locked, blockedIPs: blockedIPs.size,
    honeypotHits, integrityViolations, tradeAnomalies, tradeBlocked,
  })
}

// 유형별 탐지 건수 (BarChart용)
export async function getChartByType(req: Request, res: Response): Promise<void> {
  const rows = await AnomalyLog.findAll({
    attributes: [
      'anomaly_type',
      [fn('COUNT', col('id')), 'count'],
    ],
    group: ['anomaly_type'],
    order: [[fn('COUNT', col('id')), 'DESC']],
    raw: true,
  })
  res.json(rows)
}

// 7일간 일별 탐지 추이 (LineChart용)
export async function getChartByDay(req: Request, res: Response): Promise<void> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

  const rows = await AnomalyLog.findAll({
    attributes: [
      [fn('DATE', col('created_at')), 'date'],
      [fn('COUNT', col('id')), 'count'],
    ],
    where: { created_at: { [Op.gte]: sevenDaysAgo } },
    group: [fn('DATE', col('created_at'))],
    order: [[literal('date'), 'ASC']],
    raw: true,
  })
  res.json(rows)
}

// 적응형 인증(H) 판정 집계
//
// 등급·점수는 detail 문자열에 담겨 있다(anomaly_logs 에 전용 컬럼이 없어서다).
// 우리가 만든 고정 포맷이라 파싱이 안전하지만, 포맷을 바꿀 때는
// anomalyService.recordAdaptiveDecision 과 이 정규식을 함께 고쳐야 한다.
const ADAPTIVE_PATTERN = /요구=(\w+) 점수=(\d+) 모드=(관측|강제)/

export async function getAdaptiveAuthStats(req: Request, res: Response): Promise<void> {
  const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 90)
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const rows = (await AnomalyLog.findAll({
    where: { anomaly_type: 'ADAPTIVE_STEPUP', created_at: { [Op.gte]: since } },
    attributes: ['id', 'email', 'ip', 'detail', 'action', 'created_at'],
    order: [['created_at', 'DESC']],
    limit: 500,
    raw: true,
  })) as unknown as Array<{
    id: number; email: string | null; ip: string
    detail: string; action: string; created_at: Date
  }>

  const byRequirement: Record<string, number> = { PIN: 0, EMAIL_OTP: 0, WALLET: 0 }
  const byMode = { 관측: 0, 강제: 0 }
  let scoreSum = 0
  let scoreCount = 0

  const recent = rows.map((r) => {
    const m = ADAPTIVE_PATTERN.exec(r.detail ?? '')
    const requirement = m?.[1] ?? 'UNKNOWN'
    const score = m ? Number(m[2]) : null
    const mode = (m?.[3] ?? '관측') as '관측' | '강제'

    if (requirement in byRequirement) byRequirement[requirement]++
    byMode[mode]++
    if (score != null) { scoreSum += score; scoreCount++ }

    return {
      id: r.id,
      email: r.email,
      ip: r.ip,
      requirement,
      score,
      mode,
      // 근거(어떤 신호가 몇 점 올렸는지)는 detail 뒤쪽에 그대로 있다
      reason: (r.detail ?? '').split('—').slice(1).join('—').trim(),
      createdAt: r.created_at,
    }
  })

  res.json({
    windowDays: days,
    total: rows.length,
    // 통과(NONE)는 애초에 기록하지 않으므로 여기 집계에 없다 — 프론트에 명시한다.
    note: '통과(NONE) 판정은 기록 대상이 아니라 집계에 포함되지 않습니다',
    byRequirement,
    byMode,
    averageScore: scoreCount > 0 ? Math.round((scoreSum / scoreCount) * 10) / 10 : null,
    recent: recent.slice(0, 100),
  })
}

// 최근 허니팟 히트
export async function getHoneypotHits(req: Request, res: Response): Promise<void> {
  const rows = await AnomalyLog.findAll({
    where: { anomaly_type: 'HONEYPOT' },
    order: [['created_at', 'DESC']],
    limit: 20,
  }).catch(() => [])
  res.json(rows)
}

// 이상탐지 로그 목록 (최신순, 페이지네이션)
export async function getAnomalyLogs(req: Request, res: Response): Promise<void> {
  const page = Math.max(1, Number(req.query.page) || 1)
  const limit = Math.min(100, Number(req.query.limit) || 30)
  const offset = (page - 1) * limit

  const where: Record<string, unknown> = {}
  if (req.query.type) where.anomaly_type = req.query.type
  if (req.query.resolved !== undefined) where.resolved = req.query.resolved === 'true'

  const { count, rows } = await AnomalyLog.findAndCountAll({
    where,
    order: [['created_at', 'DESC']],
    limit,
    offset,
  })

  res.json({ total: count, page, limit, logs: rows })
}

// AI 추론 요청 감사 로그 (최신순) + 허용·차단 요약
export async function getInferenceLogs(req: Request, res: Response): Promise<void> {
  const limit = Math.min(100, Number(req.query.limit) || 20)
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)

  const [rows, allowed, denied, denyByReason] = await Promise.all([
    InferenceLog.findAll({ order: [['created_at', 'DESC']], limit }).catch(() => []),
    InferenceLog.count({ where: { decision: 'ALLOW', created_at: { [Op.gte]: dayAgo } } }).catch(() => 0),
    InferenceLog.count({ where: { decision: 'DENY', created_at: { [Op.gte]: dayAgo } } }).catch(() => 0),
    InferenceLog.findAll({
      attributes: ['deny_reason', [fn('COUNT', col('id')), 'count']],
      where: { decision: 'DENY', created_at: { [Op.gte]: dayAgo } },
      group: ['deny_reason'],
      order: [[fn('COUNT', col('id')), 'DESC']],
      raw: true,
    }).catch(() => []),
  ])

  res.json({ logs: rows, summary: { allowed24h: allowed, denied24h: denied, denyByReason } })
}

// 잠긴 계정 목록
export async function getLockedAccounts(req: Request, res: Response): Promise<void> {
  const users = await User.findAll({
    where: { is_locked: true },
    attributes: ['id', 'email', 'name', 'created_at'],
    order: [['id', 'DESC']],
  })
  res.json({ users })
}

// 계정 잠금 해제
export async function unlockAccount(req: Request, res: Response): Promise<void> {
  const userId = Number(req.params.userId)

  const user = await User.findByPk(userId)
  if (!user) {
    res.status(404).json({ message: '유저를 찾을 수 없습니다' })
    return
  }

  await user.update({ is_locked: false })

  // 무차별 대입 판정은 최근 15분의 실패 기록을 세어 이뤄진다. 잠금 플래그만 내리면
  // 다음 로그인 시도에서 같은 기록이 다시 임계를 넘겨 즉시 재잠금된다(해제가 무효).
  // 따라서 해제 시점에 해당 계정의 미처리 실패 기록을 함께 정리한다.
  const clearedAttempts = await LoginAttempt.destroy({
    where: { identifier: user.email, identifier_type: 'EMAIL', success: false },
  })

  // 해당 유저의 미해결 anomaly_logs resolved 처리
  await AnomalyLog.update(
    { resolved: true },
    { where: { user_id: userId, resolved: false } },
  )

  res.json({
    message: `${user.email} 계정 잠금 해제 완료`,
    clearedAttempts,
  })
}

// 차단된 IP 목록 (인메모리)
export async function getBlockedIPs(req: Request, res: Response): Promise<void> {
  res.json({ ips: Array.from(blockedIPs) })
}

// IP 차단 해제
export async function unblockIP(req: Request, res: Response): Promise<void> {
  const ip = decodeURIComponent(String(req.params.ip))

  if (!blockedIPs.has(ip)) {
    res.status(404).json({ message: '차단 목록에 없는 IP입니다' })
    return
  }

  blockedIPs.delete(ip)

  // 계정 잠금 해제와 같은 이유로, 최근 15분의 실패 기록을 함께 정리한다.
  // 목록에서만 빼면 그 IP 의 다음 요청이 같은 기록으로 다시 임계를 넘겨 즉시 재차단된다.
  const clearedAttempts = await LoginAttempt.destroy({
    where: { ip, identifier_type: 'IP', success: false },
  })

  console.log(`[Admin] IP 차단 해제: ${ip} (실패 기록 ${clearedAttempts}건 정리)`)
  res.json({ message: `${ip} 차단 해제 완료`, clearedAttempts })
}
