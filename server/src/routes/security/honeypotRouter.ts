import { Router, Request, Response } from 'express'
import AnomalyLog from '../../models/auth/AnomalyLog'
import { blockIP } from '../../middleware/security/ipBlockMiddleware'
import { sendAnomalyAlertEmail } from '../../services/auth/emailService'
import User from '../../models/user/User'
import { getClientIp } from '../../utils/getClientIp'
import { getLocationFromIp } from '../../utils/getLocationFromIp'

const router = Router()

// 공격자/스캐너가 탐색하는 경로 목록 — 정상 사용자는 절대 접근하지 않음
const HONEYPOT_PATHS = [
  '/api/admin/users',
  '/api/admin/config',
  '/api/admin/logs',
  '/api/internal/accounts',
  '/api/internal/config',
  '/api/v1/admin',
  '/api/debug/env',
  '/api/debug/config',
  '/.env',
  '/admin',
  '/wp-admin',
  '/phpmyadmin',
  '/wp-login.php',
]

async function handleHoneypot(req: Request, res: Response): Promise<void> {
  const ip = getClientIp(req)
  const path = req.path
  const method = req.method
  const userAgent = req.headers['user-agent'] ?? null

  console.warn(`[Honeypot] 히트! IP: ${ip} | ${method} ${path} | UA: ${userAgent}`)

  blockIP(ip)

  const geo = await getLocationFromIp(ip).catch(() => ({ city: undefined, region: undefined, country: undefined }))
  const location = [geo.city, geo.region, geo.country].filter(Boolean).join(', ') || '알 수 없음'

  await Promise.allSettled([
    AnomalyLog.create({
      user_id: null,
      email: null,
      ip,
      user_agent: userAgent,
      anomaly_type: 'HONEYPOT',
      action: 'BLOCK',
      detail: `허니팟 접근 탐지: ${method} ${path}`,
      country: geo.country ?? null,
    }),
    User.findOne({ where: { role: 'admin' } }).then((admin) => {
      if (admin) {
        return sendAnomalyAlertEmail(admin.email, {
          reasons: [`숨겨진 경로(${path})에 대한 접근이 탐지되어 해당 IP를 차단했습니다.`],
          ip,
          location,
          userAgent: userAgent ?? '알 수 없음',
        })
      }
    }),
  ])

  // 404 응답으로 허니팟임을 숨김
  res.status(404).json({ message: 'Not Found' })
}

for (const path of HONEYPOT_PATHS) {
  router.all(path, handleHoneypot)
}

export default router
