import { Request, Response } from 'express'
import { Op, fn, col, literal } from 'sequelize'
import AnomalyLog from '../../models/auth/AnomalyLog'
import User from '../../models/user/User'
import { blockedIPs } from '../../middleware/security/ipBlockMiddleware'

// 대시보드 요약 통계
export async function getStats(req: Request, res: Response): Promise<void> {
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)

  const [total, today, locked, honeypotHits] = await Promise.all([
    AnomalyLog.count(),
    AnomalyLog.count({ where: { created_at: { [Op.gte]: todayStart } } }),
    User.count({ where: { is_locked: true } }),
    AnomalyLog.count({ where: { anomaly_type: 'HONEYPOT' } }).catch(() => 0),
  ])

  res.json({ total, today, locked, blockedIPs: blockedIPs.size, honeypotHits })
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

  // 해당 유저의 미해결 anomaly_logs resolved 처리
  await AnomalyLog.update(
    { resolved: true },
    { where: { user_id: userId, resolved: false } },
  )

  res.json({ message: `${user.email} 계정 잠금 해제 완료` })
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
  console.log(`[Admin] IP 차단 해제: ${ip}`)
  res.json({ message: `${ip} 차단 해제 완료` })
}
