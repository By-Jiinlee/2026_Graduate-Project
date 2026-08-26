/**
 * [보안 검증] 카나리(미끼) 계좌 덫
 *
 * 미끼 계좌(canaryService.CANARY_USER_IDS)로 거래·조회 진입점에 접근했을 때
 *   (1) 요청이 차단되는가          → HTTP 응답에 CN-xx 코드
 *   (2) 탐지가 기록으로 남는가      → anomaly_logs 에 CANARY_ACCESS 행 증가
 *   (3) 정상 사용자는 걸리지 않는가 → 대조군 오탐률
 * 을 함께 측정한다. 기록이 남지 않으면 대시보드·논문 수치로 쓸 수 없으므로
 * "차단"과 "탐지"를 분리해서 센다.
 *
 * 사전 조건: 서버가 http://localhost:3000 에서 실행 중이어야 한다.
 * 실행: cd server && npx ts-node src/test/security/canaryTrap.test.ts
 *
 * 주의: POST/DELETE 진입점(CN-01·02·05·07·08·12·13)은 hmacMiddleware 가
 * 로그인 시 발급되는 세션 서명키를 요구하므로 스크립트로는 도달할 수 없다.
 * 같은 assertNotCanary() 한 곳을 공유하므로 GET 경로로 기전을 검증하고,
 * POST 경로는 브라우저 수동 시연으로 확인한다.
 */
import jwt from 'jsonwebtoken'
import { QueryTypes } from 'sequelize'
import sequelize from '../../config/database'
import { CANARY_USER_IDS } from '../../services/security/canaryService'

const BASE = process.env.TEST_BASE_URL ?? 'http://localhost:3000'

interface Target { code: string; name: string; path: string }

const TARGETS: Target[] = [
  { code: 'CN-03', name: '모의투자 포트폴리오 조회', path: '/api/trade/virtual/portfolio' },
  { code: 'CN-06', name: '모의투자 거래내역 조회',   path: '/api/trade/virtual/orders' },
  { code: 'CN-04', name: '미체결 주문 조회',         path: '/api/trade/virtual/orders/pending' },
  { code: 'CN-09', name: '실거래 거래내역 조회',     path: '/api/trade/real/orders' },
  { code: 'CN-10', name: '실거래 잔고 조회',         path: '/api/trade/real/balance' },
  { code: 'CN-11', name: '실거래 계좌 상태 조회',    path: '/api/trade/real/account' },
]

function mintToken(user: { id: number; email: string; role: string }): string {
  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error('JWT_SECRET 이 .env 에 없습니다')
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, secret, { expiresIn: '10m' })
}

async function probe(target: Target, token: string) {
  const res = await fetch(BASE + target.path, {
    method: 'GET',
    headers: { Cookie: `accessToken=${token}` },
  })
  const body = await res.text()
  // 덫이 던진 오류만 탐지로 센다 — 계좌 미등록(404/400) 같은 정상 실패와 구분해야 한다.
  const tripped = body.includes(target.code)
  return { status: res.status, tripped, body: body.slice(0, 160) }
}

async function countCanaryLogs(): Promise<number> {
  const r: any = await sequelize.query(
    `SELECT COUNT(*) n FROM anomaly_logs WHERE anomaly_type = 'CANARY_ACCESS'`,
    { type: QueryTypes.SELECT },
  )
  return Number(r[0].n)
}

async function main() {
  const canaryId = CANARY_USER_IDS[0]

  const canary: any = await sequelize.query(
    `SELECT id, email, role FROM users WHERE id = :id`,
    { replacements: { id: canaryId }, type: QueryTypes.SELECT },
  )
  if (!canary.length) throw new Error(`카나리 계정(id=${canaryId})이 DB 에 없습니다`)

  const control: any = await sequelize.query(
    `SELECT id, email, role FROM users
      WHERE id <> :id AND status = 'active' ORDER BY id DESC LIMIT 1`,
    { replacements: { id: canaryId }, type: QueryTypes.SELECT },
  )
  if (!control.length) throw new Error('대조군으로 쓸 정상 계정이 없습니다')

  const canaryToken = mintToken(canary[0])
  const controlToken = mintToken(control[0])

  const before = await countCanaryLogs()

  console.log(`\n대상 서버 : ${BASE}`)
  console.log(`미끼 계정 : id=${canary[0].id}`)
  console.log(`대조군    : id=${control[0].id}\n`)

  console.log('── 미끼 계정으로 접근 ──')
  let blocked = 0
  for (const t of TARGETS) {
    const r = await probe(t, canaryToken)
    if (r.tripped) blocked++
    console.log(`  ${r.tripped ? '차단' : '통과'}  ${t.code}  ${t.name}  (HTTP ${r.status})`)
    if (!r.tripped) console.log(`        └ 응답: ${r.body}`)
  }

  console.log('\n── 대조군(정상 계정)으로 동일 접근 ──')
  let falsePositive = 0
  for (const t of TARGETS) {
    const r = await probe(t, controlToken)
    if (r.tripped) falsePositive++
    console.log(`  ${r.tripped ? '오탐!' : '정상'}  ${t.code}  ${t.name}  (HTTP ${r.status})`)
  }

  // 로그는 비동기로 기록되므로 잠시 대기 후 집계한다.
  await new Promise((r) => setTimeout(r, 1500))
  const after = await countCanaryLogs()
  const logged = after - before

  const total = TARGETS.length
  const rate = ((blocked / total) * 100).toFixed(0)
  const fpRate = ((falsePositive / total) * 100).toFixed(0)

  console.log('\n' + '='.repeat(58))
  console.log('[보안 테스트] 카나리 계좌 덫 (기만 기술)')
  console.log(`총 시도: ${total}회 | 탐지: ${logged}회 | 차단: ${blocked}회 | 탐지율: ${rate}%`)
  console.log(`대조군 ${total}회 중 오탐 ${falsePositive}회 | 오탐률: ${fpRate}%`)
  console.log(`anomaly_logs(CANARY_ACCESS): ${before} → ${after}`)
  console.log('='.repeat(58))

  const ok = blocked === total && logged === total && falsePositive === 0
  console.log(ok ? '\n결과: PASS' : '\n결과: FAIL — 위 항목 확인 필요')

  await sequelize.close()
  process.exit(ok ? 0 : 1)
}

main().catch(async (e) => {
  console.error('\n실행 실패:', e.message)
  await sequelize.close().catch(() => {})
  process.exit(2)
})
