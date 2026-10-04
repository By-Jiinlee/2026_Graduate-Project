import {
  BIOMETRIC_POLICY,
  extractFeatures,
  scoreFeatures,
  ewmaUpdate,
  type ProfileStats,
  type BiometricFeatures,
  type RawBehavior,
} from '../../services/auth/behaviorProfileService'
import { assessRisk, decideAuthRequirement, isObservationalRisk } from '../../services/auth/riskEngine'

// ─────────────────────────────────────────────────────────────
// [보안 검증] 행동 생체인식 (키스트로크·마우스 프로필)
//
// DB 없이 순수 함수로 (1) 특징 추출 (2) EWMA 누적·수렴 (3) 유사도(표준화 거리) 판정을 검증한다.
// 같은 사람의 반복 로그인으로 수렴한 프로필에 대해, 같은 리듬은 '일치', 다른 리듬(세션 탈취)은
// 임계를 넘겨 '불일치'가 나와야 한다. 또 불일치 신호가 기본(관측)에서는 단독으로 재인증을
// 유발하지 않음(cap)을 함께 확인한다.
//
// 실행: cd server && npx ts-node src/test/security/behaviorBiometric.test.ts
// ─────────────────────────────────────────────────────────────

let pass = 0
let fail = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass++
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`) }
}

let seed = 20261001
const rand = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
// 평균 mean, 표준편차 sd 의 근사 정규 난수(중심극한)
const gauss = (mean: number, sd: number): number => {
  let s = 0
  for (let i = 0; i < 6; i++) s += rand()
  return mean + (s - 3) * sd
}

const P = BIOMETRIC_POLICY

console.log('\n[보안 테스트] 행동 생체인식 (키스트로크·마우스 프로필)')

// ── 1) 특징 추출 ────────────────────────────────────────────────
const f1 = extractFeatures({ mouseMoveCount: 40, avgTypingInterval: 180, timeOnPage: 4000, keyPressCount: 20 })
check('정상 세션: 특징 3종 추출', f1 != null && f1.typing === 180 && f1.mouseRate === 10 && f1.keyRate === 5,
  JSON.stringify(f1))
const f2 = extractFeatures({ mouseMoveCount: 5, avgTypingInterval: 0, timeOnPage: 1200, keyPressCount: 0 })
check('자동완성(타자 없음): typing null', f2 != null && f2.typing === null, JSON.stringify(f2))
const f3 = extractFeatures({ mouseMoveCount: 5, avgTypingInterval: 30, timeOnPage: 1200, keyPressCount: 2 })
check('키 입력 부족: typing null(표본 신뢰도)', f3 != null && f3.typing === null, JSON.stringify(f3))
const f4 = extractFeatures({ mouseMoveCount: 5, avgTypingInterval: 30, timeOnPage: 0, keyPressCount: 10 })
check('체류 0: 특징 없음(null)', f4 === null)

// ── 2) EWMA 수렴 ────────────────────────────────────────────────
let m: number | null = null
let v: number | null = null
for (let i = 0; i < 50; i++) { const u = ewmaUpdate(m, v, gauss(200, 20)); m = u.mean; v = u.var }
check('EWMA 평균이 참값 부근 수렴(200±15)', m != null && Math.abs(m - 200) < 15, String(m))
check('EWMA 분산이 양수로 안정', v != null && v > 0, String(v))

// ── 3) 프로필 구성 → 같은 사람 vs 다른 사람 ─────────────────────
// 사용자 A 프로필을 반복 표본으로 수렴시킨다(타자 느긋·마우스 활발).
function buildProfile(gen: () => RawBehavior, n: number): ProfileStats {
  let p: ProfileStats = {
    typing_mean: null, typing_var: null,
    mouse_rate_mean: null, mouse_rate_var: null,
    key_rate_mean: null, key_rate_var: null,
  }
  for (let i = 0; i < n; i++) {
    const f = extractFeatures(gen())!
    const t = ewmaUpdate(p.typing_mean, p.typing_var, f.typing!)
    const mr = ewmaUpdate(p.mouse_rate_mean, p.mouse_rate_var, f.mouseRate)
    const kr = ewmaUpdate(p.key_rate_mean, p.key_rate_var, f.keyRate)
    p = {
      typing_mean: t.mean, typing_var: t.var,
      mouse_rate_mean: mr.mean, mouse_rate_var: mr.var,
      key_rate_mean: kr.mean, key_rate_var: kr.var,
    }
  }
  return p
}

// A: 타자 간격 210ms, 마우스 많이, 키 보통
const userA = (): RawBehavior => ({
  mouseMoveCount: Math.round(gauss(45, 6)),
  avgTypingInterval: Math.round(gauss(210, 18)),
  timeOnPage: 4000,
  keyPressCount: Math.round(gauss(22, 3)),
})
const profileA = buildProfile(userA, 30)

// 같은 사람의 새 세션 20회 — 오탐률 측정
let aTried = 0, aFalse = 0
for (let i = 0; i < 20; i++) {
  const f = extractFeatures(userA())!
  const { score } = scoreFeatures(profileA, f)
  aTried++
  if (score > P.MISMATCH_THRESHOLD) aFalse++
}
check('같은 사람 오탐률 10% 미만', aFalse / aTried < 0.1, `${((aFalse / aTried) * 100).toFixed(0)}%`)

// 다른 사람(세션 탈취): 타자 훨씬 빠르고 마우스 거의 안 씀
const attacker = (): RawBehavior => ({
  mouseMoveCount: Math.round(gauss(3, 1)),
  avgTypingInterval: Math.round(gauss(70, 10)),
  timeOnPage: 3000,
  keyPressCount: Math.round(gauss(24, 3)),
})
let hTried = 0, hDetected = 0
for (let i = 0; i < 20; i++) {
  const f = extractFeatures(attacker())!
  const { score, used } = scoreFeatures(profileA, f)
  hTried++
  if (used >= 1 && score > P.MISMATCH_THRESHOLD) hDetected++
}
check('세션 탈취 탐지율 80% 이상', hDetected / hTried >= 0.8, `${((hDetected / hTried) * 100).toFixed(0)}%`)

// ── 4) 비교 가능한 특징이 없으면 used=0 ─────────────────────────
const empty: ProfileStats = {
  typing_mean: null, typing_var: null,
  mouse_rate_mean: null, mouse_rate_var: null,
  key_rate_mean: null, key_rate_var: null,
}
const noCompare = scoreFeatures(empty, { typing: 100, mouseRate: 1, keyRate: 1 } as BiometricFeatures)
check('프로필 비어있으면 used=0(판단 보류)', noCompare.used === 0)

// ── 5) 리스크 엔진 연동 — 기본 관측(cap) ────────────────────────
check('BEHAVIOR_BIOMETRIC_MISMATCH 기본 관측 분류', isObservationalRisk('BEHAVIOR_BIOMETRIC_MISMATCH'),
  '기본값(BIOMETRIC_ENFORCE 미설정)에서 관측이어야 한다')
const bioOnly = assessRisk(['BEHAVIOR_BIOMETRIC_MISMATCH'])
check('불일치 단독: 20점 이하(상한)', bioOnly.score <= 20, String(bioOnly.score))
check('불일치 단독: 재인증 없음(관측)',
  decideAuthRequirement({ isTrustedDevice: true, risk: bioOnly }).requirement === 'NONE')
// 차단 신호와 결합하면 등급을 밀어 올린다
const combined = assessRisk(['ABNORMAL_COUNTRY', 'BEHAVIOR_BIOMETRIC_MISMATCH'])
check('차단 신호와 결합: WALLET 승격', combined.requirement === 'WALLET', `${combined.score}`)

console.log(`\n  같은 사람 오탐률 : ${((aFalse / aTried) * 100).toFixed(0)}% (${aFalse}/${aTried})`)
console.log(`  세션 탈취 탐지율 : ${((hDetected / hTried) * 100).toFixed(0)}% (${hDetected}/${hTried})`)
console.log(`  정책 임계(RMS)   : ${P.MISMATCH_THRESHOLD} · 등록 최소 표본 ${P.MIN_SAMPLES}`)

console.log(`\n검증 항목: ${pass}건 통과 / ${fail}건 실패`)
if (fail > 0) { console.log('\n실패 목록:'); for (const f of failures) console.log(`  · ${f}`) }
console.log(`판정: ${fail === 0 ? 'PASS' : 'FAIL'}`)
process.exit(fail === 0 ? 0 : 1)
