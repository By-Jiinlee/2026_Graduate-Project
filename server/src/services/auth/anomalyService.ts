import { Op, literal } from 'sequelize'
import AnomalyLog, { AnomalyType, AnomalyAction } from '../../models/auth/AnomalyLog'
import LoginAttempt from '../../models/auth/LoginAttempt'
import LoginRecord from '../../models/auth/LoginRecord'
import User from '../../models/user/User'
import { sendAnomalyAlertEmail } from './emailService'
import { getLocationFromIp } from '../../utils/getLocationFromIp'

// ─────────────────────────────────────────────
// 설정 상수
// ─────────────────────────────────────────────
const CONFIG = {
  BRUTE_FORCE: {
    MAX_FAILURES_BY_EMAIL: 5,    // 이메일 기준 최대 실패 횟수
    MAX_FAILURES_BY_IP: 20,      // IP 기준 최대 실패 횟수
    WINDOW_MINUTES: 15,          // 감지 시간 윈도우
    LOCK_DURATION_MINUTES: 30,   // 계정 잠금 시간
  },
  ABNORMAL_TIME: {
    NORMAL_START: 6,             // 정상 로그인 시작 시각 (KST)
    NORMAL_END: 23,              // 정상 로그인 종료 시각 (KST)
    KST_OFFSET: 9,               // UTC+9
  },
  CONCURRENT_SESSION: {
    WINDOW_MINUTES: 30,          // 동시 세션 감지 윈도우
    MAX_IPS: 3,                  // 허용 동시 IP 수
  },
  GEO: {
    HISTORY_DAYS: 90,            // 비교 기준 과거 접속 기록 기간
  },
} as const

// ─────────────────────────────────────────────
// 타입
// ─────────────────────────────────────────────
export interface LoginContext {
  userId?: number
  email: string
  ip: string
  userAgent?: string
  success: boolean
  isStep2?: boolean  // Step2(MetaMask)에서 호출 시 true — 시도 기록 중복 방지용
}

export interface AnomalyResult {
  blocked: boolean
  locked: boolean
  anomalies: AnomalyType[]
  reasons: string[]        // DB/관리자용 기술적 상세
  userMessages: string[]   // 사용자 이메일 표시용 친화적 메시지
}

// 이메일 알림 쿨다운 — userId당 30분 이내 중복 발송 방지
const emailCooldown = new Map<number, number>()
const EMAIL_COOLDOWN_MS = 30 * 60 * 1000

// ─────────────────────────────────────────────
// 메인 진입점 — loginStep1/Step2 완료 후 호출
// ─────────────────────────────────────────────
export async function analyzeLoginAttempt(ctx: LoginContext): Promise<AnomalyResult> {
  const result: AnomalyResult = { blocked: false, locked: false, anomalies: [], reasons: [], userMessages: [] }

  // 시도 기록 저장 — Step2는 Step1에서 이미 기록했으므로 스킵 (이중 카운트 방지)
  if (!ctx.isStep2) await recordLoginAttempt(ctx)

  // 병렬 탐지 실행
  // ABNORMAL_TIME/CONCURRENT_SESSION/ABNORMAL_COUNTRY는 로그인 성공 시에만 의미 있음
  const [bruteForce, abnormalTime, concurrentSession, abnormalCountry] = await Promise.all([
    detectBruteForce(ctx),
    ctx.success && ctx.userId ? detectAbnormalTime(ctx) : null,
    ctx.success && ctx.userId ? detectConcurrentSession(ctx.userId, ctx.ip, ctx.email, ctx.userAgent) : null,
    ctx.success && ctx.userId ? detectAbnormalCountry(ctx.userId, ctx.ip, ctx.email, ctx.userAgent) : null,
  ])

  for (const detected of [bruteForce, abnormalTime, concurrentSession, abnormalCountry]) {
    if (!detected) continue
    result.anomalies.push(detected.type)
    result.reasons.push(detected.detail)
    result.userMessages.push(detected.userMessage)
    if (detected.action === 'LOCK') result.locked = true
    if (detected.action === 'BLOCK') result.blocked = true
  }

  // 이상 감지 시 이메일 알림 — 30분 쿨다운으로 중복 발송 방지
  if (result.anomalies.length > 0) {
    // userId가 없는 경우(로그인 실패) 이메일로 유저 조회 (계정 잠금 알림 보장)
    const notifyUserId = ctx.userId ?? (
      result.locked
        ? await User.findOne({ where: { email: ctx.email } }).then(u => u?.id ?? null).catch(() => null)
        : null
    )
    if (notifyUserId) {
      const now = Date.now()
      const lastSent = emailCooldown.get(notifyUserId) ?? 0
      if (now - lastSent > EMAIL_COOLDOWN_MS) {
        emailCooldown.set(notifyUserId, now)
        await notifyByEmail(notifyUserId, ctx, result).catch(console.error)
      }
    }
  }

  return result
}

// ─────────────────────────────────────────────
// 1. Brute Force 탐지
// ─────────────────────────────────────────────
async function detectBruteForce(ctx: LoginContext) {
  const windowStart = new Date(Date.now() - CONFIG.BRUTE_FORCE.WINDOW_MINUTES * 60 * 1000)

  const [failsByEmail, failsByIp] = await Promise.all([
    LoginAttempt.count({
      where: {
        identifier: ctx.email,
        identifier_type: 'EMAIL',
        success: false,
        created_at: { [Op.gte]: windowStart },
      },
    }),
    LoginAttempt.count({
      where: {
        ip: ctx.ip,
        identifier_type: 'IP',
        success: false,
        created_at: { [Op.gte]: windowStart },
      },
    }),
  ])

  const emailExceeded = failsByEmail >= CONFIG.BRUTE_FORCE.MAX_FAILURES_BY_EMAIL
  const ipExceeded = failsByIp >= CONFIG.BRUTE_FORCE.MAX_FAILURES_BY_IP

  if (!emailExceeded && !ipExceeded) return null

  // ↓ 이메일 기준 초과 시 users 테이블에 실제 존재하는지 확인
  let action: AnomalyAction = ipExceeded ? 'BLOCK' : 'ALERT'
  if (emailExceeded) {
    const userExists = await User.findOne({ where: { email: ctx.email } })
    if (userExists) {
      action = 'LOCK'
    } else {
      // 존재하지 않는 이메일이면 잠금 없이 BLOCK만
      action = 'BLOCK'
    }
  }

  const detail = emailExceeded
    ? `${CONFIG.BRUTE_FORCE.WINDOW_MINUTES}분 내 로그인 실패 ${failsByEmail}회 → 계정 잠금`
    : `${CONFIG.BRUTE_FORCE.WINDOW_MINUTES}분 내 IP(${ctx.ip}) 실패 ${failsByIp}회 → IP 차단`

  const userMessage = emailExceeded
    ? '비밀번호 오류가 반복되어 보안을 위해 계정이 잠겼습니다. 관리자에게 문의해주세요.'
    : '동일한 위치에서 과도한 로그인 시도가 감지되었습니다.'

  await logAnomaly({ ...ctx, type: 'BRUTE_FORCE', action, detail })

  // 계정 잠금 처리 — is_locked 해제는 관리자 수동 또는 별도 스케줄러로 처리
  if (action === 'LOCK' && ctx.userId) {
    await User.update({ is_locked: true }, { where: { id: ctx.userId } })
    console.warn(`[Anomaly] 계정 잠금: userId=${ctx.userId}, email=${ctx.email}`)
  }

  return { type: 'BRUTE_FORCE' as AnomalyType, action, detail, userMessage }
}

// ─────────────────────────────────────────────
// 2. 비정상 시간대 탐지 (KST 기준)
// ─────────────────────────────────────────────
async function detectAbnormalTime(ctx: LoginContext) {
  const kstHour = (new Date().getUTCHours() + CONFIG.ABNORMAL_TIME.KST_OFFSET) % 24
  const isAbnormal =
    kstHour < CONFIG.ABNORMAL_TIME.NORMAL_START ||
    kstHour >= CONFIG.ABNORMAL_TIME.NORMAL_END

  if (!isAbnormal) return null

  const detail = `비정상 시간대 접속: KST ${kstHour}시 (정상 범위: ${CONFIG.ABNORMAL_TIME.NORMAL_START}~${CONFIG.ABNORMAL_TIME.NORMAL_END}시)`
  const timeLabel = kstHour < 12 ? `오전 ${kstHour}시` : `오후 ${kstHour - 12}시`
  const userMessage = `평소와 다른 시간대(${timeLabel})에 로그인이 감지되었습니다.`

  await logAnomaly({ ...ctx, type: 'ABNORMAL_TIME', action: 'ALERT', detail })

  return { type: 'ABNORMAL_TIME' as AnomalyType, action: 'ALERT' as AnomalyAction, detail, userMessage }
}

// ─────────────────────────────────────────────
// 3. 동시 다중 세션 탐지 (LoginRecord 활용)
// ─────────────────────────────────────────────
async function detectConcurrentSession(userId: number, currentIp: string, email: string, userAgent?: string) {
  const windowStart = new Date(Date.now() - CONFIG.CONCURRENT_SESSION.WINDOW_MINUTES * 60 * 1000)

  const records = await LoginRecord.findAll({
    where: literal(
      `user_id = ${userId} AND logged_at >= '${windowStart.toISOString().slice(0, 19).replace('T', ' ')}'`
    ),
    attributes: ['ip_address'],
    group: ['ip_address'],
  })

  const activeIps = records.map((r: any) => r.ip_address as string)
  const isNewIp = !activeIps.includes(currentIp)

  if (activeIps.length < CONFIG.CONCURRENT_SESSION.MAX_IPS && !isNewIp) return null

  const detail = isNewIp
    ? `새로운 IP(${currentIp})에서 동시 세션 감지. 기존 활성 IP: [${activeIps.join(', ')}]`
    : `동시 세션 ${activeIps.length}개 감지 (허용: ${CONFIG.CONCURRENT_SESSION.MAX_IPS}개)`
  const userMessage = isNewIp
    ? '다른 위치의 기기에서 동시 접속이 감지되었습니다. 본인이 아니라면 즉시 비밀번호를 변경해주세요.'
    : '여러 기기에서 동시에 로그인이 감지되었습니다.'

  await logAnomaly({
    userId,
    email,
    ip: currentIp,
    userAgent,
    type: 'CONCURRENT_SESSION',
    action: 'ALERT',
    detail
  })

  return { type: 'CONCURRENT_SESSION' as AnomalyType, action: 'ALERT' as AnomalyAction, detail, userMessage }
}

// ─────────────────────────────────────────────
// 4. 비정상 국가 탐지 (LoginRecord geo 데이터 활용)
// ─────────────────────────────────────────────
async function detectAbnormalCountry(userId: number, currentIp: string, email: string, userAgent?: string) {
  // 현재 IP 국가 조회 (로컬/사설 IP는 country가 undefined → null 반환)
  const geo = await getLocationFromIp(currentIp)
  const currentCountry = geo.country ?? null

  if (!currentCountry) return null

  const cutoff = new Date(Date.now() - CONFIG.GEO.HISTORY_DAYS * 24 * 60 * 60 * 1000)

  // LoginRecord에서 과거 접속 국가 목록 조회
  // country가 string | undefined 타입이므로 literal로 IS NOT NULL 처리
  const records = await LoginRecord.findAll({
    where: literal(
      `user_id = ${userId} AND logged_at >= '${cutoff.toISOString().slice(0, 19).replace('T', ' ')}' AND country IS NOT NULL`
    ),
    attributes: ['country'],
    group: ['country'],
  })

  const knownCountries = records.map((r: any) => r.country as string).filter(Boolean)

  // 첫 로그인이면 이상 아님
  if (knownCountries.length === 0) return null

  if (knownCountries.includes(currentCountry)) return null

  const detail = `평소와 다른 국가 접속: ${currentCountry} (기존: ${knownCountries.join(', ')})`
  const userMessage = `평소와 다른 국가(${currentCountry})에서 접속이 감지되었습니다. 본인이 아니라면 즉시 비밀번호를 변경해주세요.`

  await logAnomaly({
    userId,
    email,
    ip: currentIp,
    userAgent,
    type: 'ABNORMAL_COUNTRY',
    action: 'ALERT',
    detail,
    country: currentCountry,
  })

  return { type: 'ABNORMAL_COUNTRY' as AnomalyType, action: 'ALERT' as AnomalyAction, detail, userMessage }
}

// ─────────────────────────────────────────────
// 계정 잠금 여부 확인 — loginStep1 앞에서 호출
// ─────────────────────────────────────────────
export async function isAccountLocked(
  email: string,
): Promise<{ locked: boolean }> {
  const user = await User.findOne({ where: { email } })
  if (!user) return { locked: false }
  return { locked: user.is_locked }
}

// ─────────────────────────────────────────────
// 헬퍼: 시도 기록 저장
// ─────────────────────────────────────────────
async function recordLoginAttempt(ctx: LoginContext) {
  await Promise.all([
    LoginAttempt.create({
      identifier: ctx.email,
      identifier_type: 'EMAIL',
      ip: ctx.ip,
      success: ctx.success,
    }),
    LoginAttempt.create({
      identifier: ctx.ip,
      identifier_type: 'IP',
      ip: ctx.ip,
      success: ctx.success,
    }),
  ])
}

// ─────────────────────────────────────────────
// 헬퍼: 이상 로그 기록
// ─────────────────────────────────────────────
async function logAnomaly(params: {
  userId?: number
  email: string
  ip: string
  userAgent?: string
  type: AnomalyType
  action: AnomalyAction
  detail: string
  country?: string
}) {
  await AnomalyLog.create({
    user_id: params.userId ?? null,
    email: params.email || null,
    ip: params.ip,
    user_agent: params.userAgent ?? null,
    anomaly_type: params.type,
    action: params.action,
    detail: params.detail,
    country: params.country ?? null,
  })
}

// ─────────────────────────────────────────────
// 헬퍼: 이메일 알림 (SMS 비활성화 상태)
// ─────────────────────────────────────────────
async function notifyByEmail(userId: number, ctx: LoginContext, result: AnomalyResult) {
  const user = await User.findByPk(userId)
  if (!user) return

  // IP 위치 정보 조회 (이메일 표시용)
  const geo = await getLocationFromIp(ctx.ip).catch(() => ({ city: undefined, region: undefined, country: undefined }))

  await sendAnomalyAlertEmail(user.email, {
    reasons: result.userMessages,
    ip: ctx.ip,
    location: [geo.city, geo.region, geo.country].filter(Boolean).join(', ') || '알 수 없음',
    userAgent: ctx.userAgent ?? '알 수 없음',
  })
}
