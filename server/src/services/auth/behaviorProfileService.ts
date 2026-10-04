import BehaviorProfile from '../../models/auth/BehaviorProfile'

// ─────────────────────────────────────────────────────────────
// 행동 생체인식 — 사용자별 키스트로크·마우스 리듬 프로필의 누적·비교
//
// 로그인마다 수집한 행동 특징을 EWMA 로 누적해 "평소 리듬"을 만들고(enrollment),
// 표본이 충분해지면 이후 로그인 특징이 프로필에서 얼마나 벗어났는지(표준화 거리)를 재어
// 임계를 넘으면 불일치(세션 탈취 의심)로 본다.
//
// 설계 원칙
//   · 순수 함수(extractFeatures / scoreFeatures / ewmaUpdate)와 DB 접근(processLoginBehavior)을
//     분리해 오프라인 검증이 가능하게 한다(riskEngine 과 동일한 철학).
//   · 프로필 오염 방지 — 불일치로 판정된 세션의 특징으로는 프로필을 갱신하지 않는다.
//     (공격자의 리듬이 프로필에 섞이면 이후 판정이 무력화된다.)
//   · 가용성 — 타자 없는 세션(자동완성 등)은 타자 특징을 빼고, 비교할 특징이 없으면 판단을 보류한다.
// ─────────────────────────────────────────────────────────────

export const BIOMETRIC_POLICY = {
  MIN_SAMPLES: 5,            // 이보다 적으면 등록(enrollment) 단계 — 판단 보류
  EWMA_ALPHA: 0.3,           // 프로필 갱신 가중(최근 표본 반영 비율)
  MISMATCH_THRESHOLD: 3.0,   // 집계 표준화 거리(RMS)가 이보다 크면 불일치
  MIN_KEYPRESS: 4,           // 타자 특징을 쓰려면 최소 키 입력 수(표본 신뢰도)
  // 분산 하한(표준편차 하한의 제곱) — 콜드스타트·과소분산에서 z 폭주를 막는다.
  FLOOR: { typing: 15 * 15, mouseRate: 0.3 * 0.3, keyRate: 0.3 * 0.3 },
} as const

export interface RawBehavior {
  mouseMoveCount: number
  avgTypingInterval: number
  timeOnPage: number
  keyPressCount: number
}

export interface BiometricFeatures {
  typing: number | null // 평균 타자 간격(ms) — 타자가 충분치 않으면 null
  mouseRate: number      // 마우스 이동 / 체류 초
  keyRate: number        // 키 입력 / 체류 초
}

export interface ProfileStats {
  typing_mean: number | null
  typing_var: number | null
  mouse_rate_mean: number | null
  mouse_rate_var: number | null
  key_rate_mean: number | null
  key_rate_var: number | null
}

/** 원시 행동값 → 세션 길이에 둔감한 특징 벡터. 체류 시간이 없으면 null(판정 불가). */
export function extractFeatures(m: RawBehavior): BiometricFeatures | null {
  const sec = m.timeOnPage / 1000
  if (!Number.isFinite(sec) || sec <= 0) return null
  const typing =
    m.avgTypingInterval > 0 && m.keyPressCount >= BIOMETRIC_POLICY.MIN_KEYPRESS
      ? m.avgTypingInterval
      : null
  return {
    typing,
    mouseRate: m.mouseMoveCount / sec,
    keyRate: m.keyPressCount / sec,
  }
}

/**
 * 프로필 대비 특징의 표준화 거리(RMS). 비교 가능한 특징이 하나도 없으면 used=0.
 * 각 특징은 |x - mean| / max(sd, floor) 로 표준화하고, 특징 간 제곱평균(RMS)으로 묶는다.
 */
export function scoreFeatures(p: ProfileStats, f: BiometricFeatures): { score: number; used: number } {
  const zs: number[] = []
  const add = (x: number | null, mean: number | null, varr: number | null, floor: number): void => {
    if (x == null || mean == null || varr == null) return
    const sd = Math.sqrt(Math.max(varr, floor))
    if (sd <= 0) return
    zs.push(Math.abs(x - mean) / sd)
  }
  add(f.typing, p.typing_mean, p.typing_var, BIOMETRIC_POLICY.FLOOR.typing)
  add(f.mouseRate, p.mouse_rate_mean, p.mouse_rate_var, BIOMETRIC_POLICY.FLOOR.mouseRate)
  add(f.keyRate, p.key_rate_mean, p.key_rate_var, BIOMETRIC_POLICY.FLOOR.keyRate)
  if (zs.length === 0) return { score: 0, used: 0 }
  const rms = Math.sqrt(zs.reduce((a, z) => a + z * z, 0) / zs.length)
  return { score: rms, used: zs.length }
}

/** EWMA 평균·분산 갱신(순수). 첫 표본이면 평균=값, 분산=0 으로 초기화한다. */
export function ewmaUpdate(
  mean: number | null,
  varr: number | null,
  x: number,
  alpha = BIOMETRIC_POLICY.EWMA_ALPHA,
): { mean: number; var: number } {
  if (mean == null || varr == null) return { mean: x, var: 0 }
  const newMean = (1 - alpha) * mean + alpha * x
  // EWMA 분산 — 편차는 '이전' 평균 기준으로 잡는다.
  const newVar = (1 - alpha) * varr + alpha * (x - mean) * (x - mean)
  return { mean: newMean, var: newVar }
}

export type BiometricOutcome = 'skipped' | 'enrolling' | 'match' | 'mismatch'

export interface BiometricResult {
  outcome: BiometricOutcome
  score: number | null
  samples: number
  detail: string
}

/** 현재 프로필 통계에 이번 특징을 EWMA 로 반영한 '다음 통계'를 만든다(순수). */
function applyUpdate(p: ProfileStats, f: BiometricFeatures): ProfileStats {
  const next: ProfileStats = { ...p }
  if (f.typing != null) {
    const u = ewmaUpdate(p.typing_mean, p.typing_var, f.typing)
    next.typing_mean = u.mean
    next.typing_var = u.var
  }
  {
    const u = ewmaUpdate(p.mouse_rate_mean, p.mouse_rate_var, f.mouseRate)
    next.mouse_rate_mean = u.mean
    next.mouse_rate_var = u.var
  }
  {
    const u = ewmaUpdate(p.key_rate_mean, p.key_rate_var, f.keyRate)
    next.key_rate_mean = u.mean
    next.key_rate_var = u.var
  }
  return next
}

/**
 * 로그인 1단계 행동을 프로필에 비교·반영한다.
 *  · skipped   : 비교·갱신할 특징이 없음(예: 체류 0, 타자·마우스 모두 無)
 *  · enrolling : 표본 부족 → 판단 보류, 프로필만 누적
 *  · match     : 프로필과 일치 → 프로필 강화(갱신)
 *  · mismatch  : 유사도 미달 → 신호 발생, 프로필은 갱신하지 않음(오염 방지)
 *
 * DB 오류 등으로 실패하면 'skipped' 로 떨어뜨려 로그인을 막지 않는다(fail-open).
 */
export async function processLoginBehavior(userId: number, raw: RawBehavior): Promise<BiometricResult> {
  const f = extractFeatures(raw)
  if (!f) return { outcome: 'skipped', score: null, samples: 0, detail: '' }

  try {
    const existing = await BehaviorProfile.findByPk(userId)
    const current: ProfileStats = existing
      ? {
          typing_mean: existing.typing_mean, typing_var: existing.typing_var,
          mouse_rate_mean: existing.mouse_rate_mean, mouse_rate_var: existing.mouse_rate_var,
          key_rate_mean: existing.key_rate_mean, key_rate_var: existing.key_rate_var,
        }
      : {
          typing_mean: null, typing_var: null,
          mouse_rate_mean: null, mouse_rate_var: null,
          key_rate_mean: null, key_rate_var: null,
        }
    const sampleCount = existing?.sample_count ?? 0

    const persist = async (stats: ProfileStats, count: number): Promise<void> => {
      await BehaviorProfile.upsert({
        user_id: userId,
        sample_count: count,
        ...stats,
        updated_at: new Date(),
      })
    }

    // 등록(enrollment) — 표본이 충분해질 때까지는 판단하지 않고 누적만 한다.
    if (!existing || sampleCount < BIOMETRIC_POLICY.MIN_SAMPLES) {
      await persist(applyUpdate(current, f), sampleCount + 1)
      return { outcome: 'enrolling', score: null, samples: sampleCount + 1, detail: '' }
    }

    const { score, used } = scoreFeatures(current, f)
    if (used === 0) {
      // 비교 가능한 특징이 없다 — 판단 보류하되 누적은 한다.
      await persist(applyUpdate(current, f), sampleCount + 1)
      return { outcome: 'enrolling', score: null, samples: sampleCount + 1, detail: '' }
    }

    if (score > BIOMETRIC_POLICY.MISMATCH_THRESHOLD) {
      // 불일치 — 프로필을 갱신하지 않는다(공격자 리듬 오염 방지).
      return {
        outcome: 'mismatch',
        score,
        samples: sampleCount,
        detail:
          `행동 생체인식 유사도 미달 — 표준화 거리 ${score.toFixed(2)}` +
          `(임계 ${BIOMETRIC_POLICY.MISMATCH_THRESHOLD}), 비교 특징 ${used}종`,
      }
    }

    // 일치 — 프로필 강화.
    await persist(applyUpdate(current, f), sampleCount + 1)
    return { outcome: 'match', score, samples: sampleCount + 1, detail: '' }
  } catch (err) {
    console.error('[Biometric] 프로필 처리 실패 — fail-open:', err)
    return { outcome: 'skipped', score: null, samples: 0, detail: '' }
  }
}
