// ─────────────────────────────────────────────────────────────
// H. 위험 기반 적응형 인증 — 위험 점수(0~100) 산출 엔진
//
// 왜 필요한가
//   지금까지 만든 탐지들(M-1~M-8, 브루트포스, 비정상 국가, AbuseIPDB, 허니팟, HMAC …)은
//   각자 독립적으로 "탐지했다/안 했다" 만 말한다. 그래서 약한 신호 여러 개가 동시에 서도
//   아무 일이 일어나지 않고, 반대로 한 신호가 서면 맥락과 무관하게 같은 조치를 한다.
//   이 엔진은 흩어진 신호를 하나의 점수로 합쳐 **인증 강도를 연속적으로 조절**한다.
//
// 무엇을 고치는가 — 기존 인증의 사각지대
//   현재 로그인은 이분법이다: 신뢰 기기면 통과, 아니면 지갑 서명 강제.
//   문제는 **신뢰 기기 토큰이 탈취되면 어떤 위험 신호가 있어도 그냥 통과**한다는 것이다.
//   해외에서 접속하든, 물리적으로 불가능한 이동이든, 악성 IP 든 구분이 없다.
//   이 엔진은 그 구간에만 개입한다. 미신뢰 기기의 지갑 서명 요구는 그대로 두므로
//   **기존 대비 약해지는 경로가 없다** — 사각지대만 메운다.
//
// 설계 원칙
//   1) 가중 합 + 상한 클램프. noisy-OR 같은 확률 결합보다 해석·재현이 쉽고,
//      "어떤 신호가 몇 점을 올렸는가" 를 그대로 보고할 수 있다.
//   2) **관측 신호는 총합에 상한을 둔다.** 거래 관측 신호(M-6/M-7/M-8)는 오탐이 섞이는
//      것을 전제로 만든 등급이다. 이것들만 모여서 재인증을 유발하면 등급 분리를 만든
//      의미가 사라지므로, 합계를 CAP 으로 잘라 단독으로는 절대 PIN 임계를 못 넘게 한다.
//   3) 점수는 항상 근거와 함께 반환한다(어떤 신호가 몇 점인지). 관리자 화면·감사 로그가
//      "왜 이 등급인가" 를 설명할 수 있어야 한다.
// ─────────────────────────────────────────────────────────────

/** 위험 점수에 기여하는 신호. anomaly_logs 의 AnomalyType 과 이름을 맞춰 대조가 쉽게 한다. */
export type RiskSignal =
  // ── 로그인·세션 계열 ──
  | 'BRUTE_FORCE'
  | 'ABNORMAL_TIME'
  | 'CONCURRENT_SESSION'
  | 'ABNORMAL_COUNTRY'
  | 'IMPOSSIBLE_TRAVEL'
  | 'CREDENTIAL_STUFFING'
  | 'BOT_BEHAVIOR_MOUSE'
  | 'BOT_BEHAVIOR_TYPING'
  // ── 위협 인텔 ──
  | 'ABUSE_IP'
  | 'HONEYPOT_HISTORY'
  // ── 요청 무결성 ──
  | 'REQUEST_TAMPERING'
  | 'REPLAY_ATTACK'
  // ── 거래 차단 신호 ──
  | 'ABNORMAL_TRADE_AMOUNT'
  | 'POST_CHANGE_TRADE'
  | 'DORMANT_ACCOUNT_ACTIVITY'
  // ── 거래 관측 신호 (합계 상한 적용) ──
  | 'TRADE_FREQUENCY_SPIKE'
  | 'ROUND_AMOUNT_PATTERN'
  | 'MULTI_ACCOUNT_SAME_IP'

/**
 * 요구 인증 강도.
 *
 * 재인증 수단은 온체인 지갑 서명 하나로 통일한다. PIN·이메일 코드 폴백을 두지 않는 이유:
 *   · 이 서비스의 1차 인증 수단이 개인키 소유 증명이다. 계정 탈취가 의심되는 상황에서
 *     그보다 약한 수단으로 내려가면 재인증의 의미가 없다.
 *   · 이메일 코드는 메일 계정이 함께 털리면 무력하다. 자격증명 탈취를 의심해 올린 등급이
 *     이미 뚫려 있을 수 있는 채널로 내려가는 셈이다.
 *   · 폴백이 하나라도 있으면 "그 폴백을 고르는 것" 이 곧 가장 약한 경로가 된다.
 *
 * 위험 점수의 4구간(BAND)은 그대로 유지된다 — 기록·집계용 위험도 라벨이고,
 * 여기서는 '재인증이 필요한가' 만 판단한다.
 */
export type AuthRequirement = 'NONE' | 'WALLET'

export const RISK_POLICY = {
  /**
   * 신호별 가중치.
   *
   * 기준: "이 신호 하나만으로 어느 등급까지 올라가야 하는가" 로 잡았다.
   *   · 계정 탈취가 이미 진행 중임을 강하게 시사 → 단독으로 WALLET(81+) 근처
   *   · 탈취 가능성을 시사하지만 정상일 수도 → 단독으로 경계 구간(61+) 근처
   *   · 맥락 정보 → 단독으로는 주의 구간(31+) 정도
   */
  WEIGHT: {
    // 단독으로도 최고 강도에 가까워야 하는 신호
    BRUTE_FORCE: 70,          // 비밀번호 추측이 실제로 진행됐다
    IMPOSSIBLE_TRAVEL: 65,    // 물리적으로 불가능한 이동 = 자격증명 공유·탈취
    REQUEST_TAMPERING: 65,    // 요청 본문 위·변조 (HMAC 불일치)
    REPLAY_ATTACK: 65,        // 논스 재사용
    CREDENTIAL_STUFFING: 55,  // 반복 실패 후 성공
    ABUSE_IP: 55,             // 외부 위협 인텔에서 악성으로 분류된 IP
    HONEYPOT_HISTORY: 50,     // 이 IP 가 함정 엔드포인트를 건드린 적이 있다

    // 탈취 가능성을 시사하지만 정상일 수도 있는 신호
    ABNORMAL_COUNTRY: 40,     // 평소와 다른 국가 (여행일 수 있음)
    POST_CHANGE_TRADE: 40,    // 자격증명 변경 직후 고액 거래
    ABNORMAL_TRADE_AMOUNT: 35,
    CONCURRENT_SESSION: 30,   // 동시 다중 세션 (기기 여러 대일 수 있음)
    DORMANT_ACCOUNT_ACTIVITY: 30,

    // 맥락 정보
    ABNORMAL_TIME: 15,        // 심야 접속 (야근·교대근무일 수 있음)

    // 관측 신호 — 개별 가중치가 작고, 아래 CAP 으로 합계까지 제한된다
    BOT_BEHAVIOR_MOUSE: 15,
    BOT_BEHAVIOR_TYPING: 15,
    TRADE_FREQUENCY_SPIKE: 10,
    MULTI_ACCOUNT_SAME_IP: 10,
    ROUND_AMOUNT_PATTERN: 6,
  } as const satisfies Record<RiskSignal, number>,

  /**
   * 관측 신호로 분류되는 집합과 그 합계 상한.
   *
   * CAP(20)은 PIN 임계(31)보다 낮게 잡는다 — 관측 신호가 세 개 모두 서도
   * 단독으로는 어떤 재인증도 유발하지 못한다는 뜻이다. 차단 신호와 함께 설 때만
   * 등급을 밀어 올리는 보조 역할을 한다.
   */
  OBSERVATIONAL: [
    'TRADE_FREQUENCY_SPIKE',
    'ROUND_AMOUNT_PATTERN',
    'MULTI_ACCOUNT_SAME_IP',
    'BOT_BEHAVIOR_MOUSE',
    'BOT_BEHAVIOR_TYPING'
  ] as const,
  OBSERVATIONAL_CAP: 20,

  /**
   * 점수 → 위험 구간. 계획서의 4구간을 그대로 유지한다(라벨은 집계·감사용).
   * 다만 요구하는 재인증 **수단**은 통과(NONE)냐 지갑 서명(WALLET)이냐 둘뿐이다.
   */
  BAND: [
    { max: 30, requirement: 'NONE' as AuthRequirement, label: '통과' },
    { max: 60, requirement: 'WALLET' as AuthRequirement, label: '주의 — 지갑 서명' },
    { max: 80, requirement: 'WALLET' as AuthRequirement, label: '경계 — 지갑 서명' },
    { max: 100, requirement: 'WALLET' as AuthRequirement, label: '심각 — 지갑 서명' },
  ],
} as const

const OBSERVATIONAL_SET: ReadonlySet<RiskSignal> = new Set(RISK_POLICY.OBSERVATIONAL)

/** 해당 신호가 관측 등급(합계 상한 적용 대상)인지. */
export function isObservationalRisk(signal: RiskSignal): boolean {
  return OBSERVATIONAL_SET.has(signal)
}

export interface RiskContribution {
  signal: RiskSignal
  weight: number
  observational: boolean
}

export interface RiskAssessment {
  score: number                        // 0~100
  requirement: AuthRequirement
  bandLabel: string
  contributions: RiskContribution[]    // 기여도 내림차순
  gatingScore: number                  // 차단 신호 합계 (상한 적용 전)
  observationalScore: number           // 관측 신호 합계 (상한 적용 후)
  cappedBy: number                     // 상한으로 깎인 점수 (0 이면 미적용)
  detail: string                       // 감사 로그·관리자용 근거 문자열
}

/**
 * 신호 목록 → 위험 점수와 요구 인증 강도.
 *
 * 순수 함수다 — DB·시간·난수에 의존하지 않으므로 오프라인 검증이 가능하다.
 * 중복 신호는 한 번만 센다(같은 유형이 여러 번 기록돼도 점수가 부풀지 않게).
 */
export function assessRisk(signals: readonly RiskSignal[]): RiskAssessment {
  const unique = [...new Set(signals)].filter((s) => s in RISK_POLICY.WEIGHT)

  const contributions: RiskContribution[] = unique
    .map((signal) => ({
      signal,
      weight: RISK_POLICY.WEIGHT[signal],
      observational: OBSERVATIONAL_SET.has(signal),
    }))
    .sort((a, b) => b.weight - a.weight)

  const gatingScore = contributions
    .filter((c) => !c.observational)
    .reduce((sum, c) => sum + c.weight, 0)

  const rawObservational = contributions
    .filter((c) => c.observational)
    .reduce((sum, c) => sum + c.weight, 0)
  const observationalScore = Math.min(rawObservational, RISK_POLICY.OBSERVATIONAL_CAP)
  const cappedBy = rawObservational - observationalScore

  const score = Math.min(100, gatingScore + observationalScore)

  const band =
    RISK_POLICY.BAND.find((b) => score <= b.max) ?? RISK_POLICY.BAND[RISK_POLICY.BAND.length - 1]

  const parts = contributions.map(
    (c) => `${c.signal}(${c.weight}${c.observational ? ', 관측' : ''})`,
  )
  const detail =
    contributions.length === 0
      ? '위험 신호 없음 — 점수 0'
      : `위험 점수 ${score} [${band.label}] ← ${parts.join(' + ')}` +
        (cappedBy > 0 ? ` (관측 신호 상한 ${RISK_POLICY.OBSERVATIONAL_CAP} 적용, ${cappedBy}점 절삭)` : '')

  return {
    score,
    requirement: band.requirement,
    bandLabel: band.label,
    contributions,
    gatingScore,
    observationalScore,
    cappedBy,
    detail,
  }
}

/**
 * 최종 인증 요구 결정.
 *
 * 신뢰 기기가 아니면 위험 점수와 무관하게 지갑 서명을 요구한다 — 기존 정책을 그대로
 * 유지하기 위해서다. 적응형 판정은 **신뢰 기기 구간에만** 적용한다. 그 구간이 지금까지
 * 무조건 통과였던 사각지대이므로, 이 엔진을 붙여도 기존보다 약해지는 경로가 없다.
 *
 * 결과는 통과(NONE) 아니면 지갑 서명(WALLET) 둘뿐이다 — 폴백 수단을 두지 않는다.
 */
export function decideAuthRequirement(params: {
  isTrustedDevice: boolean
  risk: RiskAssessment
  /**
   * 신호 수집이 부분 실패했는가(collectRiskSignals 의 degraded).
   *
   * 이 플래그가 없으면 **DB 조회를 죽이는 것이 곧 인증 우회**가 된다. 신호를 못 읽으면
   * 점수가 0 이 되고, 신뢰 기기 구간에서는 그대로 통과(NONE)이기 때문이다.
   * 그래서 수집이 불완전하면 지갑 서명을 요구해 fail-safe 를 만든다.
   */
  degraded?: boolean
}): { requirement: AuthRequirement; reason: string } {
  if (!params.isTrustedDevice) {
    return {
      requirement: 'WALLET',
      reason: `미신뢰 기기 — 지갑 서명 필수(위험 점수 ${params.risk.score} 무관, 기존 정책 유지)`,
    }
  }

  // 신호 수집이 실패했으면 점수를 믿을 수 없다 — 통과시키지 않는다.
  if (params.degraded) {
    return {
      requirement: 'WALLET',
      reason: `신뢰 기기 — 위험 신호 수집 실패로 지갑 서명 요구. 원 판정: ${params.risk.detail}`,
    }
  }

  if (params.risk.requirement === 'NONE') {
    return { requirement: 'NONE', reason: `신뢰 기기 — ${params.risk.detail}` }
  }

  return {
    requirement: 'WALLET',
    reason: `신뢰 기기 — ${params.risk.detail} / 재인증: 온체인 지갑 서명(${params.risk.bandLabel})`,
  }
}

/** 인증 강도 순서 — 크면 강하다. 등급 비교에 쓴다. */
export const STRENGTH_ORDER: Record<AuthRequirement, number> = {
  NONE: 0,
  WALLET: 1,
}

// ─────────────────────────────────────────────────────────────
// 신호 수집 — DB·외부 인텔에서 RiskSignal 목록을 모은다
//
// 위 판정부는 순수 함수로 유지하고, "지금 이 사용자에게 어떤 신호가 서 있는가" 를
// 모으는 책임만 여기에 둔다. 수집 실패가 로그인을 막아서는 안 되므로 전 구간
// fail-safe 로 동작하되, **실패를 '신호 없음' 으로 취급해 통과시키지는 않는다** —
// 호출자가 수집 실패 여부를 알 수 있게 degraded 플래그를 함께 돌려준다.
// ─────────────────────────────────────────────────────────────

export const COLLECT_POLICY = {
  /** 사용자 이력을 되돌아보는 기간 — 최근 위험 행위가 이번 로그인에 영향을 준다 */
  LOOKBACK_HOURS: 24,
  /** 허니팟 이력은 더 길게 본다 — 스캐닝은 본 공격보다 앞서 일어난다 */
  HONEYPOT_LOOKBACK_DAYS: 30,
  /**
   * AbuseIPDB 신호 임계.
   * 차단 임계(80)보다 낮게 잡는 것이 요점이다 — 80 이상은 이미 차단되어 로그인 경로에
   * 도달하지 못한다. 25~79 의 '회색 지대' IP 가 바로 적응형 인증이 다뤄야 할 대상이다.
   */
  ABUSE_SIGNAL_MIN: 25,
} as const

/** anomaly_logs 의 유형 중 위험 점수에 반영할 것 (이름이 RiskSignal 과 1:1) */
const LOGGED_TYPES: readonly RiskSignal[] = [
  'BRUTE_FORCE', 'ABNORMAL_TIME', 'CONCURRENT_SESSION', 'ABNORMAL_COUNTRY',
  'IMPOSSIBLE_TRAVEL', 'CREDENTIAL_STUFFING', 'REQUEST_TAMPERING', 'REPLAY_ATTACK',
  'ABNORMAL_TRADE_AMOUNT', 'POST_CHANGE_TRADE', 'DORMANT_ACCOUNT_ACTIVITY',
  'TRADE_FREQUENCY_SPIKE', 'MULTI_ACCOUNT_SAME_IP', 'ROUND_AMOUNT_PATTERN',
]

export interface CollectedSignals {
  signals: RiskSignal[]
  /** 수집 중 일부 조회가 실패했는가 — true 면 점수가 과소평가됐을 수 있다 */
  degraded: boolean
}

/**
 * 로그인 시점의 위험 신호 수집.
 *
 * @param loginAnomalies `analyzeLoginAttempt` 가 방금 탐지한 유형들(즉시 반영)
 * @param abuseScore     `checkAbuseIP` 미들웨어가 넘긴 점수(외부 API 재호출 회피)
 */
export async function collectRiskSignals(params: {
  userId?: number | null
  ip: string
  loginAnomalies?: readonly string[]
  abuseScore?: number
  behaviorData?: {
    mouseMoveCount: number;
    avgTypingInterval: number;
    timeOnPage: number;
  }
}): Promise<CollectedSignals> {
  const found = new Set<RiskSignal>()
  let degraded = false

  // 1) 이번 로그인에서 방금 탐지된 것 — DB 를 거치지 않고 바로 반영
  for (const a of params.loginAnomalies ?? []) {
    if ((LOGGED_TYPES as readonly string[]).includes(a)) found.add(a as RiskSignal)
  }
  if (params.behaviorData) {
    console.log('[디버깅] 넘어온 행동 데이터:', params.behaviorData);
    const { mouseMoveCount, avgTypingInterval, timeOnPage } = params.behaviorData;
    if (timeOnPage > 500 && mouseMoveCount === 0) {
      console.info(`[RiskEngine] 마우스 움직임 없음 감지 (IP: ${params.ip}) -> 점수 부여`);
      found.add('BOT_BEHAVIOR_MOUSE');
    }
    if (avgTypingInterval > 0 && avgTypingInterval < 50) {
      console.info(`[RiskEngine] 비정상적 타자 속도 감지 (IP: ${params.ip}) -> 점수 부여`);
      found.add('BOT_BEHAVIOR_TYPING');
    }
  }

  // 2) 위협 인텔 — 이미 호출된 점수를 재사용한다
  if ((params.abuseScore ?? 0) >= COLLECT_POLICY.ABUSE_SIGNAL_MIN) found.add('ABUSE_IP')

  const { Op } = await import('sequelize')
  const { default: AnomalyLog } = await import('../../models/auth/AnomalyLog')

  // 3) 이 IP 가 함정 엔드포인트를 건드린 적이 있는가
  try {
    const since = new Date(Date.now() - COLLECT_POLICY.HONEYPOT_LOOKBACK_DAYS * 86_400_000)
    const hit = await AnomalyLog.findOne({
      where: { ip: params.ip, anomaly_type: 'HONEYPOT', created_at: { [Op.gte]: since } },
      attributes: ['id'],
    })
    if (hit) found.add('HONEYPOT_HISTORY')
  } catch (err) {
    degraded = true
    console.error('[RiskEngine] 허니팟 이력 조회 실패:', err)
  }

  // 4) 최근 이 사용자에게 기록된 위험 신호
  if (params.userId != null) {
    try {
      const since = new Date(Date.now() - COLLECT_POLICY.LOOKBACK_HOURS * 3_600_000)
      const rows = await AnomalyLog.findAll({
        where: {
          user_id: params.userId,
          anomaly_type: { [Op.in]: LOGGED_TYPES as unknown as string[] },
          created_at: { [Op.gte]: since },
        },
        attributes: ['anomaly_type'],
        raw: true,
      })
      for (const r of rows as unknown as Array<{ anomaly_type: string }>) {
        if ((LOGGED_TYPES as readonly string[]).includes(r.anomaly_type)) {
          found.add(r.anomaly_type as RiskSignal)
        }
      }
    } catch (err) {
      degraded = true
      console.error('[RiskEngine] 사용자 이상 이력 조회 실패:', err)
    }
  }

  // 재인증 수단이 지갑 서명 하나뿐이라 PIN 설정 여부는 더 이상 조회하지 않는다.
  // (지갑은 전 계정이 가입 시점에 보유하므로 '수단 가용성' 을 따질 필요가 없다)

  return { signals: [...found], degraded }
}
