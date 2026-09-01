// ─────────────────────────────────────────────────────────────
// 통계 기반 이상탐지 공용 엔진
//
// 사용자별 과거 표본에서 강건 통계량을 뽑아, 현재 관측값이 그 사용자의
// 평소 습관에서 얼마나 벗어났는지를 점수(z)로 환산한다.
// 거래금액(M-1)·거래빈도(M-6)처럼 척도가 다른 신호가 같은 엔진을 재사용한다.
//
// 설계 근거
//  1) 평균·표준편차 대신 중앙값·MAD
//     평균/표준편차는 붕괴점(breakdown point)이 0이라 이상치 1건에 무너진다.
//     침해 계정이 만든 고액 거래가 그대로 베이스라인에 섞이면 다음 공격이
//     "정상"으로 판정된다(베이스라인 오염 공격). 중앙값/MAD 는 붕괴점이 50%라
//     표본의 절반을 넘게 오염시키지 않는 한 기준선이 밀리지 않는다.
//  2) 로그 척도
//     거래금액 분포는 우편향(long tail)이라 원척도에서는 정상 사용자도 큰 z를
//     받는다. log(1+x) 로 옮겨 "몇 배 벗어났는가"의 관점으로 바꾼다.
//  3) 산포 하한(SCALE_FLOOR)
//     표본이 거의 같은 값이면 산포가 0이 되어 1% 차이도 z=∞ 가 된다.
//     하한을 둬 "최소 1.5배 변동을 1σ로 본다"로 고정한다. 과민 반응(오탐) 차단.
//  4) 임계값 3.5
//     수정 z-점수(modified z-score) 3.5 초과를 이상치로 보는 관례를 따른다.
//     (Iglewicz & Hoaglin 1993, NIST/SEMATECH e-Handbook 1.3.5.17)
//  5) 산포 대체 추정치도 강건해야 한다
//     MAD 가 0(표본 과반이 동일 값)인 경우에만 2차 추정치를 쓴다. 이때 평균절대편차는
//     붕괴점이 0이라 오염 표본 1건에 부풀어 z 를 눌러버린다 — 실제로 베이스라인
//     오염 공격을 통과시켰다. 그래서 2차 추정치도 편차의 75% 분위수(붕괴점 25%)로 둔다.
//     정규분포에서 Q75(|x−med|) = 1.1503σ 이므로 같은 척도로 환산된다.
// ─────────────────────────────────────────────────────────────

// 정규분포에서 MAD × 1/0.6745 ≈ σ  (0.6745 = Φ⁻¹(0.75))
const MAD_TO_SIGMA = 1 / 0.6745
// 정규분포에서 편차 75% 분위수 × 1/1.1503 ≈ σ  (1.1503 = Φ⁻¹(0.875))
const DEV_Q75_TO_SIGMA = 1 / 1.1503
// 2차 추정치가 쓰이는 편차 분위수
const DEV_QUANTILE = 0.75
// 로그 척도 산포 하한 — ln(1.5). 표본이 균일해도 1.5배 변동을 1σ로 간주한다.
export const SCALE_FLOOR = Math.log(1.5)

export type ScaleSource = 'MAD' | 'DEV_Q75' | 'FLOOR'

export interface Baseline {
  n: number
  mean: number          // 원척도 평균 (보고·표시용)
  std: number           // 원척도 표본표준편차 (보고·표시용)
  median: number        // 원척도 중앙값
  mad: number           // 원척도 MAD (보고·표시용)
  min: number
  max: number
  logMedian: number     // log(1+x) 중앙값 — 판정 기준점
  logScale: number      // log 척도 σ 추정치(하한 적용 후) — 판정 분모
  scaleSource: ScaleSource
}

export const EMPTY_BASELINE: Baseline = {
  n: 0, mean: 0, std: 0, median: 0, mad: 0, min: 0, max: 0,
  logMedian: 0, logScale: SCALE_FLOOR, scaleSource: 'FLOOR',
}

/** 유한한 값만 남긴다 — DECIMAL 문자열·NaN·Infinity 가 섞여 들어와도 통계를 오염시키지 않는다. */
export function sanitizeSamples(values: readonly unknown[]): number[] {
  const out: number[] = []
  for (const v of values) {
    const n = typeof v === 'number' ? v : Number(v)
    if (Number.isFinite(n)) out.push(n)
  }
  return out
}

/** 중앙값 — 입력을 변경하지 않는다. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** 분위수 — 선형 보간 없이 인접 순위값을 쓴다(표본이 작아 보간 이득이 없다). */
export function quantile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))
  return s[idx]
}

/** 중앙절대편차 */
export function mad(values: readonly number[], center: number): number {
  if (values.length === 0) return 0
  return median(values.map((v) => Math.abs(v - center)))
}

/** 편차의 p 분위수 — MAD 가 0일 때 쓰는 2차 산포 추정치(붕괴점 1−p) */
function deviationQuantile(values: readonly number[], center: number, p: number): number {
  if (values.length === 0) return 0
  return quantile(values.map((v) => Math.abs(v - center)), p)
}

const toLog = (x: number): number => Math.log1p(Math.max(0, x))

/**
 * 표본 → 베이스라인.
 * 비유한 값은 무시한다. 표본이 비면 EMPTY_BASELINE 을 돌려주며, 판정 가능 여부
 * (최소 표본 수 충족)는 호출자가 n 으로 판단한다.
 */
export function summarize(rawSamples: readonly unknown[]): Baseline {
  const samples = sanitizeSamples(rawSamples)
  if (samples.length === 0) return { ...EMPTY_BASELINE }

  const n = samples.length
  const mean = samples.reduce((a, b) => a + b, 0) / n
  const variance = n > 1
    ? samples.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n - 1)
    : 0
  const med = median(samples)

  const logs = samples.map(toLog)
  const logMed = median(logs)

  // 1차: MAD → (MAD 가 0일 때만) 2차: 편차 75% 분위수 → 3차: 하한
  //
  // 2차 추정치는 MAD 가 0(과반이 같은 값이라 산포를 잴 수 없음)일 때만 개입한다.
  // MAD 가 0보다 크면 그 값이 이미 가장 강건한 추정치이므로 다른 추정치로 갈아타지
  // 않는다 — 오염 표본이 산포를 부풀려 z 를 낮추는 경로를 차단하기 위함이다.
  const rawMad = mad(logs, logMed)
  let logScale = rawMad * MAD_TO_SIGMA
  let scaleSource: ScaleSource = 'MAD'
  if (rawMad === 0) {
    const alt = deviationQuantile(logs, logMed, DEV_QUANTILE) * DEV_Q75_TO_SIGMA
    if (alt > logScale) { logScale = alt; scaleSource = 'DEV_Q75' }
  }
  if (logScale < SCALE_FLOOR) { logScale = SCALE_FLOOR; scaleSource = 'FLOOR' }

  return {
    n,
    mean,
    std: Math.sqrt(variance),
    median: med,
    mad: mad(samples, med),
    min: Math.min(...samples),
    max: Math.max(...samples),
    logMedian: logMed,
    logScale,
    scaleSource,
  }
}

/**
 * 강건 z-점수 — 로그 척도에서 (관측값 − 중앙값) / σ추정치.
 * 양수만 의미가 있으므로(평소보다 "큰" 값이 위험) 음수 이탈도 그대로 돌려주되
 * 판정은 호출자가 상한 임계로만 수행한다.
 * 표본이 없으면(n=0) 판정 불가 상태를 뜻하는 0 을 돌려준다.
 */
export function robustScore(x: number, b: Baseline): number {
  if (b.n === 0 || !Number.isFinite(x)) return 0
  return (toLog(x) - b.logMedian) / b.logScale
}

/** z 점수를 "평소의 몇 배"로 환산 — 사용자·관리자에게 보여줄 설명용 */
export function scoreToMultiple(z: number, b: Baseline): number {
  return Math.exp(z * b.logScale)
}

/**
 * 베이스라인 점진 상승(누적 상승) 비율 — "얼마나 커졌나"(크기).
 * 시간 오름차순 표본을 절반으로 갈라 (최근 절반 중앙값 / 이전 절반 중앙값) 을 낸다.
 * 공격자가 금액을 조금씩 키워 중앙값을 끌어올리는 회피(frog-boiling)를 잡는 신호다.
 * 표본 부족·이전 절반 중앙값 0 이면 판정 불가(null).
 *
 * 임계값 설정 주의: 등차(선형) 상승 a→b 의 경우 이 비율의 상한은
 *   (0.25a + 0.75b) / (0.75a + 0.25b) → 3 (b→∞)
 * 이라 3 이상으로 잡으면 선형 상승 공격은 영원히 걸리지 않는다.
 * 그래서 임계는 3 미만으로 두되, 오탐은 아래 monotonicTrend 로 억제한다.
 */
export function trendRatio(orderedSamples: readonly number[], minSamples = 8): number | null {
  const s = sanitizeSamples(orderedSamples)
  if (s.length < minSamples) return null

  const half = Math.floor(s.length / 2)
  const older = s.slice(0, half)
  const recent = s.slice(s.length - half)

  const olderMed = median(older)
  const recentMed = median(recent)
  if (olderMed <= 0) return null

  return recentMed / olderMed
}

/**
 * 단조 상승 추세 검정(Mann-Kendall) — "일관되게 커지는가"(방향).
 *
 * S = Σ_{i<j} sgn(x_j − x_i) 를 표준화한 z 를 돌려준다. 분포 가정이 없고
 * 순위만 쓰므로 금액처럼 우편향된 표본에 그대로 쓸 수 있다(Mann 1945, Kendall 1975;
 * 동점 보정은 WMO/USGS 관례를 따른다).
 *
 * 왜 필요한가: trendRatio 만으로 임계를 낮추면 "가끔 크게 지르는" 정상 사용자가
 * 걸린다(중앙값 비율은 우연히 튈 수 있다). 상승이 표본 전체에 걸쳐 **일관**될 때만
 * 회피 시도로 보기 위해 크기(비율)와 방향(단조성)을 함께 요구한다.
 *
 * z ≥ 1.645 → 단측 p<0.05, z ≥ 2.33 → 단측 p<0.01.
 * 표본 부족·분산 0(전부 동일 값)이면 판정 불가(null).
 */
export function monotonicTrend(
  orderedSamples: readonly number[],
  minSamples = 8,
): { s: number; z: number; n: number } | null {
  const x = sanitizeSamples(orderedSamples)
  const n = x.length
  if (n < minSamples) return null

  let s = 0
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      s += Math.sign(x[j] - x[i])
    }
  }

  // 동점 보정: 같은 값 묶음 t 개마다 분산에서 t(t−1)(2t+5) 를 뺀다.
  const counts = new Map<number, number>()
  for (const v of x) counts.set(v, (counts.get(v) ?? 0) + 1)
  let tieCorrection = 0
  for (const t of counts.values()) {
    if (t > 1) tieCorrection += t * (t - 1) * (2 * t + 5)
  }

  const variance = (n * (n - 1) * (2 * n + 5) - tieCorrection) / 18
  if (variance <= 0) return null

  // 연속성 보정 — S 는 이산량이라 0 쪽으로 1 만큼 당겨 표준화한다.
  const z = s > 0 ? (s - 1) / Math.sqrt(variance)
    : s < 0 ? (s + 1) / Math.sqrt(variance)
    : 0

  return { s, z, n }
}
