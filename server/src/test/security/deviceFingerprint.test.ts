import {
  assessRisk,
  decideAuthRequirement,
  isObservationalRisk,
  DEVICE_FP_ENFORCE,
} from '../../services/auth/riskEngine'

// ─────────────────────────────────────────────────────────────
// [보안 검증] 강화된 디바이스 핑거프린팅 — 위험 엔진 연동
//
// DB 없이 위험 점수 연동만 검증한다(verifyTrustedDevice/registerTrustedDevice 의 컬럼 저장·비교와
// "불일치 시 신뢰 미파기"는 DB가 필요하므로 라이브 검증 절차로 둔다 — 계획서 Verification 참조).
//
// 핵심 불변식:
//   · DEVICE_FINGERPRINT_MISMATCH 는 기본(DEVICE_FP_ENFORCE 미설정) 관측 신호 → 단독 재인증 없음(CAP).
//   · 차단 신호와 결합하면 등급을 밀어 올린다.
//
// 실행: cd server && npx ts-node src/test/security/deviceFingerprint.test.ts
// ─────────────────────────────────────────────────────────────

let pass = 0
let fail = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass++
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`) }
}

console.log('\n[보안 테스트] 강화된 디바이스 핑거프린팅 — 위험 엔진 연동')
console.log(`\n현재 모드: ${DEVICE_FP_ENFORCE ? '강제(gating)' : '관측(기본)'}`)

if (!DEVICE_FP_ENFORCE) {
  // 기본(관측) 모드 — 단독으로는 재인증을 유발하지 않는다.
  check('기본 관측 분류', isObservationalRisk('DEVICE_FINGERPRINT_MISMATCH'))
  const only = assessRisk(['DEVICE_FINGERPRINT_MISMATCH'])
  check('단독: 20점 이하(상한)', only.score <= 20, String(only.score))
  check('단독: 재인증 없음(NONE)',
    decideAuthRequirement({ isTrustedDevice: true, risk: only }).requirement === 'NONE')

  // 차단 신호와 결합하면 승격한다.
  const combined = assessRisk(['ABNORMAL_COUNTRY', 'DEVICE_FINGERPRINT_MISMATCH'])
  check('차단 신호와 결합: WALLET 승격', combined.requirement === 'WALLET', String(combined.score))
} else {
  // 강제 모드 — gating 이므로 단독으로 재인증을 유발한다.
  check('강제 모드: 관측 분류 아님', !isObservationalRisk('DEVICE_FINGERPRINT_MISMATCH'))
  const only = assessRisk(['DEVICE_FINGERPRINT_MISMATCH'])
  check('강제 모드: 단독으로 WALLET', only.requirement === 'WALLET', String(only.score))
}

// 두 신규 관측 신호(생체인식·디바이스)만으로도 상한을 넘지 않는다.
const bothObservational = assessRisk(['BEHAVIOR_BIOMETRIC_MISMATCH', 'DEVICE_FINGERPRINT_MISMATCH'])
if (!DEVICE_FP_ENFORCE && !(process.env.BIOMETRIC_ENFORCE === 'true')) {
  check('생체인식+디바이스 관측 합계: 20점 상한', bothObservational.score <= 20, String(bothObservational.score))
}

console.log(`\n검증 항목: ${pass}건 통과 / ${fail}건 실패`)
if (fail > 0) { console.log('\n실패 목록:'); for (const f of failures) console.log(`  · ${f}`) }
console.log(`판정: ${fail === 0 ? 'PASS' : 'FAIL'}`)
process.exit(fail === 0 ? 0 : 1)
