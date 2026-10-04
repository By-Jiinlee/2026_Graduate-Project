/**
 * [보안 검증] 본인 인증 등급별 이용 범위 — 모의투자(이메일·휴대폰 중 하나) / 실거래(둘 다)
 *
 * 실제 라우터(virtualTradeRouter·tradePinRouter·realTradeRouter)를 그대로 HTTP 로 띄우고, 인증 상태 4가지
 * (없음·이메일만·휴대폰만·둘 다) 사용자로 모든 경로를 호출해 허용·거부가 정책과 일치하는지 확인한다.
 * 실거래는 쓰기뿐 아니라 조회 경로(계좌 상태·잔고·내역)까지 둘 다 인증을 요구하는지 함께 본다.
 *
 * 로그인(isAuthenticated)·HMAC·컨트롤러만 스텁으로 바꾼다 — 검증 대상은 인증 등급 미들웨어 배선이다.
 *
 * 실행: cd server && npx ts-node src/test/security/verificationTier.test.ts
 */
import express from 'express'

/* eslint-disable @typescript-eslint/no-var-requires */
type Profile = 'none' | 'email' | 'phone' | 'both'
const PROFILES: Record<Profile, { is_email_verified: boolean; is_phone_verified: boolean }> = {
  none: { is_email_verified: false, is_phone_verified: false },
  email: { is_email_verified: true, is_phone_verified: false },
  phone: { is_email_verified: false, is_phone_verified: true },
  both: { is_email_verified: true, is_phone_verified: true },
}

const stub = (path: string, exports: any) => {
  const resolved = require.resolve(path)
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports } as any
}
stub('../../middleware/auth/authMiddleware', {
  isAuthenticated: (req: any, _res: any, next: any) => {
    req.user = { id: 1, email: 'tier@test.local', ...PROFILES[req.headers['x-test-profile'] as Profile] }
    next()
  },
})
stub('../../middleware/security/hmacMiddleware', { hmacMiddleware: (_req: any, _res: any, next: any) => next() })
const okHandler = (_req: any, res: any) => res.json({ ok: true })
for (const c of ['../../controllers/trade/virtualTradeController', '../../controllers/trade/realTradeController', '../../controllers/trade/tradePinController']) {
  stub(c, new Proxy({}, { get: () => okHandler }))
}

const app = express()
app.use(express.json())
app.use('/api/trade/virtual', require('../../routes/trade/virtualTradeRouter').default)
app.use('/api/trade/pin', require('../../routes/trade/tradePinRouter').default)
app.use('/api/trade/real', require('../../routes/trade/realTradeRouter').default)

type Route = { method: string; path: string; tier: 'mock' | 'real'; label: string }
const routes: Route[] = [
  { method: 'POST', path: '/api/trade/virtual/account/open', tier: 'mock', label: '모의계좌 개설' },
  { method: 'POST', path: '/api/trade/virtual/buy', tier: 'mock', label: '모의 매수' },
  { method: 'POST', path: '/api/trade/virtual/sell', tier: 'mock', label: '모의 매도' },
  { method: 'GET', path: '/api/trade/virtual/portfolio', tier: 'mock', label: '모의 포트폴리오' },
  { method: 'GET', path: '/api/trade/virtual/market-status', tier: 'mock', label: '장 운영 상태' },
  { method: 'DELETE', path: '/api/trade/virtual/orders/1', tier: 'mock', label: '모의 미체결 취소' },
  { method: 'GET', path: '/api/trade/pin/status', tier: 'mock', label: 'PIN 상태' },
  { method: 'POST', path: '/api/trade/pin', tier: 'mock', label: 'PIN 설정' },
  { method: 'POST', path: '/api/trade/real/account', tier: 'real', label: '실계좌 등록' },
  { method: 'GET', path: '/api/trade/real/account', tier: 'real', label: '실계좌 상태 조회' },
  { method: 'DELETE', path: '/api/trade/real/account', tier: 'real', label: '실계좌 해제' },
  { method: 'GET', path: '/api/trade/real/balance', tier: 'real', label: 'KIS 잔고 조회' },
  { method: 'POST', path: '/api/trade/real/buy', tier: 'real', label: '실거래 매수' },
  { method: 'POST', path: '/api/trade/real/sell', tier: 'real', label: '실거래 매도' },
  { method: 'GET', path: '/api/trade/real/orders', tier: 'real', label: '실거래 내역' },
]

const allowed = (p: Profile, tier: 'mock' | 'real') =>
  tier === 'mock' ? p !== 'none' : p === 'both'

async function main() {
  console.log('\n[보안 테스트] 본인 인증 등급별 이용 범위')
  const server: any = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const rows: { name: string; ok: boolean; detail: string }[] = []
  let calls = 0, denials = 0, wrong = 0
  try {
    for (const p of Object.keys(PROFILES) as Profile[]) {
      for (const r of routes) {
        const res = await fetch(`${base}${r.path}`, {
          method: r.method,
          headers: { 'Content-Type': 'application/json', 'x-test-profile': p },
          body: r.method === 'GET' ? undefined : '{}',
        })
        const body: any = await res.json().catch(() => ({}))
        calls++
        const expectOk = allowed(p, r.tier)
        const gotOk = res.status === 200
        if (!gotOk) denials++
        let ok = gotOk === expectOk
        if (!gotOk && ok) {
          const code = r.tier === 'mock' ? 'VERIFICATION_REQUIRED' : 'FULL_VERIFICATION_REQUIRED'
          ok = res.status === 403 && body.code === code
          if (r.tier === 'real') {
            const missing = [!PROFILES[p].is_email_verified && 'email', !PROFILES[p].is_phone_verified && 'phone'].filter(Boolean)
            ok = ok && JSON.stringify(body.missing) === JSON.stringify(missing)
          }
        }
        if (!ok) wrong++
        rows.push({ name: `[${p}] ${r.label}`, ok, detail: `${res.status}${body.code ? ' ' + body.code : ''}` })
      }
    }
  } finally {
    server.close()
  }

  const summary = (Object.keys(PROFILES) as Profile[]).map((p) => {
    const mine = rows.filter((r) => r.name.startsWith(`[${p}]`))
    const mock = mine.filter((_, i) => routes[i].tier === 'mock' && mine[i].detail.startsWith('200')).length
    const real = mine.filter((_, i) => routes[i].tier === 'real' && mine[i].detail.startsWith('200')).length
    return `  - ${p.padEnd(5)}: 모의투자 ${mock}/${routes.filter((r) => r.tier === 'mock').length} 허용 · 실거래 ${real}/${routes.filter((r) => r.tier === 'real').length} 허용`
  })
  console.log(`총 시도: ${calls}회 | 거부: ${denials}회 | 정책 불일치: ${wrong}회`)
  for (const l of summary) console.log(l)
  for (const r of rows.filter((x) => !x.ok)) console.log(`  ✘ ${r.name} (${r.detail})`)
  console.log(`검증 항목: ${rows.length - wrong}건 통과 / ${wrong}건 실패`)
  console.log(`판정: ${wrong === 0 ? 'PASS' : 'FAIL'}`)
  process.exit(wrong === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('검증 실행 오류:', err)
  process.exit(1)
})
