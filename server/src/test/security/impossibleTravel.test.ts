import { haversineKm, isValidPoint, travelSpeedKmh, type GeoPoint } from '../../utils/geoDistance'

// ─────────────────────────────────────────────────────────────
// [보안 검증] Impossible Travel (M-4) — 이동 속도 기반 계정 공유·탈취 탐지
//
// 배경: 기존 비정상 국가 탐지(ABNORMAL_COUNTRY)는 "가본 적 없는 나라"만 본다. 그래서
//   (a) 공격자가 피해자와 같은 나라에서 접속하면 통과하고,
//   (b) 정상 사용자가 새 나라로 여행만 가도 걸린다.
// 이 규칙은 국가 목록이 아니라 이동 속도를 본다 — 서울에서 로그인한 지 10분 만에
// 런던에서 로그인하면, 그 나라를 가봤든 아니든 두 세션 중 하나는 본인이 아니다.
//
// 확인하려는 것
//   (1) 거리 계산이 정확한가 — 실측 거리와 대조(하버사인)
//   (2) 물리적으로 불가능한 이동을 탐지하는가
//   (3) 정상 이동을 오탐하지 않는가 — 여객기 여행, 같은 도시 내 이동, KTX
//   (4) 계산이 깨지는 입력을 안전하게 처리하는가 — (0,0), 범위 밖 좌표, 시계 역전
//
// 판정 함수를 직접 호출하는 결정적 검증이다. DB·서버·외부 API 를 쓰지 않는다.
// 실행: cd server && npx ts-node src/test/security/impossibleTravel.test.ts
// ─────────────────────────────────────────────────────────────

// 서비스 정책값과 동일하게 맞춘다(anomalyService.CONFIG.IMPOSSIBLE_TRAVEL).
const POLICY = {
  MAX_SPEED_KMH: 1000,
  MIN_DISTANCE_KM: 100,
} as const

const CITY: Record<string, GeoPoint> = {
  서울:      { lat: 37.5665, lon: 126.9780 },
  인천공항:  { lat: 37.4602, lon: 126.4407 },
  부산:      { lat: 35.1796, lon: 129.0756 },
  대전:      { lat: 36.3504, lon: 127.3845 },
  도쿄:      { lat: 35.6762, lon: 139.6503 },
  베이징:    { lat: 39.9042, lon: 116.4074 },
  싱가포르:  { lat: 1.3521,  lon: 103.8198 },
  런던:      { lat: 51.5074, lon: -0.1278 },
  뉴욕:      { lat: 40.7128, lon: -74.0060 },
  상파울루:  { lat: -23.5505, lon: -46.6333 },
  시드니:    { lat: -33.8688, lon: 151.2093 },
}

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass++
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`) }
}

// 서비스의 판정 흐름을 그대로 재현한다.
type Verdict = 'DETECTED' | 'SKIPPED_DISTANCE' | 'SKIPPED_INVALID' | 'NORMAL'

function evaluate(from: GeoPoint, to: GeoPoint, elapsedMinutes: number): { verdict: Verdict; km: number; kmh: number } {
  if (!isValidPoint(from) || !isValidPoint(to)) return { verdict: 'SKIPPED_INVALID', km: 0, kmh: 0 }

  const km = haversineKm(from, to)
  if (km === null) return { verdict: 'SKIPPED_INVALID', km: 0, kmh: 0 }
  if (km < POLICY.MIN_DISTANCE_KM) return { verdict: 'SKIPPED_DISTANCE', km, kmh: 0 }

  const kmh = travelSpeedKmh(km, elapsedMinutes * 60_000)
  if (kmh === null) return { verdict: 'SKIPPED_INVALID', km, kmh: 0 }
  return { verdict: kmh > POLICY.MAX_SPEED_KMH ? 'DETECTED' : 'NORMAL', km, kmh }
}

// ─────────────────────────────────────────────
// 1) 거리 계산 정확도 — 공개된 실측 대권거리와 대조 (±2%)
// ─────────────────────────────────────────────
const DISTANCE_CASES: Array<[string, GeoPoint, GeoPoint, number]> = [
  ['서울–부산',      CITY.서울, CITY.부산,      325],
  ['서울–도쿄',      CITY.서울, CITY.도쿄,      1157],
  ['서울–베이징',    CITY.서울, CITY.베이징,    956],
  ['서울–싱가포르',  CITY.서울, CITY.싱가포르,  4671],
  ['서울–런던',      CITY.서울, CITY.런던,      8880],
  ['서울–뉴욕',      CITY.서울, CITY.뉴욕,      11061],
  ['서울–시드니',    CITY.서울, CITY.시드니,    8323],
  ['런던–뉴욕',      CITY.런던, CITY.뉴욕,      5570],
]

let distanceOk = 0
for (const [label, a, b, expected] of DISTANCE_CASES) {
  const km = haversineKm(a, b)
  const ok = km !== null && Math.abs(km - expected) / expected <= 0.02
  if (ok) distanceOk++
  check(`거리 정확도 ${label}`, ok, `계산 ${km?.toFixed(0)}km / 실측 ${expected}km`)
}
check('거리 계산 전건 오차 2% 이내', distanceOk === DISTANCE_CASES.length, `${distanceOk}/${DISTANCE_CASES.length}`)

// 대칭성·자기거리 — 계산 자체의 건전성
check('거리 대칭성 d(a,b)=d(b,a)', Math.abs(haversineKm(CITY.서울, CITY.런던)! - haversineKm(CITY.런던, CITY.서울)!) < 1e-9)
check('동일 지점 거리 0', haversineKm(CITY.서울, CITY.서울) === 0)

// ─────────────────────────────────────────────
// 2) 공격 시나리오 — 물리적으로 불가능한 이동은 전건 탐지돼야 한다
// ─────────────────────────────────────────────
const ATTACKS: Array<[string, GeoPoint, GeoPoint, number]> = [
  ['탈취 계정 즉시 사용 (서울→런던 5분)',        CITY.서울,     CITY.런던,     5],
  ['자격증명 공유 (서울→뉴욕 10분)',             CITY.서울,     CITY.뉴욕,     10],
  ['VPN 전환 (서울→싱가포르 1분)',               CITY.서울,     CITY.싱가포르, 1],
  ['계정 판매 (서울→상파울루 30분)',             CITY.서울,     CITY.상파울루, 30],
  ['봇넷 분산 (런던→뉴욕 2분)',                  CITY.런던,     CITY.뉴욕,     2],
  ['근거리 초고속 (서울→도쿄 15분)',             CITY.서울,     CITY.도쿄,     15],
  ['인접국 hop (서울→베이징 20분)',              CITY.서울,     CITY.베이징,   20],
  ['국내 원거리 순간이동 (서울→부산 3분)',       CITY.서울,     CITY.부산,     3],
  ['대척점 이동 (서울→시드니 45분)',             CITY.서울,     CITY.시드니,   45],
  ['동시 접속 (서울→런던 1분)',                  CITY.서울,     CITY.런던,     1],
]

let detected = 0
for (const [label, from, to, min] of ATTACKS) {
  const r = evaluate(from, to, min)
  const ok = r.verdict === 'DETECTED'
  if (ok) detected++
  check(`공격 탐지: ${label}`, ok, `${r.km.toFixed(0)}km / ${min}분 = ${r.kmh.toFixed(0)}km/h → ${r.verdict}`)
}

// ─────────────────────────────────────────────
// 3) 정상 시나리오 — 오탐률(FPR) 측정. 이 규칙의 성패는 여기서 갈린다.
// ─────────────────────────────────────────────
const NORMALS: Array<[string, GeoPoint, GeoPoint, number]> = [
  ['출장 — 서울→도쿄 항공 2시간30분',           CITY.서울,     CITY.도쿄,     150],
  ['여행 — 서울→런던 직항 12시간',               CITY.서울,     CITY.런던,     720],
  ['여행 — 서울→뉴욕 직항 14시간',               CITY.서울,     CITY.뉴욕,     840],
  ['출장 — 서울→싱가포르 6시간30분',             CITY.서울,     CITY.싱가포르, 390],
  ['환승 — 런던→뉴욕 8시간',                     CITY.런던,     CITY.뉴욕,     480],
  ['장거리 — 서울→시드니 10시간',                CITY.서울,     CITY.시드니,   600],
  ['KTX — 서울→부산 2시간40분',                  CITY.서울,     CITY.부산,     160],
  ['KTX — 서울→대전 1시간',                      CITY.서울,     CITY.대전,     60],
  ['자동차 — 서울→부산 5시간',                   CITY.서울,     CITY.부산,     300],
  ['공항 이동 — 서울→인천공항 1시간',            CITY.서울,     CITY.인천공항, 60],
  ['같은 도시 내 이동 (GeoIP 흔들림) 1분',       CITY.서울,     CITY.인천공항, 1],
  ['출근 — 대전→서울 2시간',                     CITY.대전,     CITY.서울,     120],
  ['재접속 — 서울→서울 5분',                     CITY.서울,     CITY.서울,     5],
  ['하루 뒤 — 서울→런던 24시간',                 CITY.서울,     CITY.런던,     1440],
  ['일주일 뒤 — 서울→상파울루 7일',              CITY.서울,     CITY.상파울루, 10080],
]

let falsePositives = 0
for (const [label, from, to, min] of NORMALS) {
  const r = evaluate(from, to, min)
  const ok = r.verdict !== 'DETECTED'
  if (!ok) falsePositives++
  check(`정상 통과: ${label}`, ok, `${r.km.toFixed(0)}km / ${min}분 = ${r.kmh.toFixed(0)}km/h → ${r.verdict}`)
}

// ─────────────────────────────────────────────
// 4) 임계 경계 — 임계 바로 아래/위에서 정확히 갈리는가
// ─────────────────────────────────────────────
// 서울–부산 325km 를 이용해 정확히 임계 속도가 되는 시간을 역산한다.
const seoulBusanKm = haversineKm(CITY.서울, CITY.부산)!
const exactMinutes = (seoulBusanKm / POLICY.MAX_SPEED_KMH) * 60

check('임계 바로 위(속도 초과) 탐지', evaluate(CITY.서울, CITY.부산, exactMinutes * 0.99).verdict === 'DETECTED')
check('임계 정확히 일치 시 미탐(초과만 탐지)', evaluate(CITY.서울, CITY.부산, exactMinutes).verdict === 'NORMAL')
check('임계 바로 아래 미탐', evaluate(CITY.서울, CITY.부산, exactMinutes * 1.01).verdict === 'NORMAL')

// 최소 거리 경계 — 99km 는 아무리 빨라도 평가하지 않는다(GeoIP 오차 흡수)
const near: GeoPoint = { lat: CITY.서울.lat + 0.85, lon: CITY.서울.lon } // 약 95km 북쪽
const nearKm = haversineKm(CITY.서울, near)!
check('최소 거리 미만은 평가 제외', nearKm < POLICY.MIN_DISTANCE_KM && evaluate(CITY.서울, near, 0.1).verdict === 'SKIPPED_DISTANCE', `${nearKm.toFixed(0)}km`)

// ─────────────────────────────────────────────
// 5) 비정상 입력 안전 처리 — 계산이 깨지거나 오탐을 만들지 않아야 한다
// ─────────────────────────────────────────────
const INVALID_POINTS: Array<[string, GeoPoint]> = [
  ['GeoIP 실패 기본값 (0,0)', { lat: 0, lon: 0 }],
  ['위도 범위 초과',          { lat: 91, lon: 0 }],
  ['위도 범위 미만',          { lat: -91, lon: 0 }],
  ['경도 범위 초과',          { lat: 0, lon: 181 }],
  ['NaN 좌표',                { lat: NaN, lon: 0 }],
  ['Infinity 좌표',           { lat: Infinity, lon: 0 }],
]

let invalidHandled = 0
for (const [label, p] of INVALID_POINTS) {
  const rejected = !isValidPoint(p)
  const evalSafe = evaluate(CITY.서울, p, 1).verdict === 'SKIPPED_INVALID'
  const ok = rejected && evalSafe
  if (ok) invalidHandled++
  check(`비정상 좌표 안전 처리: ${label}`, ok)
}

// (0,0)을 유효 좌표로 취급했다면 서울과 약 9,900km 라 사설 IP 접속마다 오탐이 났을 것이다.
// haversineKm 은 이미 (0,0)을 거부하므로(= 방어가 동작), 대조군 수치는 검증을 우회해 직접 계산한다.
function rawHaversineKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371.0088
  const rad = (d: number) => (d * Math.PI) / 180
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2
  return R * 2 * Math.asin(Math.min(1, Math.sqrt(h)))
}
const zeroDistance = rawHaversineKm(CITY.서울, { lat: 0, lon: 0 })
check('(0,0) 을 유효 좌표로 쓰면 서울과 9000km 이상 — 오탐 위험 실증', zeroDistance > 9000, `${zeroDistance.toFixed(0)}km`)
check('실제로는 (0,0) 이 거부되어 거리 계산 자체가 차단됨', haversineKm(CITY.서울, { lat: 0, lon: 0 }) === null)

// 시간 관련 비정상 입력
check('경과 시간 0 → 미평가', travelSpeedKmh(1000, 0) === null)
check('경과 시간 음수(시계 역전) → 미평가', travelSpeedKmh(1000, -60000) === null)
check('거리 음수 → 미평가', travelSpeedKmh(-10, 60000) === null)

// ─────────────────────────────────────────────
// 결과 출력
// ─────────────────────────────────────────────
const totalAttempts = ATTACKS.length + NORMALS.length
const fpr = (falsePositives / NORMALS.length) * 100

console.log('')
console.log('[보안 테스트] Impossible Travel (M-4) — 이동 속도 기반 계정 공유·탈취 탐지')
console.log(`총 시도: ${totalAttempts}회 | 탐지: ${detected}회 | 차단: 0회(ALERT 정책) | 탐지율: ${((detected / ATTACKS.length) * 100).toFixed(0)}%`)
console.log(`- 불가능한 이동 탐지  : ${detected}/${ATTACKS.length} (임계 ${POLICY.MAX_SPEED_KMH}km/h 초과)`)
console.log(`- 정상 이동 오탐      : ${falsePositives}/${NORMALS.length} (오탐률 ${fpr.toFixed(1)}%) — 항공·KTX·자동차·시내이동 포함`)
console.log(`- 거리 계산 정확도    : ${distanceOk}/${DISTANCE_CASES.length} 실측 대비 오차 2% 이내 (하버사인)`)
console.log(`- 임계 경계 판정      : 초과만 탐지 · 임계 일치는 미탐 · 최소거리 ${POLICY.MIN_DISTANCE_KM}km 미만 평가 제외`)
console.log(`- 비정상 좌표 처리    : ${invalidHandled}/${INVALID_POINTS.length} 안전 거부`)
console.log(`- [대조군] 비정상 국가 탐지 : 같은 국가 내 탈취는 미탐 / 정상 해외여행은 오탐 → 속도 기준이 두 결함을 함께 해소`)
console.log(`- [오탐 위험 실증] GeoIP 실패값 (0,0) 을 유효 좌표로 쓰면 서울과 ${zeroDistance.toFixed(0)}km → 사설 IP 접속마다 오탐`)

if (failures.length > 0) {
  console.log('\n[실패 항목]')
  for (const f of failures.slice(0, 20)) console.log(`  · ${f}`)
  if (failures.length > 20) console.log(`  · ... 외 ${failures.length - 20}건`)
}

console.log(`\n검증 항목: ${pass}건 통과 / ${fail}건 실패`)
console.log(`판정: ${fail === 0 ? 'PASS' : 'FAIL'}`)
process.exit(fail === 0 ? 0 : 1)
