export {} // 이 파일을 모듈로 만들어 전역 스코프 변수 충돌을 막는다
// ─────────────────────────────────────────────────────────────
// [보안 검증] 교차 출처 접근 통제 — CORS 허용 출처 정책
//
// 배경: 기존 구현은 허용 출처가 'http://localhost:5173' 로 하드코딩돼 있었다.
// 시연·발표 시 휴대폰이나 다른 PC가 LAN IP로 접속하면 Origin 이 달라져 전부 차단됐고,
// 이를 피하려고 origin:'*' 로 여는 것은 credentials:true 와 함께 쓸 수 없을 뿐 아니라
// 임의 웹사이트가 사용자의 인증 쿠키로 API 를 호출할 수 있게 만든다(CSRF 유사 경로).
//
// 그래서 "사설 대역(RFC1918) LAN 출처만 조건부 허용"하는 허용목록으로 전환했다.
// 이 스크립트가 확인하는 것은 세 가지다.
//   (1) 정상 접속 경로가 열리는가 — localhost·LAN IP·명시 허용 도메인 (오탐 0 이어야 함)
//   (2) 공격 출처가 막히는가 — 임의 외부 도메인, 공인 IP, 사설 대역 위장 문자열
//   (3) 정책 스위치가 실제로 동작하는가 — ALLOW_LAN_ORIGINS=false 면 LAN 도 닫혀야 함
//
// 서버·DB 없이 판정 함수를 직접 호출하는 결정적 검증이다.
// 실행: cd server && npx ts-node src/test/security/corsOrigin.test.ts
// ─────────────────────────────────────────────────────────────

const CORS_MODULE = require.resolve('../../config/cors')

type OriginJudge = (origin: string | undefined) => boolean

// 정책은 모듈 로드 시점에 환경변수로 결정되므로, 정책별로 캐시를 비우고 다시 읽는다.
function loadPolicy(env: Record<string, string | undefined>): OriginJudge {
  const saved = { ...process.env }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  delete require.cache[CORS_MODULE]
  const mod = require('../../config/cors') as { isAllowedOrigin: OriginJudge }
  const judge = mod.isAllowedOrigin
  process.env = saved
  return judge
}

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass++
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`) }
}

// ─────────────────────────────────────────────
// 1) 기본 정책 (LAN 허용) — 정상 접속 경로
// ─────────────────────────────────────────────
const allowLan = loadPolicy({
  ALLOW_LAN_ORIGINS: 'true',
  CLIENT_ORIGINS: 'https://uptick.example.com, https://www.uptick.example.com/',
  NODE_ENV: 'development',
})

const legitimateOrigins = [
  'http://localhost:5173',            // 개발 기본
  'http://127.0.0.1:5173',            // 루프백 IP
  'http://192.168.0.12:5173',         // 발표용 노트북 LAN
  'http://192.168.219.104:5173',      // 휴대폰에서 접속
  'http://10.0.1.7:5173',             // 10/8 사설 대역
  'http://172.16.5.9:5173',           // 172.16/12 하한
  'http://172.31.255.254:5173',       // 172.16/12 상한
  'https://uptick.example.com',       // CLIENT_ORIGINS 명시
  'https://www.uptick.example.com',   // 후행 슬래시 정규화 확인
]

let legitAllowed = 0
for (const origin of legitimateOrigins) {
  const ok = allowLan(origin)
  if (ok) legitAllowed++
  check(`정상 출처 허용: ${origin}`, ok)
}

// Origin 헤더가 없는 요청(서버 간 호출·curl·검증 스크립트)은 CORS 대상이 아니다.
check('Origin 없는 요청 허용(비브라우저 호출)', allowLan(undefined))

// ─────────────────────────────────────────────
// 2) 공격 출처 — 전건 차단돼야 한다
// ─────────────────────────────────────────────
const maliciousOrigins: Array<[string, string]> = [
  ['https://evil.com', '임의 외부 도메인'],
  ['http://attacker.io:5173', '포트만 맞춘 외부 도메인'],
  ['https://uptick.example.com.evil.com', '허용 도메인 접미사 위장'],
  ['https://evil.com/uptick.example.com', '경로에 허용 도메인 삽입'],
  ['http://8.8.8.8:5173', '공인 IP'],
  ['http://172.15.0.1:5173', '사설 대역 경계 밖(172.15)'],
  ['http://172.32.0.1:5173', '사설 대역 경계 밖(172.32)'],
  ['http://192.169.0.1:5173', '사설 대역 인접 오타(192.169)'],
  ['http://11.0.0.1:5173', '사설 대역 인접(11/8)'],
  ['http://192.168.0.1.evil.com', '사설 IP 접두 위장 도메인'],
  ['http://evil.com#192.168.0.1', '프래그먼트로 사설 IP 위장'],
  ['http://evil.com?x=http://192.168.0.1', '쿼리로 사설 IP 위장'],
  ['http://192.168.0.1@evil.com', 'userinfo 로 사설 IP 위장'],
  ['null', 'sandbox iframe 의 null 출처'],
  ['file://', '로컬 파일 출처'],
  ['http://LOCALHOST.evil.com', 'localhost 접두 위장'],
]

let blocked = 0
for (const [origin, label] of maliciousOrigins) {
  const denied = !allowLan(origin)
  if (denied) blocked++
  check(`공격 출처 차단(${label}): ${origin}`, denied)
}

// ─────────────────────────────────────────────
// 3) 정책 스위치 — LAN 차단 모드
// ─────────────────────────────────────────────
const denyLan = loadPolicy({
  ALLOW_LAN_ORIGINS: 'false',
  CLIENT_ORIGINS: 'https://uptick.example.com',
  NODE_ENV: 'production',
})

const lanOrigins = [
  'http://192.168.0.12:5173',
  'http://10.0.1.7:5173',
  'http://172.16.5.9:5173',
]
let lanBlockedInProd = 0
for (const origin of lanOrigins) {
  const denied = !denyLan(origin)
  if (denied) lanBlockedInProd++
  check(`LAN 차단 모드에서 거부: ${origin}`, denied)
}
check('LAN 차단 모드에서도 명시 허용 도메인은 통과', denyLan('https://uptick.example.com'))
check('LAN 차단 모드에서도 localhost 기본값은 통과', denyLan('http://localhost:5173'))

// NODE_ENV=production 이면 플래그 미지정 시 LAN 이 기본 차단돼야 한다(안전한 기본값).
const prodDefault = loadPolicy({
  ALLOW_LAN_ORIGINS: undefined,
  CLIENT_ORIGINS: undefined,
  NODE_ENV: 'production',
})
check('운영 기본값에서 LAN 차단(플래그 미지정)', !prodDefault('http://192.168.0.12:5173'))
check('운영 기본값에서도 localhost 는 허용', prodDefault('http://localhost:5173'))

const devDefault = loadPolicy({
  ALLOW_LAN_ORIGINS: undefined,
  CLIENT_ORIGINS: undefined,
  NODE_ENV: 'development',
})
check('개발 기본값에서 LAN 허용(플래그 미지정)', devDefault('http://192.168.0.12:5173'))

// ─────────────────────────────────────────────
// 4) 실 HTTP 검증 — 미들웨어가 실제로 헤더를 내는가
//
// 판정 함수가 맞아도 배선이 틀리면 무의미하다. cors(corsOptions) 를 얹은 실제 서버를
// 띄워 preflight(OPTIONS)와 본요청의 응답 헤더를 확인한다. 브라우저는
// Access-Control-Allow-Origin 이 없으면 응답을 스크립트에 넘기지 않으므로,
// 차단의 기준은 "요청 실패"가 아니라 "허용 헤더 부재"다.
// ─────────────────────────────────────────────
async function verifyOverHttp(): Promise<{ allowed: number; denied: number }> {
  process.env.ALLOW_LAN_ORIGINS = 'true'
  process.env.CLIENT_ORIGINS = 'https://uptick.example.com'
  process.env.NODE_ENV = 'development'
  delete require.cache[CORS_MODULE]
  const { corsOptions } = require('../../config/cors')

  const express = require('express')
  const cors = require('cors')
  const app = express()
  app.use(cors(corsOptions))
  app.get('/api/ping', (_req: any, res: any) => res.json({ ok: true }))
  // cors 미들웨어가 거부하면 next(err) 로 넘어온다. 실제 서버와 동일하게 500 이 아닌 403 으로 처리.
  app.use((err: any, _req: any, res: any, _next: any) => res.status(403).json({ error: String(err?.message ?? err) }))

  const server = await new Promise<any>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`

  let allowed = 0
  let denied = 0
  try {
    for (const origin of ['http://localhost:5173', 'http://192.168.0.12:5173', 'https://uptick.example.com']) {
      const pre = await fetch(`${base}/api/ping`, {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' },
      })
      const res = await fetch(`${base}/api/ping`, { headers: { Origin: origin } })
      const acao = res.headers.get('access-control-allow-origin')
      const acac = res.headers.get('access-control-allow-credentials')
      const ok = pre.status < 400 && acao === origin && acac === 'true'
      if (ok) allowed++
      check(`[HTTP] 허용 출처 헤더 반환: ${origin}`, ok, `preflight=${pre.status} ACAO=${acao} ACAC=${acac}`)
      // credentials 를 쓰므로 와일드카드가 나와서는 안 된다.
      check(`[HTTP] 와일드카드 미사용: ${origin}`, acao !== '*', `ACAO=${acao}`)
    }

    for (const origin of ['https://evil.com', 'http://8.8.8.8:5173', 'https://uptick.example.com.evil.com']) {
      const res = await fetch(`${base}/api/ping`, { headers: { Origin: origin } })
      const acao = res.headers.get('access-control-allow-origin')
      const ok = acao === null
      if (ok) denied++
      check(`[HTTP] 차단 출처에 허용 헤더 미반환: ${origin}`, ok, `ACAO=${acao}`)
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  return { allowed, denied }
}

// ─────────────────────────────────────────────
// 결과 출력
// ─────────────────────────────────────────────
function report(http: { allowed: number; denied: number }): void {
const attackAttempts = maliciousOrigins.length + lanOrigins.length + 1 + 3  // 공격 출처 + 운영모드 LAN + 실HTTP 차단
const attackBlocked = blocked + lanBlockedInProd + (prodDefault('http://192.168.0.12:5173') ? 0 : 1) + http.denied
const fpr = ((legitimateOrigins.length - legitAllowed) / legitimateOrigins.length) * 100

console.log('')
console.log('[보안 테스트] 교차 출처 접근 통제 — CORS 허용 출처 정책')
console.log(`총 시도: ${attackAttempts}회 | 탐지: ${attackBlocked}회 | 차단: ${attackBlocked}회 | 탐지율: ${((attackBlocked / attackAttempts) * 100).toFixed(0)}%`)
console.log(`- 임의 출처 차단      : ${blocked}/${maliciousOrigins.length} (도메인 위장·공인 IP·사설대역 경계 포함)`)
console.log(`- 사설대역 경계 판정  : 172.15/172.32/192.169/11.x 전건 거부`)
console.log(`- 운영모드 LAN 차단   : ${lanBlockedInProd}/${lanOrigins.length} + 플래그 미지정 기본 차단`)
console.log(`- 정상 출처 오차단    : ${legitimateOrigins.length - legitAllowed}/${legitimateOrigins.length} (오탐률 ${fpr.toFixed(1)}%)`)
console.log(`- 실 HTTP 배선 확인   : 허용 ${http.allowed}/3 헤더 반환(와일드카드 미사용) · 차단 ${http.denied}/3 헤더 미반환`)
console.log(`- [대조군] 기존 하드코딩 'http://localhost:5173' : LAN 접속 ${lanOrigins.length}/${lanOrigins.length} 전건 차단(시연 불가)`)

if (failures.length > 0) {
  console.log('\n[실패 항목]')
  for (const f of failures.slice(0, 20)) console.log(`  · ${f}`)
  if (failures.length > 20) console.log(`  · ... 외 ${failures.length - 20}건`)
}

console.log(`\n검증 항목: ${pass}건 통과 / ${fail}건 실패`)
console.log(`판정: ${fail === 0 ? 'PASS' : 'FAIL'}`)
process.exit(fail === 0 ? 0 : 1)
}

verifyOverHttp().then(report).catch((err) => {
  console.error('실 HTTP 검증 중 오류:', err)
  process.exit(1)
})
