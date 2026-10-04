import jwt from 'jsonwebtoken'

// ─────────────────────────────────────────────────────────────
// [보안 검증] 액세스 토큰 수명 — 로그인·갱신 경로 일치
//
// 배경: 논문 6.2 는 "액세스 토큰 만료 10분" 이지만 토큰 갱신(/refresh) 경로는 1시간짜리 JWT 를
//   발급하고 쿠키만 10분으로 두었다. 쿠키 만료는 브라우저가 지우는 것일 뿐, 토큰 값을 탈취한
//   공격자는 1시간 동안 그대로 쓸 수 있다(노출 창 6배). 두 경로가 수명을 각자 적은 것이 원인이다.
//
// 확인하려는 것
//   (1) 로그인 발급과 갱신 발급의 exp − iat 이 모두 600초다
//   (2) 갱신 응답의 accessToken 쿠키 수명이 토큰 수명과 같다
//   (3) 갱신 토큰이 없거나 위조·만료면 새 토큰을 발급하지 않는다
//   (4) 대조군: 수정 전 갱신 경로는 3600초 토큰을 발급했다
//
// 실제 refreshToken 컨트롤러를 가짜 req/res 로 호출한다. DB·서버를 쓰지 않는다.
// 실행: cd server && npx ts-node src/test/security/tokenLifetime.test.ts
// ─────────────────────────────────────────────────────────────

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-access-secret'
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const authService = require('../../services/auth/authService')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { refreshToken } = require('../../controllers/auth/authController')

let pass = 0
let fail = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass++
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`) }
}

type Cookie = { name: string; value: string; opts: any }
function fakeRes() {
  const cookies: Cookie[] = []
  const res: any = {
    statusCode: 200,
    body: undefined as any,
    cookie(name: string, value: string, opts: any) { cookies.push({ name, value, opts }); return res },
    clearCookie() { return res },
    status(c: number) { res.statusCode = c; return res },
    json(b: any) { res.body = b; return res },
  }
  return { res, cookies }
}
const lifetime = (token: string): number => {
  const d = jwt.decode(token) as { exp: number; iat: number }
  return d.exp - d.iat
}

const TTL = authService.ACCESS_TOKEN_TTL_SEC as number
check('정책값: ACCESS_TOKEN_TTL_SEC = 600', TTL === 600, String(TTL))

// (1) 로그인 경로 — loginStep2 가 쓰는 같은 발급 함수
const loginToken = authService.signAccessToken({ id: 1, email: 'a@example.com', role: 'user' })
check('로그인 발급: exp − iat = 600초', lifetime(loginToken) === 600, String(lifetime(loginToken)))

async function main() {
  // (1)(2) 갱신 경로
  const validRefresh = jwt.sign({ id: 7 }, process.env.JWT_REFRESH_SECRET as string, { expiresIn: '7d' })
  const ok = fakeRes()
  await refreshToken({ cookies: { refreshToken: validRefresh } } as any, ok.res)
  const access = ok.cookies.find((c) => c.name === 'accessToken')
  check('갱신: 200 응답', ok.res.statusCode === 200, String(ok.res.statusCode))
  check('갱신: accessToken 쿠키 발급', Boolean(access))
  if (access) {
    check('갱신 발급: exp − iat = 600초', lifetime(access.value) === 600, String(lifetime(access.value)))
    check('갱신: 쿠키 수명 = 토큰 수명', access.opts.maxAge === TTL * 1000, String(access.opts.maxAge))
    check('갱신: httpOnly·SameSite=Strict', access.opts.httpOnly === true && access.opts.sameSite === 'strict')
    check('갱신: 사용자 식별자 유지', (jwt.decode(access.value) as any).id === 7)
  }
  const flag = ok.cookies.find((c) => c.name === 'isLoggedIn')
  check('갱신: isLoggedIn 수명도 토큰과 동일', flag?.opts.maxAge === TTL * 1000, String(flag?.opts.maxAge))

  // (3) 거부 경로
  const cases: Array<[string, any]> = [
    ['갱신 토큰 없음', {}],
    ['액세스 비밀키로 위조한 갱신 토큰', { refreshToken: jwt.sign({ id: 7 }, process.env.JWT_SECRET as string) }],
    ['만료된 갱신 토큰', { refreshToken: jwt.sign({ id: 7, exp: Math.floor(Date.now() / 1000) - 10 }, process.env.JWT_REFRESH_SECRET as string) }],
    ['형식 오류', { refreshToken: 'not-a-jwt' }],
  ]
  let rejected = 0
  for (const [name, cookies] of cases) {
    const r = fakeRes()
    await refreshToken({ cookies } as any, r.res)
    const issued = r.cookies.some((c) => c.name === 'accessToken')
    if (r.res.statusCode === 401 && !issued) rejected++
    check(`[공격] ${name} → 401·미발급`, r.res.statusCode === 401 && !issued, `${r.res.statusCode}`)
  }

  // (4) 대조군 — 수정 전 갱신 경로의 발급식
  const legacy = jwt.sign({ id: 7 }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
  check('대조군: 수정 전 갱신 토큰 수명 3600초(쿠키 600초의 6배)', lifetime(legacy) === 3600)

  console.log('\n[보안 테스트] 액세스 토큰 수명(로그인·갱신 일치)')
  console.log(`총 시도: ${cases.length}회 | 탐지: ${rejected}회 | 차단: ${rejected}회 | 탐지율: ${((rejected / cases.length) * 100).toFixed(0)}%`)
  console.log(`- 로그인 발급 수명  : ${lifetime(loginToken)}초`)
  console.log(`- 갱신 발급 수명    : ${access ? lifetime(access.value) : '—'}초 (수정 전 3600초)`)
  console.log(`- 탈취 토큰 사용 창 : 3600초 → ${TTL}초`)

  console.log(`\n검증 항목: ${pass}건 통과 / ${fail}건 실패`)
  if (fail > 0) {
    console.log('\n실패 목록:')
    for (const f of failures) console.log(`  · ${f}`)
  }
  console.log(`판정: ${fail === 0 ? 'PASS' : 'FAIL'}`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error('실행 실패:', e); process.exit(2) })
