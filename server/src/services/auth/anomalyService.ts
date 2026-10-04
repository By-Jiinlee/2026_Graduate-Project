import { Op, literal, UniqueConstraintError } from 'sequelize'
import AnomalyLog, { AnomalyType, AnomalyAction } from '../../models/auth/AnomalyLog'
import LoginAttempt from '../../models/auth/LoginAttempt'
import LoginRecord from '../../models/auth/LoginRecord'
import User from '../../models/user/User'
import { sendAnomalyAlertEmail } from './emailService'
import { getLocationFromIp } from '../../utils/getLocationFromIp'
import type { VerifyReason } from './hmacService'
import { blockIP, isPrivateIp } from '../../middleware/security/ipBlockMiddleware'
import { haversineKm, isValidPoint, travelSpeedKmh } from '../../utils/geoDistance'
import TradeAuthAttempt, { TradeAuthMethod } from '../../models/auth/TradeAuthAttempt'
import DeviceAccountLink, { DeviceLinkEvent } from '../../models/auth/DeviceAccountLink'

// ─────────────────────────────────────────────
// 설정 상수
// ─────────────────────────────────────────────
const CONFIG = {
  BRUTE_FORCE: {
    MAX_FAILURES_BY_EMAIL: 5,    // 이메일 기준 최대 실패 횟수
    // IP 기준 임계는 로그인 레이트 리미터(IP당 15회/15분)보다 낮아야 한다.
    // 20 이던 값은 리미터가 먼저 429 로 막아 버려 절대 도달하지 못했고, 그 결과
    // IP 축 차단과 anomaly_logs 기록이 한 번도 발생하지 않는 사문 규칙이었다.
    MAX_FAILURES_BY_IP: 10,
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
  // M-4 Impossible Travel — 직전 접속지에서 현재 접속지까지의 이동 속도
  IMPOSSIBLE_TRAVEL: {
    // 여객기 순항속도가 약 900km/h 다. 공항 이동·환승 시간을 무시하고 계산하므로
    // 실제 이동보다 항상 낮게 잡히는 방향이라, 임계를 1000 으로 두면 정상 여행자는
    // 사실상 걸리지 않는다. 이 값을 넘으면 물리적으로 불가능한 이동이다.
    MAX_SPEED_KMH: 1000,
    // GeoIP 는 도시 단위 오차가 수십 km 다. 같은 도시 안에서 잡힌 좌표 흔들림이
    // 짧은 시간차와 겹치면 속도가 무한대에 가깝게 튄다. 최소 거리 미만은 평가하지 않는다.
    MIN_DISTANCE_KM: 100,
    LOOKBACK_HOURS: 168,         // 비교 대상 직전 로그인 탐색 범위(7일)
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
  deviceHash?: string // 단말 식별 쿠키의 HMAC — 다계정 단말 탐지용
  // 무차별 대입 집계 키(계정 기준 — 이메일·휴대폰 로그인 공용). 없으면 email 로 집계
  loginKey?: string
  // 실패한 로그인에서도 해석된 계정 — 비밀번호가 틀린 요청이라 userId 가 없을 때 잠금 대상
  accountId?: number
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
  const [bruteForce, abnormalTime, concurrentSession, abnormalCountry, impossibleTravel, multiAccountDevice] = await Promise.all([
    detectBruteForce(ctx),
    ctx.success && ctx.userId ? detectAbnormalTime(ctx) : null,
    ctx.success && ctx.userId ? detectConcurrentSession(ctx.userId, ctx.ip, ctx.email, ctx.userAgent) : null,
    ctx.success && ctx.userId ? detectAbnormalCountry(ctx.userId, ctx.ip, ctx.email, ctx.userAgent) : null,
    ctx.success && ctx.userId ? detectImpossibleTravel(ctx.userId, ctx.ip, ctx.email, ctx.userAgent) : null,
    // 1단계에서만 본다 — 2단계에서 다시 보면 같은 로그인이 계정 전환으로 한 번 더 집계된다.
    ctx.success && ctx.userId && !ctx.isStep2
      ? detectMultiAccountDevice(ctx).catch((err) => {
          console.error('[Anomaly] 다계정 단말 탐지 오류:', err)
          return null
        })
      : null,
  ])

  for (const detected of [bruteForce, abnormalTime, concurrentSession, abnormalCountry, impossibleTravel, multiAccountDevice]) {
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
        ? ctx.accountId ?? await User.findOne({ where: { email: ctx.email } }).then(u => u?.id ?? null).catch(() => null)
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
        identifier: ctx.loginKey ?? ctx.email,
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
    const userExists = ctx.accountId != null || (await User.findOne({ where: { email: ctx.email } })) !== null
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
  //
  // 무차별 대입은 "비밀번호가 틀린" 요청이라 컨텍스트에 userId 가 없다. userId 가
  // 있을 때만 잠그면 정작 공격 상황에서 잠금이 DB 에 남지 않아, 관리자 화면의
  // '잠긴 계정'에도 잡히지 않고 15분 창이 지나면 조용히 풀린다. 이메일로 조회해 잠근다.
  if (action === 'LOCK') {
    const targetId = ctx.userId ?? ctx.accountId ?? (await User.findOne({ where: { email: ctx.email } }))?.id
    if (targetId) {
      await User.update({ is_locked: true }, { where: { id: targetId } })
      console.warn(`[Anomaly] 계정 잠금: userId=${targetId}`)
    }
  }

  // IP 축 초과는 응답만 403 으로 돌려주고 차단 목록에는 넣지 않고 있었다. 그 결과
  // 같은 IP 가 계속 새 요청을 만들 수 있었고, 관리자 화면의 '차단된 IP' 에도 잡히지
  // 않아 대응 근거가 남지 않았다. 판정과 실제 차단을 일치시킨다.
  // (사설 IP 는 제외 — 개발·내부망 접속을 통째로 막지 않기 위함)
  if (ipExceeded && !isPrivateIp(ctx.ip)) {
    blockIP(ctx.ip)
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
// 5. Impossible Travel 탐지 (M-4)
//
// 비정상 국가 탐지(4번)는 "가본 적 없는 나라"만 본다. 그래서 공격자가 피해자와 같은
// 나라에서 접속하면 통과하고, 반대로 정상 사용자가 새 나라로 여행만 가도 걸린다.
// 이 규칙은 국가 목록이 아니라 **이동 속도**를 본다 — 서울에서 로그인한 지 10분 만에
// 런던에서 로그인하면, 그 나라를 가봤든 아니든 두 세션 중 하나는 본인이 아니다.
//
// 계정 공유·자격증명 유출을 국가 이력과 무관하게 잡아내는 것이 목적이다.
// ─────────────────────────────────────────────
async function detectImpossibleTravel(userId: number, currentIp: string, email: string, userAgent?: string) {
  // 사설·로컬 IP 는 좌표가 없다(getLocationFromIp 가 조회 실패 시 좌표를 버린다).
  const geo = await getLocationFromIp(currentIp)
  if (geo.lat === undefined || geo.lon === undefined) return null
  const current = { lat: geo.lat, lon: geo.lon }
  if (!isValidPoint(current)) return null

  const cutoff = new Date(Date.now() - CONFIG.IMPOSSIBLE_TRAVEL.LOOKBACK_HOURS * 60 * 60 * 1000)

  // 같은 IP 의 기록은 제외한다. 이유가 둘이다.
  //  (1) 같은 IP = 같은 위치이므로 애초에 "이동"이 아니다.
  //  (2) 로그인 2단계에서는 이 함수가 호출되기 전에 saveLoginRecord 가 이미 현재 로그인을
  //      저장해 둔다. 제외하지 않으면 자기 자신과 비교해 거리 0·경과 0 이 된다.
  const previous = await LoginRecord.findOne({
    where: {
      user_id: userId,
      logged_at: { [Op.gte]: cutoff },
      latitude: { [Op.ne]: null },
      longitude: { [Op.ne]: null },
      ip_address: { [Op.ne]: currentIp },
    },
    order: [['logged_at', 'DESC']],
    attributes: ['ip_address', 'country', 'city', 'latitude', 'longitude', 'logged_at'],
  })

  if (!previous) return null // 비교할 직전 접속지가 없음(첫 로그인·좌표 미보유)

  const prevPoint = { lat: Number(previous.latitude), lon: Number(previous.longitude) }
  if (!isValidPoint(prevPoint)) return null

  const distanceKm = haversineKm(prevPoint, current)
  if (distanceKm === null) return null

  // GeoIP 도시 오차 범위 안의 이동은 평가하지 않는다(오탐 억제).
  if (distanceKm < CONFIG.IMPOSSIBLE_TRAVEL.MIN_DISTANCE_KM) return null

  const elapsedMs = Date.now() - new Date(previous.logged_at).getTime()
  const speedKmh = travelSpeedKmh(distanceKm, elapsedMs)
  if (speedKmh === null) return null // 경과 0 이하 — 시계 역전 등 비정상 입력
  if (speedKmh <= CONFIG.IMPOSSIBLE_TRAVEL.MAX_SPEED_KMH) return null

  const fromLabel = [previous.city, previous.country].filter(Boolean).join(', ') || previous.ip_address
  const toLabel = [geo.city, geo.country].filter(Boolean).join(', ') || currentIp
  const elapsedMin = Math.max(1, Math.round(elapsedMs / 60000))

  const detail =
    `이동 속도 이상: ${fromLabel} → ${toLabel}, ` +
    `${Math.round(distanceKm)}km 를 ${elapsedMin}분 만에 이동(${Math.round(speedKmh)}km/h, ` +
    `임계 ${CONFIG.IMPOSSIBLE_TRAVEL.MAX_SPEED_KMH}km/h)`

  const userMessage =
    `${fromLabel}에서 접속한 지 ${elapsedMin}분 만에 ${toLabel}에서 접속이 감지되었습니다. ` +
    `물리적으로 불가능한 이동이라 계정이 공유되었을 가능성이 있습니다. 본인이 아니라면 즉시 비밀번호를 변경해주세요.`

  await logAnomaly({
    userId,
    email,
    ip: currentIp,
    userAgent,
    type: 'IMPOSSIBLE_TRAVEL',
    // 차단하지 않고 경보만 남긴다. VPN·모바일 캐리어 NAT 사용자는 실제 위치와 다르게
    // 잡히므로 즉시 차단하면 정상 사용자를 잠글 위험이 크다. 위험 점수 집계(H)의
    // 입력 신호로 쓰고, 단독으로는 알림에 그친다.
    action: 'ALERT',
    detail,
    country: geo.country,
  })

  return { type: 'IMPOSSIBLE_TRAVEL' as AnomalyType, action: 'ALERT' as AnomalyAction, detail, userMessage }
}

// ─────────────────────────────────────────────
// 6. 크리덴셜 스터핑 탐지 (M-5) — 거래 인증 반복 실패 후 성공
//
// 무차별 대입 방어는 "실패"를 센다. 그런데 크리덴셜 스터핑의 본질은 **결국 성공한다**는
// 것이다. 성공한 순간 기존 규칙은 카운터를 지우고 조용해진다 — 가장 위험한 시점에
// 아무 기록도 남지 않는다. 이 규칙은 반대로 **성공 시점에 직전 실패 이력을 조회**해
// 고위험으로 태깅한다.
//
// 성공 자체를 막지는 않는다. 정당한 사용자가 PIN 을 몇 번 틀리는 일은 흔하기 때문이다.
// 대신 아래 세 신호로 "사람의 오타"와 "공격"을 구분한다.
//   A. 짧은 창에서 잠금 직전까지 밀어붙인 뒤 성공 (실패 4회 이상 / 30분)
//   B. 실패가 서로 다른 IP 2곳 이상에서 발생   ← 사람은 보통 한 자리에서 입력한다
//   C. 잠금 주기를 넘겨가며 누적 실패 후 성공 (24시간 8회 이상, low-and-slow)
// B·C 가 걸리면 강한 신호, A 단독이면 약한 신호로 구분해 기록한다.
// ─────────────────────────────────────────────
const CREDENTIAL_STUFFING = {
  SHORT_WINDOW_MS: 30 * 60 * 1000,
  SHORT_MIN_FAILURES: 4,      // PIN 잠금 임계가 5회이므로 4회는 "잠금 직전"이다
  LONG_WINDOW_MS: 24 * 60 * 60 * 1000,
  LONG_MIN_FAILURES: 8,
  DISTINCT_IP_MIN: 2,
} as const

export async function detectCredentialStuffing(params: {
  userId: number
  email?: string
  ip: string
  userAgent?: string
  method: TradeAuthMethod
}): Promise<void> {
  try {
    const now = Date.now()
    const longStart = new Date(now - CREDENTIAL_STUFFING.LONG_WINDOW_MS)

    // 직전 성공 이후의 실패만 세야 의미가 있다. 성공으로 한 번 끊긴 뒤의 오타는
    // 이번 성공과 무관하기 때문이다. (방금 기록한 이번 성공은 제외하고 조회한다)
    const recent = await TradeAuthAttempt.findAll({
      where: { user_id: params.userId, attempted_at: { [Op.gte]: longStart } },
      order: [['attempted_at', 'DESC']],
      attributes: ['success', 'ip', 'attempted_at'],
      limit: 100,
    })

    const streak: typeof recent = []
    let skippedOwnSuccess = false
    for (const a of recent) {
      if (a.success) {
        // 가장 최근 성공 1건 = 방금 기록한 이번 시도. 그 이전 성공에서 끊는다.
        if (!skippedOwnSuccess) { skippedOwnSuccess = true; continue }
        break
      }
      streak.push(a)
    }

    if (streak.length === 0) return

    const shortStart = now - CREDENTIAL_STUFFING.SHORT_WINDOW_MS
    const shortFailures = streak.filter((a) => new Date(a.attempted_at).getTime() >= shortStart).length
    const distinctIps = new Set(streak.map((a) => a.ip))

    const signalA = shortFailures >= CREDENTIAL_STUFFING.SHORT_MIN_FAILURES
    const signalB = distinctIps.size >= CREDENTIAL_STUFFING.DISTINCT_IP_MIN
    const signalC = streak.length >= CREDENTIAL_STUFFING.LONG_MIN_FAILURES

    if (!signalA && !signalB && !signalC) return

    const strong = signalB || signalC
    const evidence = [
      signalA ? `30분 내 실패 ${shortFailures}회 후 성공` : null,
      signalB ? `실패 출처 IP ${distinctIps.size}곳(${[...distinctIps].slice(0, 3).join(', ')})` : null,
      signalC ? `24시간 누적 실패 ${streak.length}회` : null,
    ].filter(Boolean).join(' · ')

    const label = params.method === 'PIN' ? '거래 PIN' : '지갑 서명'
    const detail = `${label} 반복 실패 후 인증 성공 — ${evidence} (판정: ${strong ? '고위험' : '주의'})`
    const userMessage =
      `${label} 인증이 여러 번 실패한 뒤 성공했습니다. 본인의 시도가 아니라면 ` +
      `즉시 비밀번호와 PIN 을 변경해주세요.`

    // 지갑 서명 경로는 이메일을 넘기지 않으므로 여기서 보완 조회한다(로그에 계정 식별자 보장).
    const email = params.email ?? (await User.findByPk(params.userId))?.email ?? ''

    await logAnomaly({
      userId: params.userId,
      email,
      ip: params.ip,
      userAgent: params.userAgent,
      type: 'CREDENTIAL_STUFFING',
      // 성공을 되돌리지 않는다 — 정당한 사용자의 오타를 자산 접근 차단으로 처벌할 수 없다.
      // 고위험 태깅과 알림에 그치고, 차단 판단은 위험 점수 집계(H)에 위임한다.
      action: 'ALERT',
      detail,
    })

    // 고위험일 때만 소유자에게 즉시 알린다. 단순 오타 반복까지 메일을 보내면
    // 경보 피로로 진짜 경고를 무시하게 된다.
    if (strong && email) {
      const last = emailCooldown.get(params.userId) ?? 0
      if (Date.now() - last > EMAIL_COOLDOWN_MS) {
        emailCooldown.set(params.userId, Date.now())
        const geo = await getLocationFromIp(params.ip).catch(() => ({ city: undefined, country: undefined }))
        await sendAnomalyAlertEmail(email, {
          reasons: [userMessage],
          ip: params.ip,
          location: [geo.city, geo.country].filter(Boolean).join(', ') || '알 수 없음',
          userAgent: params.userAgent ?? '알 수 없음',
        }).catch(console.error)
      }
    }
  } catch (err) {
    // 탐지 실패가 거래 자체를 막아서는 안 된다.
    console.error('[Anomaly] 크리덴셜 스터핑 탐지 실패:', err)
  }
}

/** 거래 인증 시도 기록 — 성공·실패 모두 남긴다. 실패 이력이 M-5 판정의 근거가 된다. */
export async function recordTradeAuthAttempt(params: {
  userId: number
  method: TradeAuthMethod
  success: boolean
  ip: string
  userAgent?: string
  email?: string
}): Promise<void> {
  try {
    await TradeAuthAttempt.create({
      user_id: params.userId,
      method: params.method,
      success: params.success,
      ip: params.ip,
      user_agent: params.userAgent ?? null,
    })
    if (params.success) await detectCredentialStuffing(params)
  } catch (err) {
    console.error('[Anomaly] 거래 인증 시도 기록 실패:', err)
  }
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
      identifier: ctx.loginKey ?? ctx.email,
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
export async function logAnomaly(params: {
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
// 행동 기반 봇 신호 기록 (로그인 1단계)
//
// 봇 신호는 1단계 요청의 behaviorData 로만 판정할 수 있다. 여기서 기록해 두어야
// 2단계가 위험 점수를 재계산할 때 이력으로 같은 신호를 읽는다. 기록이 없으면
// 1단계 안내값에만 반영되고 서버 강제에서는 빠져, 안내를 무시하는 스크립트가 통과한다.
// 관측 신호(오탐률이 높음)라 이메일 경보는 보내지 않고 ALERT 로만 남긴다.
// 호출부는 반드시 await 한다 — 응답 후 기록하면 곧바로 이어지는 2단계가 기록보다 먼저 도착할 수 있다.
// ─────────────────────────────────────────────
export async function recordBotBehavior(params: {
  userId: number
  email: string
  ip: string
  userAgent?: string
  signals: readonly ('BOT_BEHAVIOR_MOUSE' | 'BOT_BEHAVIOR_TYPING')[]
  metrics: { mouseMoveCount: number; avgTypingInterval: number; timeOnPage: number }
}): Promise<void> {
  const m = params.metrics
  const describe: Record<string, string> = {
    BOT_BEHAVIOR_MOUSE: `로그인 폼 체류 ${Math.round(m.timeOnPage)}ms 동안 마우스 이동 0회`,
    BOT_BEHAVIOR_TYPING: `로그인 폼 평균 타자 간격 ${Math.round(m.avgTypingInterval)}ms (사람의 입력 속도보다 빠름)`,
  }
  for (const signal of params.signals) {
    try {
      await logAnomaly({
        userId: params.userId,
        email: params.email,
        ip: params.ip,
        userAgent: params.userAgent,
        type: signal,
        action: 'ALERT',
        detail: `[봇 행동 · 관측] ${describe[signal]} — 위험 점수 관측 그룹(상한 20점)에 반영`,
      })
    } catch (err) {
      console.error('[Anomaly] 봇 행동 신호 기록 오류:', err)
    }
  }
}

// ─────────────────────────────────────────────
// 행동 생체인식 불일치 기록
//
// 로그인 1단계에서만 behaviorData 로 판정할 수 있으므로, 봇 신호와 같은 "기록 → 2단계 재독해"
// 경로를 타야 한다(반드시 await). 기본은 관측(ALERT)이며, BIOMETRIC_ENFORCE 토글 시 위험 점수에서
// gating 으로 다뤄져 재인증을 유발한다(기록의 action 은 그대로 ALERT — 무슨 일이 있었는지만 남긴다).
// ─────────────────────────────────────────────
export async function recordBiometricMismatch(params: {
  userId: number
  email: string
  ip: string
  userAgent?: string
  detail: string
}): Promise<void> {
  try {
    await logAnomaly({
      userId: params.userId,
      email: params.email,
      ip: params.ip,
      userAgent: params.userAgent,
      type: 'BEHAVIOR_BIOMETRIC_MISMATCH',
      action: 'ALERT',
      detail: `[행동 생체인식 · 관측] ${params.detail}`,
    })
  } catch (err) {
    console.error('[Anomaly] 행동 생체인식 불일치 기록 오류:', err)
  }
}

// ─────────────────────────────────────────────
// 디바이스 핑거프린트 변화 기록
//
// 신뢰 기기의 하드웨어 컴포넌트 지문(캔버스·WebGL·오디오·폰트·타임존)이 저장값과 달라졌을 때
// 로그인 1단계(기기 검증 시점)에서 기록한다. 2단계는 이 기록을 재독해해 같은 신호를 본다.
// 기본은 관측(ALERT). DEVICE_FP_ENFORCE 토글 시 위험 점수에서 gating 으로 다뤄진다.
// 신뢰 자체는 파기하지 않는다(정상적 하드웨어·드라이버 변화의 오탐 방지).
// ─────────────────────────────────────────────
export async function recordDeviceFingerprintMismatch(params: {
  userId: number
  email: string
  ip: string
  userAgent?: string
}): Promise<void> {
  try {
    await logAnomaly({
      userId: params.userId,
      email: params.email,
      ip: params.ip,
      userAgent: params.userAgent,
      type: 'DEVICE_FINGERPRINT_MISMATCH',
      action: 'ALERT',
      detail:
        '[디바이스 핑거프린트 · 관측] 신뢰 기기의 하드웨어 지문(캔버스·WebGL·오디오·폰트·타임존)이 ' +
        '이전 등록값과 달라졌습니다 — 기기 변조·토큰 탈취 가능성(신뢰는 유지, 위험 점수에만 반영)',
    })
  } catch (err) {
    console.error('[Anomaly] 디바이스 핑거프린트 변화 기록 오류:', err)
  }
}

// ─────────────────────────────────────────────
// 요청 서명(HMAC) 검증 실패 탐지
//
// hmacMiddleware 에서 호출한다. 응답 지연을 막기 위해 호출부는 await 하지 않고
// fire-and-forget 으로 쓰되, 여기서 발생한 오류가 프로세스를 죽이지 않도록 내부에서 흡수한다.
// 다른 탐지 항목과 동일하게 "탐지 → anomaly_logs 기록 → 이메일 경보 → 대시보드" 사이클을 따른다.
// ─────────────────────────────────────────────
const SIGNATURE_FAILURE = {
  WINDOW_MS: 5 * 60 * 1000,   // 반복 실패 집계 창
  MAX_FAILURES_BY_IP: 10,     // 동일 IP 임계 도달 시 IP 차단으로 에스컬레이션
} as const

// 검증 실패 사유 → (이상 유형, 조치) 매핑
// BAD_SIGNATURE·REPLAY·EXPIRED 는 정상 클라이언트에서 발생할 수 없어 공격으로 판정한다.
// (정상 서명은 요청 시점에 timestamp 를 생성하므로 30초 창을 넘길 수 없고, 논스는 매 요청 새로 만든다)
// MISSING_HEADERS·BAD_TIMESTAMP 는 구버전 클라이언트·서명 미구현 가능성이 있어 경보만 남긴다.
const SIGNATURE_REASON_MAP: Record<
  VerifyReason,
  { type: AnomalyType; action: AnomalyAction; label: string; attack: boolean }
> = {
  BAD_SIGNATURE:   { type: 'REQUEST_TAMPERING', action: 'BLOCK', label: '서명 불일치(요청 본문 위·변조)',      attack: true },
  REPLAY:          { type: 'REPLAY_ATTACK',     action: 'BLOCK', label: '논스 재사용(재전송)',                 attack: true },
  EXPIRED:         { type: 'REPLAY_ATTACK',     action: 'BLOCK', label: '서명 유효시간 초과(지연 재전송)',      attack: true },
  MISSING_HEADERS: { type: 'REQUEST_TAMPERING', action: 'ALERT', label: '서명 헤더 누락',                      attack: false },
  BAD_TIMESTAMP:   { type: 'REQUEST_TAMPERING', action: 'ALERT', label: '타임스탬프 형식 오류',                attack: false },
}

const signatureFailuresByIp = new Map<string, number[]>()
const signatureEmailCooldown = new Map<number, number>()

// 반복 실패 집계 → 임계 도달 시 true (동시에 창 초기화하여 중복 차단 로그를 막는다)
function shouldEscalateSignatureFailure(ip: string, now: number): boolean {
  const windowStart = now - SIGNATURE_FAILURE.WINDOW_MS
  const hits = (signatureFailuresByIp.get(ip) ?? []).filter((t) => t > windowStart)
  hits.push(now)

  if (hits.length >= SIGNATURE_FAILURE.MAX_FAILURES_BY_IP) {
    signatureFailuresByIp.delete(ip)
    return true
  }
  signatureFailuresByIp.set(ip, hits)
  return false
}

export async function recordSignatureFailure(params: {
  userId: number
  email?: string
  ip: string
  userAgent?: string
  method: string
  path: string
  reason: VerifyReason
}): Promise<void> {
  try {
    const meta = SIGNATURE_REASON_MAP[params.reason]
    if (!meta) return

    const geo = await getLocationFromIp(params.ip).catch(() => ({ city: undefined, region: undefined, country: undefined }))
    const email = params.email ?? (await User.findByPk(params.userId).then((u) => u?.email ?? '').catch(() => ''))

    // 요청 본문은 기록하지 않는다 — 주문 수량·금액 등이 로그에 평문으로 남는 것을 피한다.
    await logAnomaly({
      userId: params.userId,
      email,
      ip: params.ip,
      userAgent: params.userAgent,
      type: meta.type,
      action: meta.action,
      detail: `요청 서명 검증 실패(${params.reason}) — ${meta.label}: ${params.method} ${params.path}`,
      country: geo.country,
    })

    if (!meta.attack) return

    // 공격 판정 건은 계정 소유자에게 경보 — 세션 탈취 후 요청 조작 가능성을 알린다.
    const now = Date.now()
    const lastSent = signatureEmailCooldown.get(params.userId) ?? 0
    if (now - lastSent > EMAIL_COOLDOWN_MS && email) {
      signatureEmailCooldown.set(params.userId, now)
      await sendAnomalyAlertEmail(email, {
        reasons: [`거래 요청의 서명 검증에 실패했습니다 (${meta.label}). 요청은 차단되었습니다.`],
        ip: params.ip,
        location: [geo.city, geo.region, geo.country].filter(Boolean).join(', ') || '알 수 없음',
        userAgent: params.userAgent ?? '알 수 없음',
      }).catch(console.error)
    }

    // 동일 IP 반복 실패 → IP 차단으로 에스컬레이션 (사설 IP 는 차단 대상에서 제외)
    if (!isPrivateIp(params.ip) && shouldEscalateSignatureFailure(params.ip, now)) {
      blockIP(params.ip)
      await logAnomaly({
        userId: params.userId,
        email,
        ip: params.ip,
        userAgent: params.userAgent,
        type: meta.type,
        action: 'BLOCK',
        detail: `${SIGNATURE_FAILURE.WINDOW_MS / 60000}분 내 서명 검증 실패 ${SIGNATURE_FAILURE.MAX_FAILURES_BY_IP}회 → IP 차단`,
        country: geo.country,
      })
    }
  } catch (err) {
    console.error('[Anomaly] 서명 실패 기록 오류:', err)
  }
}

// ─────────────────────────────────────────────
// AI 추론 파이프라인 남용 탐지 기록
//
// 개별 호출 이력은 inference_logs 가 담당하고, 여기서는 임계를 넘어 "이상"으로
// 판정된 건만 anomaly_logs 로 승격해 관리자 대시보드에 노출한다.
// 계정 소유자가 아니라 관리자에게 경보한다 — 남용 주체가 계정 사용자 자신일 수 있다.
// ─────────────────────────────────────────────
const adminAlertCooldown = new Map<string, number>()

export async function recordInferenceAbuse(params: {
  userId: number
  email?: string
  ip: string
  userAgent?: string
  type: Extract<AnomalyType, 'ADVERSARIAL_INPUT' | 'INFERENCE_ABUSE'>
  action: AnomalyAction
  detail: string
}): Promise<void> {
  try {
    const geo = await getLocationFromIp(params.ip).catch(() => ({ city: undefined, region: undefined, country: undefined }))
    const email = params.email ?? (await User.findByPk(params.userId).then((u) => u?.email ?? '').catch(() => ''))

    await logAnomaly({
      userId: params.userId,
      email,
      ip: params.ip,
      userAgent: params.userAgent,
      type: params.type,
      action: params.action,
      detail: params.detail,
      country: geo.country,
    })

    if (params.action !== 'BLOCK') return

    const now = Date.now()
    const key = `${params.type}`
    if (now - (adminAlertCooldown.get(key) ?? 0) <= EMAIL_COOLDOWN_MS) return
    adminAlertCooldown.set(key, now)

    const admin = await User.findOne({ where: { role: 'admin' } })
    if (!admin) return
    await sendAnomalyAlertEmail(admin.email, {
      reasons: [`AI 추론 엔드포인트 남용 탐지: ${params.detail} (대상 계정: ${email || params.userId})`],
      ip: params.ip,
      location: [geo.city, geo.region, geo.country].filter(Boolean).join(', ') || '알 수 없음',
      userAgent: params.userAgent ?? '알 수 없음',
    }).catch(console.error)
  } catch (err) {
    console.error('[Anomaly] AI 추론 남용 기록 오류:', err)
  }
}

// ─────────────────────────────────────────────
// 거래 이상 탐지 기록 (M-1 — tradeAnomalyService 에서 호출)
//
// 자산이 움직이는 요청이므로 계정 소유자에게 알린다. 무결성 위반(BLOCK)과
// 서명 재인증 요구(미충족)만 메일을 보내고, 서명으로 본인 확인이 끝난 건은
// 기록만 남긴다 — 정상 사용자가 고액 거래를 할 때마다 메일을 받지 않도록.
// ─────────────────────────────────────────────
const tradeEmailCooldown = new Map<number, number>()

/**
 * 적응형 인증(H) 판정 기록.
 *
 * 관측 모드에서도 기록한다 — 강제를 켜기 전에 실제 등급 분포를 모으는 것이 목적이다.
 * 통과(NONE) 건은 호출자가 걸러야 한다. 전 로그인이 기록되면 집계가 무의미해진다.
 *
 * 이메일 알림은 보내지 않는다. 재인증 요구 자체는 사용자가 화면에서 즉시 인지하고,
 * 관측 모드에서는 아무 일도 일어나지 않으므로 알릴 내용이 없다.
 */
export async function recordAdaptiveDecision(params: {
  userId: number
  email?: string
  ip: string
  userAgent?: string
  requirement: string
  score: number
  enforced: boolean
  reason: string
}): Promise<void> {
  try {
    const geo = await getLocationFromIp(params.ip).catch(() => ({ country: undefined }))
    const email =
      params.email ??
      (await User.findByPk(params.userId).then((u) => u?.email ?? '').catch(() => ''))

    await logAnomaly({
      userId: params.userId,
      email,
      ip: params.ip,
      userAgent: params.userAgent,
      type: 'ADAPTIVE_STEPUP',
      // 관측 모드는 막지 않았으므로 ALERT. 강제 모드에서 실제 요구했으면 BLOCK.
      action: params.enforced ? 'BLOCK' : 'ALERT',
      detail:
        `[적응형 인증] 요구=${params.requirement} 점수=${params.score} ` +
        `모드=${params.enforced ? '강제' : '관측'} — ${params.reason}`,
      country: geo.country,
    })
  } catch (err) {
    console.error('[Anomaly] 적응형 인증 판정 기록 오류:', err)
  }
}

export async function recordTradeAnomaly(params: {
  userId: number
  email?: string
  ip: string
  userAgent?: string
  action: AnomalyAction
  notify: boolean
  detail: string
  userMessage: string
  /**
   * 맥락 신호(M-2/M-3)는 금액 이상과 구분해 기록한다. 관리자 화면에서 "얼마나 큰 거래인가"
   * 보다 "왜 지금 위험한가"가 대응 우선순위를 가르기 때문이다.
   * 두 맥락이 동시에 서면 자격증명 변경(탈취 직후 신호)을 우선한다.
   */
  types?: readonly string[]
}): Promise<void> {
  try {
    const geo = await getLocationFromIp(params.ip).catch(() => ({ city: undefined, region: undefined, country: undefined }))
    const email = params.email ?? (await User.findByPk(params.userId).then((u) => u?.email ?? '').catch(() => ''))

    const signals = params.types ?? []
    // 맥락 신호(M-2/M-3) > 금액 이상 > 관측 신호(M-6) 순.
    // 관측 신호를 맨 뒤에 두는 이유: 금액 이상과 동시에 서면 대응 우선순위는
    // 금액 쪽이고, 단독으로 섰을 때만 빈도 유형으로 분류되어야 하기 때문이다.
    // 관측 신호 목록. 원본은 tradeAnomalyService.OBSERVATIONAL_SIGNALS 이지만
    // 그쪽이 이 파일을 import 하고 있어(순환) 여기서는 값을 복제한다.
    // 신호를 추가할 때 두 곳을 함께 고칠 것.
    const OBSERVATIONAL = [
      'TRADE_FREQUENCY_SPIKE', 'ROUND_AMOUNT_PATTERN', 'MULTI_ACCOUNT_SAME_IP',
      'SPOOFING_ORDER', 'WASH_TRADE', 'BOT_TRADE_BEHAVIOR',
    ]
    const gating = signals.filter((sig) => !OBSERVATIONAL.includes(sig))

    // 맥락 신호(M-2/M-3) > 금액 이상 > 관측 신호(시장조작·빈도·패턴) 순.
    // 시장 조작 계열(S10~S12)은 관측 신호이므로 금액 이상 뒤에 두되, 각자 고유 유형으로
    // 기록해 대시보드에서 따로 집계되게 한다. (gating 은 위 지역 OBSERVATIONAL 기준이라
    // enforce 토글과 무관하게 계산된다.)
    const type: AnomalyType =
      signals.includes('POST_CREDENTIAL_CHANGE') ? 'POST_CHANGE_TRADE'
        : signals.includes('DORMANT_ACTIVITY') ? 'DORMANT_ACCOUNT_ACTIVITY'
          : gating.length > 0 ? 'ABNORMAL_TRADE_AMOUNT'
            : signals.includes('SPOOFING_ORDER') ? 'SPOOFING_ORDER'
              : signals.includes('WASH_TRADE') ? 'WASH_TRADE'
                : signals.includes('BOT_TRADE_BEHAVIOR') ? 'BOT_TRADE_BEHAVIOR'
                  : signals.includes('MULTI_ACCOUNT_SAME_IP') ? 'MULTI_ACCOUNT_SAME_IP'
                    : signals.includes('TRADE_FREQUENCY_SPIKE') ? 'TRADE_FREQUENCY_SPIKE'
                      : 'ROUND_AMOUNT_PATTERN'

    await logAnomaly({
      userId: params.userId,
      email,
      ip: params.ip,
      userAgent: params.userAgent,
      type,
      action: params.action,
      detail: params.detail,
      country: geo.country,
    })

    if (!params.notify || !email) return

    const now = Date.now()
    if (now - (tradeEmailCooldown.get(params.userId) ?? 0) <= EMAIL_COOLDOWN_MS) return
    tradeEmailCooldown.set(params.userId, now)

    await sendAnomalyAlertEmail(email, {
      reasons: [params.userMessage || '평소와 다른 규모의 거래 요청이 감지되었습니다.'],
      ip: params.ip,
      location: [geo.city, geo.region, geo.country].filter(Boolean).join(', ') || '알 수 없음',
      userAgent: params.userAgent ?? '알 수 없음',
    }).catch(console.error)
  } catch (err) {
    console.error('[Anomaly] 거래 이상 기록 오류:', err)
  }
}

// ─────────────────────────────────────────────
// 단말 다계정 탐지 (1인 1계정 원칙)
//
// 증권 서비스는 1인 1계정이 원칙이다. 가입 시 이메일·휴대폰·지갑 중복은 검사하지만
// 지갑은 무제한으로 새로 만들 수 있고, 휴대폰 인증도 문자 PIN 확인일 뿐 공인 본인확인이
// 아니어서 가입 단계만으로는 한 사람의 다계정을 막을 수 없다. 그래서 "한 단말에서 몇 개의
// 계정이 쓰이는가"를 관측한다.
//
// 위험 점수(riskEngine)에는 넣지 않는다. 위험 점수는 "이 로그인이 계정 주인의 것인가"를
// 판단해 지갑 서명 재인증을 요구하는데, 다계정 사용자는 모든 계정의 지갑을 직접 갖고 있어
// 재인증이 아무것도 막지 못한다. 대응은 기록·관리자 검토와 신규 가입 제한으로 한다.
// 같은 단말에서 남의 계정들을 시도하는 탈취 공격도 이 신호에 잡히지만, 그 공격자는 피해자의
// 지갑이 없어 기존 미신뢰 기기 지갑 서명 요구에서 이미 막힌다.
// ─────────────────────────────────────────────
export const MULTI_ACCOUNT_DEVICE_POLICY = {
  // 로그인 관측 창 — 이 기간 안에 같은 단말에서 쓰인 다른 계정을 센다.
  WINDOW_DAYS: 30,
  // 이 시간 안에 같은 단말에서 다른 계정으로 바꿔 로그인하면 "계정 전환"으로 본다.
  // 가족이 한 PC 를 나눠 쓰는 경우에도 10분 안에 번갈아 로그인하는 일은 드물다.
  SWITCH_WINDOW_MINUTES: 10,
  // 이미 활성 계정이 이 수 이상 연결된 단말에서는 신규 가입을 막는다.
  // 1 이면 가족 공용 PC 의 두 번째 가입까지 막으므로 2 로 둔다(세 번째 계정부터 차단).
  REGISTER_BLOCK_AT: 2,
  // 같은 단말의 계정 전환 경보 반복 억제
  SWITCH_ALERT_COOLDOWN_MINUTES: 30,
} as const

export interface DeviceLinkView {
  userId: number
  lastSeenAt: Date
  active: boolean
}

export type DeviceLoginVerdict =
  | { flagged: false }
  | {
      flagged: true
      newAccount: boolean
      rapidSwitch: boolean
      otherAccounts: number[]
      switchedFrom: number[]
    }

// 로그인 판정 — 이 단말에 이번 계정 외의 활성 계정이 창 안에 있고,
// (a) 이번 계정이 이 단말에 처음 나타났거나 (b) 짧은 시간 안에 다른 계정에서 바꿔 들어왔으면 표시한다.
// 이미 알려진 조합이 평소처럼 로그인하는 것은 다시 기록하지 않는다(가족 공용 PC 의 일상 사용).
export function judgeDeviceLogin(p: {
  userId: number
  isNewLink: boolean
  links: readonly DeviceLinkView[]
  now: Date
}): DeviceLoginVerdict {
  const windowStart = p.now.getTime() - MULTI_ACCOUNT_DEVICE_POLICY.WINDOW_DAYS * 86_400_000
  const switchStart = p.now.getTime() - MULTI_ACCOUNT_DEVICE_POLICY.SWITCH_WINDOW_MINUTES * 60_000
  const others = p.links.filter(
    (l) => l.active && l.userId !== p.userId && l.lastSeenAt.getTime() >= windowStart,
  )
  if (others.length === 0) return { flagged: false }
  const switchedFrom = others.filter((l) => l.lastSeenAt.getTime() >= switchStart).map((l) => l.userId)
  const rapidSwitch = switchedFrom.length > 0
  if (!p.isNewLink && !rapidSwitch) return { flagged: false }
  return {
    flagged: true,
    newAccount: p.isNewLink,
    rapidSwitch,
    otherAccounts: [...new Set(others.map((l) => l.userId))].sort((a, b) => a - b),
    switchedFrom: [...new Set(switchedFrom)].sort((a, b) => a - b),
  }
}

export type DeviceRegistrationVerdict =
  | { allow: true; sharedWith: number[] }
  | { allow: false; reason: 'NO_DEVICE_ID' | 'DEVICE_ACCOUNT_LIMIT'; activeAccounts: number[] }

// 가입 판정 — 기간 제한 없이 이 단말에 연결된 활성(탈퇴하지 않은) 계정 수로 판정한다.
// 기간을 두면 30일만 기다렸다가 다시 가입하는 방식으로 우회된다. 탈퇴한 계정은 세지 않는다 —
// 탈퇴 후 재가입은 1인 1계정을 어기지 않는다.
export function judgeDeviceRegistration(p: {
  deviceFresh: boolean
  links: readonly DeviceLinkView[]
}): DeviceRegistrationVerdict {
  if (p.deviceFresh) return { allow: false, reason: 'NO_DEVICE_ID', activeAccounts: [] }
  const active = [...new Set(p.links.filter((l) => l.active).map((l) => l.userId))].sort((a, b) => a - b)
  if (active.length >= MULTI_ACCOUNT_DEVICE_POLICY.REGISTER_BLOCK_AT) {
    return { allow: false, reason: 'DEVICE_ACCOUNT_LIMIT', activeAccounts: active }
  }
  return { allow: true, sharedWith: active }
}

export class DeviceRegistrationBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeviceRegistrationBlockedError'
  }
}

async function loadDeviceLinks(deviceHash: string): Promise<DeviceLinkView[]> {
  const rows = await DeviceAccountLink.findAll({
    where: { device_hash: deviceHash },
    attributes: ['user_id', 'last_seen_at'],
  })
  if (rows.length === 0) return []
  const ids = [...new Set(rows.map((r) => Number(r.user_id)))]
  const users = await User.findAll({ where: { id: { [Op.in]: ids } }, attributes: ['id', 'status'] })
  const activeIds = new Set(users.filter((u) => u.status !== 'withdrawn').map((u) => Number(u.id)))
  return rows.map((r) => ({
    userId: Number(r.user_id),
    lastSeenAt: new Date(r.last_seen_at),
    active: activeIds.has(Number(r.user_id)),
  }))
}

// 연결을 갱신하고, 이번에 새로 생긴 연결인지 돌려준다.
async function touchDeviceLink(deviceHash: string, userId: number, event: DeviceLinkEvent): Promise<boolean> {
  const now = new Date()
  const existing = await DeviceAccountLink.findOne({ where: { device_hash: deviceHash, user_id: userId } })
  if (existing) {
    await existing.update({ last_seen_at: now })
    return false
  }
  try {
    await DeviceAccountLink.create({
      device_hash: deviceHash, user_id: userId, first_event: event, first_seen_at: now, last_seen_at: now,
    })
    return true
  } catch (err) {
    // 같은 단말·계정의 동시 요청이 먼저 만들었다 — 새 연결이 아니다.
    if (err instanceof UniqueConstraintError) return false
    throw err
  }
}

const switchAlertCooldown = new Map<string, number>()

// 로그인 1단계(비밀번호 검증) 성공 시 호출된다. 2단계가 아니라 1단계에서 보는 이유는,
// 한 단말에서 여러 계정의 비밀번호를 맞혀 보는 시도(지갑 서명 전 단계)까지 관측하기 위해서다.
export async function detectMultiAccountDevice(ctx: LoginContext) {
  if (!ctx.userId || !ctx.deviceHash) return null
  const links = await loadDeviceLinks(ctx.deviceHash)
  const isNewLink = await touchDeviceLink(ctx.deviceHash, ctx.userId, 'LOGIN')
  const v = judgeDeviceLogin({ userId: ctx.userId, isNewLink, links, now: new Date() })
  if (!v.flagged) return null

  if (!v.newAccount) {
    const now = Date.now()
    const last = switchAlertCooldown.get(ctx.deviceHash) ?? 0
    if (now - last < MULTI_ACCOUNT_DEVICE_POLICY.SWITCH_ALERT_COOLDOWN_MINUTES * 60_000) return null
    switchAlertCooldown.set(ctx.deviceHash, now)
  }

  const tags = [v.newAccount ? '신규 계정 연결' : null, v.rapidSwitch ? '계정 전환' : null].filter(Boolean).join('·')
  const detail =
    `[1인 1계정 · ${tags}] 이 단말에서 최근 ${MULTI_ACCOUNT_DEVICE_POLICY.WINDOW_DAYS}일간 사용된 다른 계정 ` +
    `${v.otherAccounts.length}개 (user_id: ${v.otherAccounts.join(', ')})` +
    (v.rapidSwitch
      ? ` — ${MULTI_ACCOUNT_DEVICE_POLICY.SWITCH_WINDOW_MINUTES}분 안에 user_id ${v.switchedFrom.join(', ')} 에서 전환`
      : '') +
    ` / 단말 ${ctx.deviceHash.slice(0, 12)}`

  await logAnomaly({
    userId: ctx.userId, email: ctx.email, ip: ctx.ip, userAgent: ctx.userAgent,
    type: 'MULTI_ACCOUNT_DEVICE', action: 'ALERT', detail,
  })
  return {
    type: 'MULTI_ACCOUNT_DEVICE' as AnomalyType,
    action: 'ALERT' as AnomalyAction,
    detail,
    userMessage: '이 기기에서 다른 계정의 로그인 이력이 확인되었습니다. 본인이 사용하지 않은 기기라면 비밀번호를 변경해주세요.',
  }
}

// 회원가입 직전 — 단말 한도를 넘으면 가입을 막고 기록한다.
export async function assertRegistrationDeviceAllowed(p: {
  deviceHash?: string
  deviceFresh?: boolean
  email: string
  ip: string
  userAgent?: string
}): Promise<{ sharedWith: number[] }> {
  if (!p.deviceHash) return { sharedWith: [] }
  const links = await loadDeviceLinks(p.deviceHash)
  const v = judgeDeviceRegistration({ deviceFresh: p.deviceFresh === true, links })
  if (v.allow) return { sharedWith: v.sharedWith }

  const detail =
    v.reason === 'NO_DEVICE_ID'
      ? '[1인 1계정 · 식별자 없는 가입] 단말 식별 쿠키 없이 가입 요청 — 쿠키를 버리는 자동화 가입 의심'
      : `[1인 1계정 · 가입 차단] 이 단말에 이미 활성 계정 ${v.activeAccounts.length}개 ` +
        `(user_id: ${v.activeAccounts.join(', ')}) / 단말 ${p.deviceHash.slice(0, 12)}`
  await logAnomaly({
    email: p.email, ip: p.ip, userAgent: p.userAgent,
    type: 'MULTI_ACCOUNT_DEVICE', action: 'BLOCK', detail,
  }).catch((err) => console.error('[Anomaly] 다계정 가입 차단 기록 오류:', err))

  throw new DeviceRegistrationBlockedError(
    v.reason === 'NO_DEVICE_ID'
      ? '브라우저 쿠키가 차단되어 있어 가입할 수 없습니다. 쿠키를 허용한 뒤 새로고침하여 다시 시도해주세요'
      : '1인 1계정 원칙에 따라 이 기기에서는 더 이상 새 계정을 만들 수 없습니다',
  )
}

// 회원가입 직후 — 연결을 남기고, 다른 활성 계정이 있던 단말이면 기록한다.
export async function linkRegisteredAccount(p: {
  deviceHash?: string
  userId: number
  email: string
  ip: string
  userAgent?: string
  sharedWith: number[]
}): Promise<void> {
  if (!p.deviceHash) return
  try {
    await touchDeviceLink(p.deviceHash, p.userId, 'REGISTER')
    if (p.sharedWith.length === 0) return
    await logAnomaly({
      userId: p.userId, email: p.email, ip: p.ip, userAgent: p.userAgent,
      type: 'MULTI_ACCOUNT_DEVICE', action: 'ALERT',
      detail:
        `[1인 1계정 · 공용 단말 가입] 활성 계정 ${p.sharedWith.length}개(user_id: ${p.sharedWith.join(', ')})가 ` +
        `있는 단말에서 신규 가입 / 단말 ${p.deviceHash.slice(0, 12)}`,
    })
  } catch (err) {
    console.error('[Anomaly] 가입 단말 연결 기록 오류:', err)
  }
}

// ─────────────────────────────────────────────
// 체결 장부 위·변조 (ledgerAnchorService.verifyDay 에서 호출)
//
// 고정된 일별 장부 루트와 현재 주문 기록으로 다시 계산한 루트가 다르면, 체결 기록이 사후에
// 바뀐 것이다. 특정 사용자의 행위가 아니라 데이터베이스 쓰기 권한의 오·남용이므로 계정 소유자가
// 아니라 관리자에게 알린다. 같은 사유의 반복 메일은 쿨다운으로 억제한다.
// ─────────────────────────────────────────────
export async function recordLedgerTampering(detail: string): Promise<void> {
  try {
    await logAnomaly({
      email: '',
      ip: 'system',
      type: 'LEDGER_TAMPERING',
      action: 'ALERT',
      detail,
    })
    const now = Date.now()
    const key = `LEDGER_TAMPERING:${detail.slice(0, 40)}`
    if (now - (adminAlertCooldown.get(key) ?? 0) <= EMAIL_COOLDOWN_MS) return
    adminAlertCooldown.set(key, now)
    const admin = await User.findOne({ where: { role: 'admin' } })
    if (!admin) return
    await sendAnomalyAlertEmail(admin.email, {
      reasons: [`모의투자 체결 장부 위·변조 탐지: ${detail}`],
      ip: 'system',
      location: '서버 정기 검증',
      userAgent: 'ledgerAnchorScheduler',
    }).catch(console.error)
  } catch (err) {
    console.error('[Anomaly] 장부 위·변조 기록 오류:', err)
  }
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
