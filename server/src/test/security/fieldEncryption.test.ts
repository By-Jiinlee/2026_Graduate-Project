import crypto from 'crypto'
import {
  FieldDecryptError,
  decryptField,
  encryptField,
  isLegacyCiphertext,
  upgradeCiphertext,
  type FieldContext,
} from '../../services/auth/fieldCrypto'

// ─────────────────────────────────────────────────────────────
// [보안 검증] 저장 데이터 보호 — 필드 레벨 암호화
//
// 확인하려는 것은 세 가지다.
//   (1) 기밀성이 실제로 확보되는가 — 라운드트립, IV 유일성, 동일 평문의 암호문 분리,
//       키 없이 복호 불가.
//   (2) 무결성이 확보되는가 — 암호문이 1비트라도 바뀌면 복호가 실패해야 한다.
//       기존 구현(AES-256-CBC)이 이 성질을 갖지 못했음을 같은 조건에서 실증한 뒤,
//       전환 후(AES-256-GCM)에는 전건 탐지됨을 보인다.
//   (3) 암호문 재배치가 막히는가 — 유효한 암호문을 다른 컬럼·다른 사용자 행으로
//       옮겨 붙이는 조작은 암호화만으로는 막히지 않는다. AAD 결속으로 차단한다.
//
// DB·서버 없이 암복호 함수를 직접 호출하는 결정적 검증이다.
// 실행: cd server && npx ts-node src/test/security/fieldEncryption.test.ts
// ─────────────────────────────────────────────────────────────

const KEY = crypto.randomBytes(32)
const OTHER_KEY = crypto.randomBytes(32)

const CTX: FieldContext = { table: 'real_accounts', column: 'cano', ownerId: 32 }

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass++
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`) }
}

// 전환 전 구현 재현 — 대조군(레거시 CBC). 논문 비교를 위해 동일 조건으로 둔다.
function legacyEncrypt(text: string, key: Buffer): string {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return iv.toString('hex') + ':' + enc.toString('hex')
}

// ─────────────────────────────────────────────
// 1) 기밀성 — 라운드트립·IV 유일성·암호문 분리
// ─────────────────────────────────────────────
const SAMPLE_COUNT = 200
const samples = [
  '12345678',                                   // 계좌번호
  'PSIETB0yBcjHN228Ztz9OaeJdmqch8fduSs5',       // APP KEY 형식
  'CUcyF0shZNcbR9mgTFtYVtUYoyfsDBREuhbL5J2M+KZ8hutBKnt1zMCNCGCl7qWZ', // APP SECRET 형식
  '한글이 섞인 값 — 특수문자 !@#$%^&*()',
  'a'.repeat(4096),                             // 긴 평문
  '',                                            // 빈 문자열
]

let roundTripOk = 0
for (const s of samples) {
  const enc = encryptField(s, CTX, KEY)
  try {
    if (decryptField(enc, CTX, KEY) === s) roundTripOk++
    else failures.push(`라운드트립 불일치 — 길이 ${s.length}`)
  } catch (err) {
    failures.push(`라운드트립 예외 — 길이 ${s.length}: ${(err as Error).message}`)
  }
}
check('다양한 평문 라운드트립', roundTripOk === samples.length, `${roundTripOk}/${samples.length}`)

const PLAIN = '12345678'
const ciphertexts = Array.from({ length: SAMPLE_COUNT }, () => encryptField(PLAIN, CTX, KEY))
const ivs = ciphertexts.map((c) => c.split(':')[1])
check('IV 전건 유일(재사용 없음)', new Set(ivs).size === SAMPLE_COUNT,
  `${new Set(ivs).size}/${SAMPLE_COUNT}`)
check('동일 평문이 동일 암호문으로 저장되지 않음',
  new Set(ciphertexts).size === SAMPLE_COUNT, `${new Set(ciphertexts).size}/${SAMPLE_COUNT}`)
check('암호문에 평문이 남지 않음',
  ciphertexts.every((c) => !c.includes(PLAIN)))
check('저장 포맷이 버전 태그를 가짐', ciphertexts.every((c) => c.startsWith('v2:')))

let wrongKeyBlocked = 0
for (const c of ciphertexts.slice(0, 50)) {
  try { decryptField(c, CTX, OTHER_KEY); failures.push('다른 키로 복호가 성공함') }
  catch { wrongKeyBlocked++ }
}
check('키 없이 복호 불가', wrongKeyBlocked === 50, `${wrongKeyBlocked}/50`)

// ─────────────────────────────────────────────
// 2) 무결성 — 대조군(CBC) vs 전환 후(GCM)
//
//    공격 모델: DB 쓰기 권한을 얻은 공격자가 암호문을 조작한다. 키는 모른다.
//    CBC 는 IV 의 한 비트를 뒤집으면 첫 블록 평문의 같은 위치 비트가 뒤집힌다.
//    계좌번호처럼 구조가 알려진 짧은 평문에서는 원하는 값으로 바꿀 수 있다.
// ─────────────────────────────────────────────
const TARGET = '12345678'            // 실제 계좌번호(16바이트 블록 하나에 들어간다)
const FORGED = '99999999'            // 공격자가 만들고 싶은 값

const legacy = legacyEncrypt(TARGET, KEY)
const [legacyIvHex, legacyEncHex] = legacy.split(':')
const legacyIv = Buffer.from(legacyIvHex, 'hex')

// IV ⊕ 원문 ⊕ 목표문 → 복호 결과가 목표문이 된다(키 없이)
const forgedIv = Buffer.from(legacyIv)
for (let i = 0; i < TARGET.length; i++) {
  forgedIv[i] = legacyIv[i] ^ TARGET.charCodeAt(i) ^ FORGED.charCodeAt(i)
}
const forgedLegacy = `${forgedIv.toString('hex')}:${legacyEncHex}`

let cbcForgedPlain = ''
let cbcForgeSucceeded = false
try {
  cbcForgedPlain = decryptField(forgedLegacy, CTX, KEY)
  cbcForgeSucceeded = cbcForgedPlain === FORGED
} catch { /* 복호 실패 시 위조 실패 */ }

check('[대조군] CBC 는 변조를 탐지하지 못함(비트 플리핑 성공)', cbcForgeSucceeded,
  `복호 결과 "${cbcForgedPlain}"`)

// 같은 공격을 GCM 암호문에 적용한다
const gcm = encryptField(TARGET, CTX, KEY)
const [, gcmIvHex, gcmTagHex, gcmEncHex] = gcm.split(':')
const gcmIv = Buffer.from(gcmIvHex, 'hex')
const forgedGcmIv = Buffer.from(gcmIv)
forgedGcmIv[0] ^= 0xff
let gcmIvTamperBlocked = false
try { decryptField(`v2:${forgedGcmIv.toString('hex')}:${gcmTagHex}:${gcmEncHex}`, CTX, KEY) }
catch (err) { gcmIvTamperBlocked = err instanceof FieldDecryptError && err.reason === 'AUTH' }
check('GCM — IV 변조 차단', gcmIvTamperBlocked)

// 무작위 1비트 변조 200회 — 전건 탐지되어야 한다
const TAMPER_TRIALS = 200
let tamperDetected = 0
let tamperSilentlyWrong = 0
for (let i = 0; i < TAMPER_TRIALS; i++) {
  const parts = encryptField(TARGET, CTX, KEY).split(':')
  const which = i % 3                        // 0: IV, 1: 태그, 2: 암호문 본문
  const idx = which === 0 ? 1 : which === 1 ? 2 : 3
  const buf = Buffer.from(parts[idx], 'hex')
  const bytePos = crypto.randomInt(buf.length)
  buf[bytePos] ^= 1 << crypto.randomInt(8)
  parts[idx] = buf.toString('hex')
  try {
    const out = decryptField(parts.join(':'), CTX, KEY)
    if (out !== TARGET) tamperSilentlyWrong++
    failures.push(`변조 미탐 — 위치 ${['IV', 'TAG', 'CT'][which]}`)
  } catch { tamperDetected++ }
}
check('GCM — 1비트 변조 전건 탐지', tamperDetected === TAMPER_TRIALS,
  `${tamperDetected}/${TAMPER_TRIALS}`)
check('GCM — 변조된 평문을 반환하는 경우 없음', tamperSilentlyWrong === 0)

// 절단(truncation) 공격 — 암호문 뒷부분을 잘라낸다
let truncationBlocked = 0
for (let i = 1; i <= 5; i++) {
  const parts = encryptField(TARGET, CTX, KEY).split(':')
  parts[3] = parts[3].slice(0, Math.max(0, parts[3].length - i * 2))
  try { decryptField(parts.join(':'), CTX, KEY) } catch { truncationBlocked++ }
}
check('GCM — 암호문 절단 차단', truncationBlocked === 5, `${truncationBlocked}/5`)

// ─────────────────────────────────────────────
// 3) 암호문 재배치(swap) — AAD 결속
// ─────────────────────────────────────────────
const userA: FieldContext = { table: 'real_accounts', column: 'cano', ownerId: 32 }
const userB: FieldContext = { table: 'real_accounts', column: 'cano', ownerId: 99 }
const colSecret: FieldContext = { table: 'real_accounts', column: 'app_secret', ownerId: 32 }

const encA = encryptField('12345678', userA, KEY)

let crossUserBlocked = false
try { decryptField(encA, userB, KEY) }
catch (err) { crossUserBlocked = err instanceof FieldDecryptError && err.reason === 'AUTH' }
check('타 사용자 행으로 암호문 이동 차단', crossUserBlocked)

let crossColumnBlocked = false
try { decryptField(encA, colSecret, KEY) }
catch (err) { crossColumnBlocked = err instanceof FieldDecryptError && err.reason === 'AUTH' }
check('타 컬럼으로 암호문 이동 차단', crossColumnBlocked)

check('정상 문맥에서는 그대로 복호', decryptField(encA, userA, KEY) === '12345678')

// 대조군: CBC 는 문맥 결속이 없어 재배치가 그대로 성공한다
const legacyA = legacyEncrypt('12345678', KEY)
let legacySwapSucceeded = false
try { legacySwapSucceeded = decryptField(legacyA, userB, KEY) === '12345678' } catch { /* noop */ }
check('[대조군] CBC 는 재배치를 막지 못함', legacySwapSucceeded)

// ─────────────────────────────────────────────
// 4) 마이그레이션 안전성 — 하위호환 및 승격
// ─────────────────────────────────────────────
check('레거시 포맷 판별', isLegacyCiphertext(legacyA) && !isLegacyCiphertext(encA))
check('레거시 암호문 복호 호환', decryptField(legacyA, userA, KEY) === '12345678')

const upgraded = upgradeCiphertext(legacyA, userA, KEY)
check('승격 후 v2 포맷', upgraded.startsWith('v2:'))
check('승격 후 평문 보존', decryptField(upgraded, userA, KEY) === '12345678')
let upgradedTamperBlocked = false
{
  const parts = upgraded.split(':')
  const buf = Buffer.from(parts[3], 'hex')
  buf[0] ^= 0x01
  parts[3] = buf.toString('hex')
  try { decryptField(parts.join(':'), userA, KEY) } catch { upgradedTamperBlocked = true }
}
check('승격된 암호문도 변조 탐지', upgradedTamperBlocked)

let brokenUpgradeBlocked = false
try { upgradeCiphertext(legacyA, userA, OTHER_KEY) } catch { brokenUpgradeBlocked = true }
check('복호 불가 시 승격 중단(잘못된 값 덮어쓰기 방지)', brokenUpgradeBlocked)

// ─────────────────────────────────────────────
// 5) 처리 비용 — 전환에 따른 오버헤드
// ─────────────────────────────────────────────
const PERF_N = 2000
const t0 = process.hrtime.bigint()
for (let i = 0; i < PERF_N; i++) decryptField(encryptField(TARGET, CTX, KEY), CTX, KEY)
const gcmUs = Number(process.hrtime.bigint() - t0) / 1000 / PERF_N

const t1 = process.hrtime.bigint()
for (let i = 0; i < PERF_N; i++) {
  const c = legacyEncrypt(TARGET, KEY)
  const [ivHex, encHex] = c.split(':')
  const d = crypto.createDecipheriv('aes-256-cbc', KEY, Buffer.from(ivHex, 'hex'))
  Buffer.concat([d.update(Buffer.from(encHex, 'hex')), d.final()]).toString('utf8')
}
const cbcUs = Number(process.hrtime.bigint() - t1) / 1000 / PERF_N

check('암복호 1회 비용이 실용 범위(0.1ms 미만)', gcmUs < 100, `${gcmUs.toFixed(1)}µs`)

// ─────────────────────────────────────────────
// 결과 출력
// ─────────────────────────────────────────────
const attackAttempts = TAMPER_TRIALS + 5 + 1 + 2 + 50   // 변조 + 절단 + IV변조 + 재배치 + 키공격
const attackBlocked = tamperDetected + truncationBlocked +
  (gcmIvTamperBlocked ? 1 : 0) + (crossUserBlocked ? 1 : 0) + (crossColumnBlocked ? 1 : 0) +
  wrongKeyBlocked

console.log('')
console.log('[보안 테스트] 저장 데이터 보호 — 필드 레벨 암호화(AES-256-GCM 전환)')
console.log(`총 시도: ${attackAttempts}회 | 탐지: ${attackBlocked}회 | 차단: ${attackBlocked}회 | 탐지율: ${((attackBlocked / attackAttempts) * 100).toFixed(0)}%`)
console.log(`- 암호문 변조(1비트)  : ${tamperDetected}/${TAMPER_TRIALS} 차단 (IV·태그·본문 균등 분포)`)
console.log(`- 암호문 절단        : ${truncationBlocked}/5 차단`)
console.log(`- 암호문 재배치      : 타 사용자 ${crossUserBlocked ? '차단' : '미차단'} · 타 컬럼 ${crossColumnBlocked ? '차단' : '미차단'}`)
console.log(`- 키 미보유 복호     : ${wrongKeyBlocked}/50 차단`)
console.log(`- IV 유일성          : ${new Set(ivs).size}/${SAMPLE_COUNT} (재사용 0건)`)
console.log(`- [대조군] CBC 비트플리핑 : "${TARGET}" → "${cbcForgedPlain}" 위조 ${cbcForgeSucceeded ? '성공' : '실패'} (무결성 검증 부재)`)
console.log(`- [대조군] CBC 재배치     : ${legacySwapSucceeded ? '성공(차단 불가)' : '실패'}`)
console.log(`- 레거시 호환·승격   : 복호 호환 O · 승격 후 변조 탐지 O · 복호 실패 시 승격 중단 O`)
console.log(`- 처리 비용          : GCM ${gcmUs.toFixed(1)}µs/회 vs CBC ${cbcUs.toFixed(1)}µs/회 (${PERF_N}회 평균)`)

if (failures.length > 0) {
  console.log('\n[실패 항목]')
  for (const f of failures.slice(0, 20)) console.log(`  · ${f}`)
  if (failures.length > 20) console.log(`  · ... 외 ${failures.length - 20}건`)
}

console.log(`\n검증 항목: ${pass}건 통과 / ${fail}건 실패`)
console.log(`판정: ${fail === 0 ? 'PASS' : 'FAIL'}`)
process.exit(fail === 0 ? 0 : 1)
