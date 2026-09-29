/**
 * [보안 검증] 카나리 바인딩 어서션
 *
 * 카나리 덫은 "ID 33 = 미끼" 를 코드 상수로 가진다. DB 재구축·리시드로 실제 사용자가
 * 33번을 받으면 그 사람의 거래가 전부 차단되고 IP 까지 막힌다. 이를 막기 위해
 * 기동 시 33번 행의 이메일 지문이 예상한 미끼와 같을 때만 덫을 켠다.
 *
 *   1) 판정 함수 — 재구축 상황(행 없음·다른 사람·이메일 변경)을 전부 불일치로 잡는가
 *   2) 판정 함수 — 대소문자·공백 차이 같은 표기 차이로 진짜 미끼를 놓치지 않는가
 *   3) 실DB — 현재 33번 행이 VERIFIED 로 판정되는가 (덫이 실제로 켜져 있는가)
 *
 * 불일치 시 덫을 끄는(fail-open) 분기 자체는 assertNotCanary 가 bindingStates 를 보고
 * return 하는 한 줄이라 여기서 따로 호출하지 않는다 — 호출하면 실제 CANARY_ACCESS 행과
 * 관리자 메일이 생겨 탐지 통계가 오염된다. 덫이 켜진 상태의 차단·기록은 canaryTrap.test.ts 가 본다.
 *
 * 사전 조건: DB 접속 가능 (3번 항목)
 * 실행: cd server && npx ts-node src/test/security/canaryBinding.test.ts
 */
import sequelize from '../../config/database'
import {
  CANARY_USER_IDS,
  evaluateCanaryBinding,
  getCanaryBindingStatus,
  hashCanaryEmail,
  verifyCanaryBindings,
  type CanaryBindingState,
} from '../../services/security/canaryService'

let pass = 0
let fail = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass++
  else {
    fail++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// 실제 미끼 이메일을 테스트 코드에 평문으로 두지 않는다(저장소 public).
// 지문 비교 기전은 임의의 기준 이메일로 똑같이 검증된다.
const REF_EMAIL = 'decoy.reference@example.com'
const binding = { id: 33, emailSha256: hashCanaryEmail(REF_EMAIL) }

interface Scenario {
  name: string
  row: { id: number; email: string } | null
  expect: CanaryBindingState
}

// 덫이 꺼져야 하는 상황 — 여기서 VERIFIED 가 나오면 무고한 사용자가 차단된다.
const UNSAFE: Scenario[] = [
  { name: 'DB 재구축 후 33번 행 없음 (다음 가입자가 33 을 받을 수 있음)', row: null, expect: 'MISSING' },
  { name: '리시드로 실제 사용자가 33번을 받음', row: { id: 33, email: 'real.user@example.com' }, expect: 'MISMATCH' },
  { name: '33번 계정의 이메일이 변경됨', row: { id: 33, email: 'changed.decoy@example.com' }, expect: 'MISMATCH' },
  { name: '빈 이메일', row: { id: 33, email: '' }, expect: 'MISMATCH' },
  { name: '한 글자 차이 (typosquat)', row: { id: 33, email: 'decoy.reference@example.co' }, expect: 'MISMATCH' },
]

// 덫이 켜져야 하는 상황 — 여기서 불일치가 나오면 미끼를 놓친다(탐지 누락).
const SAFE: Scenario[] = [
  { name: '정확히 일치', row: { id: 33, email: REF_EMAIL }, expect: 'VERIFIED' },
  { name: '대문자 표기', row: { id: 33, email: 'Decoy.Reference@Example.COM' }, expect: 'VERIFIED' },
  { name: '앞뒤 공백', row: { id: 33, email: `  ${REF_EMAIL}\t` }, expect: 'VERIFIED' },
]

async function main() {
  console.log('\n[보안 테스트] 카나리 바인딩 어서션')

  console.log('\n── 1) 재구축 상황 → 덫 비활성이어야 함 ──')
  let caught = 0
  for (const s of UNSAFE) {
    const got = evaluateCanaryBinding(binding, s.row)
    const ok = got === s.expect
    if (got !== 'VERIFIED') caught++
    check(`불일치 판정: ${s.name}`, ok, `expected ${s.expect}, got ${got}`)
    console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${got.padEnd(9)} ${s.name}`)
  }

  console.log('\n── 2) 진짜 미끼 → 덫 활성이어야 함 ──')
  let missed = 0
  for (const s of SAFE) {
    const got = evaluateCanaryBinding(binding, s.row)
    const ok = got === s.expect
    if (got !== 'VERIFIED') missed++
    check(`일치 판정: ${s.name}`, ok, `expected ${s.expect}, got ${got}`)
    console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${got.padEnd(9)} ${s.name}`)
  }

  console.log('\n── 3) 실DB 바인딩 ──')
  await verifyCanaryBindings()
  const status = getCanaryBindingStatus()
  for (const s of status) {
    console.log(`  ID ${s.id}: ${s.state}`)
    check(`실DB: ID ${s.id} 덫 활성(VERIFIED)`, s.state === 'VERIFIED', s.state)
  }
  check('실DB: 바인딩 표와 CANARY_USER_IDS 일치', status.length === CANARY_USER_IDS.length)

  const total = UNSAFE.length + SAFE.length
  console.log('\n' + '='.repeat(64))
  console.log('[보안 테스트] 카나리 바인딩 어서션')
  console.log(
    `총 시도: ${UNSAFE.length}회 | 탐지: ${caught}회 | 차단: ${caught}회 | ` +
      `탐지율: ${((caught / UNSAFE.length) * 100).toFixed(0)}%`,
  )
  console.log(`정상(진짜 미끼) ${SAFE.length}건 중 놓침 ${missed}건 | 판정 시나리오 계 ${total}건`)
  console.log(`※ '차단' = 오차단 위험이 있는 ID 의 덫을 비활성화한 건수`)
  console.log('='.repeat(64))

  console.log(`\n검증 항목: ${pass}건 통과 / ${fail}건 실패`)
  if (fail > 0) {
    console.log('\n실패 목록:')
    for (const f of failures) console.log(`  - ${f}`)
  }
  console.log(`판정: ${fail === 0 ? 'PASS' : 'FAIL'}`)
  await sequelize.close()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error('\n실행 실패:', e.message)
  await sequelize.close().catch(() => {})
  process.exit(2)
})
