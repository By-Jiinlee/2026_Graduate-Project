import { Op } from 'sequelize'
import AnomalyLog from '../../models/auth/AnomalyLog'
import User from '../../models/user/User'
import { blockIP } from '../../middleware/security/ipBlockMiddleware'
import { sendAnomalyAlertEmail } from '../auth/emailService'
import { getLocationFromIp } from '../../utils/getLocationFromIp'

/**
 * 카나리(미끼) 계좌 — 기만 기술.
 *
 * ID 를 고정 상수로 박아두는 것은 의도된 설계다. 미끼의 정체가 런타임 설정으로
 * 바뀔 수 있으면 그건 더 이상 카나리가 아니다. 다만 "33 = 미끼"라는 사실이
 * 코드에만 존재하므로, DB 를 재구축해 실제 사용자가 이 ID 를 물면 정상 사용자의
 * 거래가 전부 차단된다. 계정을 다시 심을 때는 이 상수와 실제 행을 함께 맞춰야 한다.
 */
export const CANARY_USER_IDS: readonly number[] = [33]

export function isCanaryUser(userId: number): boolean {
  return CANARY_USER_IDS.includes(userId)
}

/** 카나리 접근 이력이 있는 IP 인지 — 위험 점수 산정(riskEngine)에서 재사용한다. */
export const CANARY_ANOMALY_TYPES = ['HONEYPOT', 'CANARY_ACCESS'] as const

// 관리자 메일 폭주 방지 — 로그는 매 히트마다 남기되(탐지 건수 집계용),
// 메일은 IP 당 쿨다운을 둔다. 자동화 도구가 6개 진입점을 훑으면 한 번의 정찰로도
// 수십 통이 나가기 때문이다.
const EMAIL_COOLDOWN_MS = 10 * 60 * 1000
const lastAlertAt = new Map<string, number>()

function shouldSendEmail(ip: string): boolean {
  const now = Date.now()
  const prev = lastAlertAt.get(ip) ?? 0
  if (now - prev < EMAIL_COOLDOWN_MS) return false
  lastAlertAt.set(ip, now)
  return true
}

interface CanaryContext {
  userId: number
  /** 진입점 식별자 (CN-01 …) — 어느 경로로 미끼를 건드렸는지 로그에 남긴다. */
  code: string
  /** 사람이 읽을 진입점 이름 — detail 문구에 쓰인다. */
  action: string
  ip?: string
  userAgent?: string
}

/**
 * 카나리 계좌 접근이면 탐지 기록을 남기고 요청을 중단시킨다.
 * 정상 사용자에 대해서는 아무 일도 하지 않으므로 모든 진입점 최상단에서 호출해도 안전하다.
 *
 * 기록(AnomalyLog)·IP 차단·관리자 메일은 허니팟(honeypotRouter)과 동일한 구조를 따른다.
 * 알림 경로가 실패하더라도 차단은 반드시 수행되어야 하므로 allSettled 후 무조건 throw 한다.
 */
export async function assertNotCanary(ctx: CanaryContext): Promise<void> {
  if (!isCanaryUser(ctx.userId)) return

  const ip = ctx.ip ?? 'unknown'
  const userAgent = ctx.userAgent ?? null

  console.warn(`[SECURITY] 카나리 계좌(ID: ${ctx.userId}) ${ctx.action} 감지 - IP: ${ip} (${ctx.code})`)

  if (ip !== 'unknown') blockIP(ip)

  const geo =
    ip === 'unknown'
      ? { city: undefined, region: undefined, country: undefined }
      : await getLocationFromIp(ip).catch(() => ({ city: undefined, region: undefined, country: undefined }))
  const location = [geo.city, geo.region, geo.country].filter(Boolean).join(', ') || '알 수 없음'

  await Promise.allSettled([
    AnomalyLog.create({
      user_id: ctx.userId,
      email: null,
      ip,
      user_agent: userAgent,
      anomaly_type: 'CANARY_ACCESS',
      action: 'BLOCK',
      detail: `카나리 계좌 접근 탐지: ${ctx.action} (${ctx.code})`,
      country: geo.country ?? null,
    }),
    (async () => {
      if (!shouldSendEmail(ip)) return
      const admin = await User.findOne({ where: { role: 'admin' } })
      if (!admin) return
      return sendAnomalyAlertEmail(admin.email, {
        reasons: [
          `미끼(카나리) 계좌에 대한 ${ctx.action} 시도가 탐지되어 요청을 차단하고 해당 IP 를 차단했습니다.`,
        ],
        ip,
        location,
        userAgent: userAgent ?? '알 수 없음',
      })
    })(),
  ])

  throw new Error(`비정상적인 접근이 감지되었습니다 (Error: ${ctx.code})`)
}

/**
 * 카나리 IP 이력 조회 — riskEngine 의 HONEYPOT_HISTORY 신호가 허니팟과 함께 본다.
 * 미끼를 건드린 IP 는 이후 로그인에서도 위험 가중치를 받아야 한다.
 */
export function canaryHistoryWhere(ip: string, since: Date) {
  return { ip, anomaly_type: { [Op.in]: CANARY_ANOMALY_TYPES }, created_at: { [Op.gte]: since } }
}
