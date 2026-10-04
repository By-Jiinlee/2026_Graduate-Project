import { createHash } from 'crypto'
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
 * 코드에만 존재하므로, DB 를 재구축·리시드해 실제 사용자가 이 ID 를 물면 그 사람의
 * 거래가 전부 막히고 IP 까지 차단된다. 그래서 ID 와 함께 "그 ID 에 있어야 할 계정"의
 * 이메일 지문을 박아 두고, 둘이 일치할 때만 덫을 작동시킨다(아래 바인딩 검증).
 *
 * 이메일을 평문이 아니라 SHA-256 으로 두는 이유: 저장소가 public 이다. 평문이면
 * 유출 계정 목록을 든 공격자가 미끼 이메일을 알아보고 피해 간다. ID 는 로그인에
 * 쓰이지 않으므로 공개돼도 덫의 효과가 줄지 않는다.
 * 계정을 다시 심을 때는 이 표의 ID·지문과 실제 행을 함께 맞춰야 한다.
 */
interface CanaryBinding {
  id: number
  /** sha256(trim(lowercase(email))) */
  emailSha256: string
}

const CANARY_BINDINGS: readonly CanaryBinding[] = [
  { id: 33, emailSha256: '3d1a0ff7c90752daeb6e2c82ee0d05afb6cad010891d271b94a417eb20a75735' },
]

export const CANARY_USER_IDS: readonly number[] = CANARY_BINDINGS.map((b) => b.id)

export function isCanaryUser(userId: number): boolean {
  return CANARY_USER_IDS.includes(userId)
}

// ─── 바인딩 검증 ──────────────────────────────────────────────
// 불일치 시 덫을 끄는 쪽(fail-open)을 택한다. 두 실패의 비용이 비대칭이기 때문이다.
//   덫이 꺼짐      → 기만 탐지 하나를 잃는다. 다른 탐지(허니팟·위험 엔진)는 그대로.
//   덫이 오작동    → 무고한 사용자의 모든 거래 차단 + IP 차단 + 관리자 경고 메일.
export type CanaryBindingState = 'VERIFIED' | 'MISMATCH' | 'MISSING'

export const hashCanaryEmail = (email: string): string =>
  createHash('sha256').update(email.trim().toLowerCase()).digest('hex')

/** DB 조회 결과만으로 판정하는 순수 함수 — 검증 스크립트가 DB 없이 전 분기를 시험한다. */
export function evaluateCanaryBinding(
  binding: CanaryBinding,
  row: { id: number; email: string | null } | null,
): CanaryBindingState {
  if (!row) return 'MISSING'
  // 이메일이 없는 계정(휴대폰 가입)은 미끼 계정일 수 없다
  if (!row.email) return 'MISMATCH'
  return hashCanaryEmail(row.email) === binding.emailSha256 ? 'VERIFIED' : 'MISMATCH'
}

const bindingStates = new Map<number, CanaryBindingState>()
let verifying: Promise<void> | null = null

/**
 * 기동 시 1회 호출한다. DB 오류로 판정을 못 내리면 결과를 캐시하지 않고,
 * 다음 assertNotCanary 호출 때 다시 시도한다(일시 장애를 영구 비활성으로 굳히지 않기 위해).
 */
export function verifyCanaryBindings(): Promise<void> {
  if (verifying) return verifying
  verifying = (async () => {
    try {
      for (const binding of CANARY_BINDINGS) {
        const row = await User.findByPk(binding.id, { attributes: ['id', 'email'] })
        const state = evaluateCanaryBinding(binding, row ? { id: Number(row.id), email: row.email } : null)
        bindingStates.set(binding.id, state)
        if (state === 'VERIFIED') {
          console.log(`[Canary] 바인딩 확인 — ID ${binding.id} 덫 활성`)
        } else {
          // MISSING 도 위험하다: 행이 없으면 다음 가입자가 이 ID 를 받을 수 있다.
          console.error(
            `[SECURITY] 카나리 바인딩 ${state} — ID ${binding.id} 이(가) 예상한 미끼 계정이 아님. ` +
              `정상 사용자 오차단을 막기 위해 이 ID 의 덫을 비활성화한다. canaryService.CANARY_BINDINGS 를 실제 행과 맞출 것.`,
          )
        }
      }
    } catch (err) {
      console.error('[Canary] 바인딩 검증 실패 — 다음 접근 시 재시도:', (err as Error).message)
      verifying = null
    }
  })()
  return verifying
}

/** 관리자 진단·검증 스크립트용. 아직 판정 전이면 UNVERIFIED. */
export function getCanaryBindingStatus(): { id: number; state: CanaryBindingState | 'UNVERIFIED' }[] {
  return CANARY_BINDINGS.map((b) => ({ id: b.id, state: bindingStates.get(b.id) ?? 'UNVERIFIED' }))
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

  // 기동 직후 검증이 끝나기 전에 요청이 들어와도 판정을 기다린다.
  if (!bindingStates.has(ctx.userId)) await verifyCanaryBindings()
  if (bindingStates.get(ctx.userId) !== 'VERIFIED') return

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
