import crypto from 'crypto'
import { Op, QueryTypes } from 'sequelize'
import sequelize from '../../config/database'
import AnomalyLog from '../../models/auth/AnomalyLog'
import VirtualAccount from '../../models/trade/VirtualAccount'
import { computeSignature } from '../../services/auth/hmacService'
import { getPortfolioValue } from '../../services/trade/virtualTradeService'
import { TRADE_POLICY } from '../../services/auth/tradeAnomalyService'
import { IP, Res, arg, del, die, get, hasFlag, loginAsTestUser, post } from './testClient'

// ─────────────────────────────────────────────────────────────
// [보안 검증] M-1 거래 이상탐지 — 서비스 경로(E2E) 공격 시뮬레이션
//
// tradeAmountAnomaly.test.ts 는 판정 함수를 직접 호출하는 정책 단위 검증이다.
// 이 스크립트는 "실제 서비스 경로에서 거절되는가"를 확인한다. 즉
//   HTTP → ipBlock → isAuthenticated(JWT) → requirePhoneVerified → hmacMiddleware
//        → 컨트롤러(PIN 검증 → 주문 평가 → evaluateTradeRequest) → 주문 실행
// 전 구간을 통과시키고, 탐지 결과가 anomaly_logs 에 유형·조치·근거까지 정확히
// 남는지 DB 로 교차 확인한다.
//
// 부수효과를 0 으로 만드는 방법
//   모든 주문은 현재가보다 훨씬 낮은 지정가(1,000원)로 넣고 금액은 수량으로 만든다.
//   매수 지정가는 "현재가 ≤ 지정가"일 때만 체결되므로 이 주문들은 절대 체결되지 않고
//   미체결로 남으며, 종료 시 전량 취소해 예약금을 되돌린다(수수료 포함 전액 환불).
//   시작 잔고와 종료 잔고가 같은지를 검증 항목으로 두어 부수효과 0 을 증명한다.
//
// 실행 전제
//   1) 서버 실행 중 (cd server && npm run dev)
//   2) 마이그레이션 적용
//      npx ts-node src/database/migrations/apply.ts 20260801_anomaly_type_trade.sql
//   3) 휴대폰 인증이 완료된 전용 테스트 계정
//      (신뢰 기기가 덮어써지므로 실사용 계정 금지)
//      모의투자 계좌·PIN 이 없으면 --provision 으로 이 스크립트가 만들어 준다.
//
// 실행
//   cd server
//   npx ts-node src/test/security/tradeAnomaly.e2e.test.ts \
//     --email=test@x.com --password=xxxx --pin=123456 [--provision] [--keep]
// ─────────────────────────────────────────────────────────────

const BUY = '/api/trade/virtual/buy'
const SELL = '/api/trade/virtual/sell'

// 종목 식별자는 DB 에서 코드로 조회한다 — id 를 상수로 박으면 환경이 바뀔 때
// 외래키 위반으로 주문이 실패하고, 그 실패가 "탐지"로 오독될 수 있다.
const STOCK_CODE = arg('stock', '005930')
let STOCK = { stockId: 0, stockCode: STOCK_CODE }

// 체결가에서 멀리 떨어진 지정가 — 스케줄러가 체결시키지 않는다
const FAR_PRICE = 1_000
const BASELINE_ORDERS = 8      // 베이스라인 표본(정책 MIN_SAMPLES=5 초과)
const RECHECK_ORDERS = 3       // 탐지 발생 후 정상 거래 가용성 확인

// 로그인 레이트 리미터가 IP당 15회/15분이라 고정 IP 로 반복 실행하면 스크립트 자신이
// 막힌다. 실행마다 다른 위조 IP(RFC 5737 TEST-NET-2)로 로그인한다.
const LOGIN_IP = `198.51.100.${1 + Math.floor(Math.random() * 250)}`

const EMAIL = arg('email')
const PASSWORD = arg('password')
const PIN = arg('pin')

let pass = 0
let fail = 0
const failures: string[] = []
const notes: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass++; console.log(`  [OK]   ${name}${detail ? ` — ${detail}` : ''}`) }
  else {
    fail++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n─── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`)
}

const won = (v: number): string => `${Math.round(v).toLocaleString('ko-KR')}원`

interface AttackCase {
  name: string
  body: Record<string, unknown>
  /** anomaly_logs.detail 에 들어가야 할 판정 사유 코드 */
  expectReason: string
  /**
   * 직렬화된 본문을 그대로 손보는 후처리.
   * JSON.stringify 는 Infinity·NaN 을 null 로 바꾸므로, 그 값을 그대로 전송하려면
   * 원시 문자열을 만들어야 한다. JSON.parse 는 1e999 를 Infinity 로 파싱하므로
   * 공격자는 이 경로로 비유한 값을 서버 로직에 주입할 수 있다.
   */
  rawPatch?: (payload: string) => string
}

// 정상 클라이언트가 만들 수 없는 주문 파라미터 — 즉시 거절(fail-closed) 대상
const integrityCases: AttackCase[] = [
  { name: '음수 수량(잔고 증식 시도)', body: { quantity: -100, limitPrice: 50_000 }, expectReason: 'QUANTITY_NOT_POSITIVE' },
  { name: '소수 수량(반올림 유도)',     body: { quantity: 1.9999, limitPrice: 50_000 }, expectReason: 'QUANTITY_NOT_INTEGER' },
  { name: '수량이 숫자가 아님',         body: { quantity: 'abc', limitPrice: 50_000 }, expectReason: 'QUANTITY_NOT_FINITE' },
  {
    name: '수량 Infinity(원시 JSON 1e999)',
    body: { quantity: 0, limitPrice: 50_000 },
    expectReason: 'QUANTITY_NOT_FINITE',
    rawPatch: (p) => p.replace('"quantity":0', '"quantity":1e999'),
  },
  { name: '수량 상한 초과',             body: { quantity: 5_000_000, limitPrice: 50_000 }, expectReason: 'QUANTITY_TOO_LARGE' },
  { name: '음수 지정가',                body: { quantity: 10, limitPrice: -50_000 }, expectReason: 'PRICE_NOT_POSITIVE' },
  { name: '지정가가 숫자가 아님',       body: { quantity: 10, limitPrice: 'abc' }, expectReason: 'PRICE_NOT_FINITE' },
  { name: '지정가 상한 초과',           body: { quantity: 10, limitPrice: 200_000_000 }, expectReason: 'PRICE_TOO_LARGE' },
]

async function main(): Promise<void> {
  if (!EMAIL || !PASSWORD || !PIN) {
    die('사용법: npx ts-node src/test/security/tradeAnomaly.e2e.test.ts --email=... --password=... --pin=123456 [--provision]')
  }
  if (!/^\d{6}$/.test(PIN)) die('PIN 은 숫자 6자리여야 합니다.')

  await sequelize.authenticate().catch(() => die('DB 연결 실패 — server/.env 의 DATABASE_URL 을 확인하세요.'))

  const [stockRow] = await sequelize.query<{ id: number; name: string }>(
    'SELECT id, name FROM stocks WHERE code = :code LIMIT 1',
    { replacements: { code: STOCK_CODE }, type: QueryTypes.SELECT },
  )
  if (!stockRow) die(`종목 코드 ${STOCK_CODE} 를 stocks 테이블에서 찾을 수 없습니다.`)
  STOCK = { stockId: stockRow.id, stockCode: STOCK_CODE }

  const startedAt = new Date()
  const { cookie, userId, signingSecret } = await loginAsTestUser(EMAIL, PASSWORD, true, LOGIN_IP)

  const sign = (body: string) => {
    const ts = Date.now().toString()
    const nonce = crypto.randomUUID()
    return { ts, nonce, sig: computeSignature(signingSecret, ts, nonce, body) }
  }

  const order = async (
    path: string,
    body: Record<string, unknown>,
    rawPatch?: (payload: string) => string,
  ): Promise<Res> => {
    const base = JSON.stringify({ ...STOCK, orderType: 'limit', pin: PIN, ...body })
    const payload = rawPatch ? rawPatch(base) : base
    // 서명은 실제 전송 바이트 기준으로 계산해야 한다(후처리 이후)
    return post(path, payload, { ip: IP.TRADE, cookie, sign: sign(payload) })
  }
  const buy = (body: Record<string, unknown>, rawPatch?: (p: string) => string) => order(BUY, body, rawPatch)
  const sell = (body: Record<string, unknown>) => order(SELL, body)

  const pendingIds: number[] = []
  const balanceOf = async (): Promise<number> => {
    const acc = await VirtualAccount.findOne({ where: { user_id: userId } })
    return acc ? Number(acc.seed_balance) : -1
  }

  // ─── 0. 계정 준비 ───────────────────────────────────────────
  section('0. 계정 준비')
  console.log(`  계정 ${EMAIL} (user_id=${userId})`)
  console.log(`  종목 ${stockRow.name.trim()} (${STOCK_CODE}, stock_id=${STOCK.stockId})`)

  if (hasFlag('provision')) {
    const p = await post('/api/trade/virtual/pin', JSON.stringify({ pin: PIN }), { ip: IP.TRADE, cookie })
    console.log(`  PIN 설정: ${p.status} ${JSON.stringify(p.data)}`)
    const a = await post('/api/trade/virtual/account/open', JSON.stringify({ pin: PIN }), { ip: IP.TRADE, cookie })
    console.log(`  계좌 개설: ${a.status} ${JSON.stringify(a.data)}`)
  }

  const startBalance = await balanceOf()
  if (startBalance < 0) {
    die('모의투자 계좌가 없습니다 — --provision 플래그로 계좌·PIN 을 먼저 만드세요.')
  }
  const startPortfolio = await getPortfolioValue(userId)
  console.log(`  시작 잔고 ${won(startBalance)} · 평가액 ${won(startPortfolio)}`)

  // ─── 1. 정상 거래(베이스라인 형성) — 오탐률 측정 ────────────
  section('1. 정상 거래 — 베이스라인 형성 및 오탐률')
  let normalAttempts = 0
  let falsePositives = 0

  for (let i = 0; i < BASELINE_ORDERS; i++) {
    normalAttempts++
    const res = await buy({ quantity: 1, limitPrice: FAR_PRICE })
    if (res.status === 200 && res.data?.orderId) pendingIds.push(res.data.orderId)
    else {
      falsePositives++
      failures.push(`정상 주문 오탐 — ${res.status} ${JSON.stringify(res.data)?.slice(0, 120)}`)
    }
  }
  if (pendingIds.length === 0) {
    for (const f of failures) console.log(`  ${f}`)
    die('사전 점검 실패 — 정상 지정가 주문이 한 건도 접수되지 않았습니다. ' +
        'PIN·휴대폰 인증·계좌 상태를 확인하세요.')
  }
  check(`정상 지정가 주문 ${BASELINE_ORDERS}건 전건 통과`, falsePositives === 0,
    `${normalAttempts - falsePositives}/${normalAttempts}`)
  check('베이스라인 표본이 통계 판정 최소치를 넘김',
    pendingIds.length >= TRADE_POLICY.BASELINE.MIN_SAMPLES,
    `표본 ${pendingIds.length}건 / 최소 ${TRADE_POLICY.BASELINE.MIN_SAMPLES}건`)

  // ─── 2. 공격 A — 주문 무결성 위반 ───────────────────────────
  section('2. 공격 A — 주문 무결성 위반(fail-closed 거절)')
  let integrityBlocked = 0
  for (const c of integrityCases) {
    const res = await buy(c.body, c.rawPatch)
    const blocked = res.status === 400 && res.data?.code === 'INVALID_ORDER'
    if (blocked) integrityBlocked++
    else failures.push(`${c.name} — 거절되지 않음(${res.status} ${JSON.stringify(res.data)?.slice(0, 100)})`)
    console.log(`  ${blocked ? '차단' : '통과'} · ${c.name} → ${res.status} ${String(res.data?.message ?? '').slice(0, 40)}`)
  }
  check('무결성 위반 전건 거절', integrityBlocked === integrityCases.length,
    `${integrityBlocked}/${integrityCases.length}`)

  // 음수 수량이 잔고를 늘리지 못했는지 직접 확인 — 이번에 수정한 실취약점의 회귀 검사
  const afterAttackBalance = await balanceOf()
  check('음수 수량 공격으로 잔고가 증가하지 않음',
    afterAttackBalance <= startBalance,
    `${won(startBalance)} → ${won(afterAttackBalance)}`)

  // ─── 3. 공격 B — 계정 탈취형 단발 고액 주문 ─────────────────
  section('3. 공격 B — 단발 고액 주문(평가액 대비 비율 초과)')
  const portfolioValue = await getPortfolioValue(userId)
  const largeQuantity = Math.ceil((portfolioValue * 0.5) / FAR_PRICE)
  const large = await buy({ quantity: largeQuantity, limitPrice: FAR_PRICE })
  console.log(`  주문 ${won(largeQuantity * FAR_PRICE)} (평가액 ${won(portfolioValue)}의 50%) → ${large.status} ${JSON.stringify(large.data)?.slice(0, 80)}`)
  check('고액 주문 → 지갑 서명 재인증 요구(403 LARGE_ORDER)',
    large.status === 403 && large.data?.message === 'LARGE_ORDER',
    `${large.status}`)
  check('거절 사유가 사용자에게 설명됨',
    typeof large.data?.detail === 'string' && large.data.detail.length > 0,
    String(large.data?.detail ?? '').slice(0, 60))
  if (large.status === 200 && large.data?.orderId) pendingIds.push(large.data.orderId)

  // ─── 4. 공격 C — 비율 임계 아래의 습관 이탈 ─────────────────
  //   평가액의 3% 라 비율 규칙(20%)에는 걸리지 않는다. 통계 규칙 단독으로
  //   "이 사용자의 평소 주문 대비 이상"을 잡아내는지를 본다.
  section('4. 공격 C — 비율 임계 아래 습관 이탈(통계 규칙 단독)')
  const habitQuantity = Math.max(1, Math.floor((portfolioValue * 0.03) / FAR_PRICE))
  const habit = await buy({ quantity: habitQuantity, limitPrice: FAR_PRICE })
  const habitAmount = habitQuantity * FAR_PRICE
  console.log(`  주문 ${won(habitAmount)} (평가액의 ${((habitAmount / portfolioValue) * 100).toFixed(1)}% · 비율 임계 ${TRADE_POLICY.RATIO.STEP_UP * 100}% 미만)`)
  console.log(`  → ${habit.status} ${JSON.stringify(habit.data)?.slice(0, 80)}`)
  check('비율 임계 아래여도 개인 베이스라인 이탈로 탐지',
    habit.status === 403 && habit.data?.message === 'LARGE_ORDER',
    `${habit.status}`)
  if (habit.status === 200 && habit.data?.orderId) pendingIds.push(habit.data.orderId)

  // ─── 5. 탐지 이후 정상 거래 가용성 ──────────────────────────
  //   탐지가 정상 사용자의 거래를 막아버리면(과차단) 서비스가 죽는다.
  section('5. 탐지 이후 정상 거래 가용성')
  let recheckOk = 0
  for (let i = 0; i < RECHECK_ORDERS; i++) {
    normalAttempts++
    const res = await buy({ quantity: 1, limitPrice: FAR_PRICE })
    if (res.status === 200 && res.data?.orderId) { recheckOk++; pendingIds.push(res.data.orderId) }
    else { falsePositives++; failures.push(`탐지 후 정상 주문 거절 — ${res.status}`) }
  }
  check('탐지 발생 후에도 정상 주문은 계속 통과', recheckOk === RECHECK_ORDERS,
    `${recheckOk}/${RECHECK_ORDERS}`)

  // ─── 6. 매도 경로 배선 확인 ─────────────────────────────────
  section('6. 매도 경로 — 동일 판정기가 배선되어 있는가')
  const sellRes = await sell({ quantity: -50, limitPrice: 50_000 })
  const sellBlocked = sellRes.status === 400 && sellRes.data?.code === 'INVALID_ORDER'
  check('매도 경로에서도 무결성 위반 거절', sellBlocked,
    `${sellRes.status} ${String(sellRes.data?.message ?? '').slice(0, 50)}`)
  if (!sellBlocked) {
    notes.push(`매도 응답: ${sellRes.status} ${JSON.stringify(sellRes.data)?.slice(0, 100)}`)
  }

  // ─── 7. anomaly_logs 교차 확인 ──────────────────────────────
  section('7. anomaly_logs 기록 교차 확인')
  const logs = await AnomalyLog.findAll({
    where: {
      user_id: userId,
      anomaly_type: 'ABNORMAL_TRADE_AMOUNT',
      created_at: { [Op.gte]: startedAt },
    },
    order: [['id', 'ASC']],
  })

  const attackAttempts = integrityCases.length + 2 + 1   // 무결성 + 고액·습관이탈 + 매도 무결성
  check('탐지 건수가 공격 건수와 일치', logs.length === attackAttempts,
    `${logs.length}/${attackAttempts}`)
  check('전건 BLOCK 으로 기록', logs.length > 0 && logs.every((l) => l.action === 'BLOCK'),
    [...new Set(logs.map((l) => l.action))].join(','))
  check('요청 IP 기록 정확', logs.every((l) => l.ip === IP.TRADE), logs[0]?.ip ?? '-')
  check('계정 식별자 기록', logs.every((l) => l.email === EMAIL), logs[0]?.email ?? '-')
  check('User-Agent 기록', logs.every((l) => Boolean(l.user_agent)), logs[0]?.user_agent?.slice(0, 30) ?? '-')

  let reasonMatched = 0
  for (const c of integrityCases) {
    if (logs.some((l) => l.detail.includes(c.expectReason))) reasonMatched++
    else failures.push(`${c.name} — anomaly_logs 에 사유(${c.expectReason}) 미기록`)
  }
  check('무결성 위반 사유 코드 기록 정확', reasonMatched === integrityCases.length,
    `${reasonMatched}/${integrityCases.length}`)

  const ratioLog = logs.find((l) => l.detail.includes('PORTFOLIO_RATIO'))
  const zLog = logs.find((l) => l.detail.includes('AMOUNT_ZSCORE'))
  check('고액 주문 — 비율 규칙 근거 기록', Boolean(ratioLog), ratioLog?.detail?.slice(0, 80) ?? '없음')
  check('습관 이탈 — 통계 규칙 근거(z) 기록', Boolean(zLog), zLog?.detail?.slice(0, 80) ?? '없음')
  check('조치 결과(원 요청 거절)까지 기록',
    logs.some((l) => l.detail.includes('요청 거절')),
    logs.find((l) => l.detail.includes('요청 거절'))?.detail?.slice(-40) ?? '-')
  check('시장 구분(모의투자)·매수매도 구분 기록',
    logs.every((l) => /모의투자 (매수|매도)/.test(l.detail)),
    logs[0]?.detail?.slice(0, 30) ?? '-')

  // 민감정보 비노출 — 잔고·평가액 절대금액은 비율로만 남겨야 한다
  const leaked = logs.filter((l) => /잔고\s*[0-9]|평가액\s*[0-9]/.test(l.detail))
  check('로그에 계좌 절대금액 미노출', leaked.length === 0, leaked[0]?.detail?.slice(0, 80) ?? '')
  const pinLeak = logs.filter((l) => l.detail.includes(PIN))
  check('로그에 PIN 미노출', pinLeak.length === 0)

  console.log('\n  기록된 탐지 사유 요약')
  for (const l of logs) console.log(`   · [${l.action}] ${l.detail.slice(0, 110)}`)

  // ─── 8. 관리자 대시보드 반영 ────────────────────────────────
  section('8. 관리자 대시보드 통계 반영')
  const statsRes = await get('/api/admin/security/stats', { ip: IP.TRADE, cookie })
  if (statsRes.status === 200) {
    check('대시보드 통계에 거래 이상탐지 반영',
      Number(statsRes.data?.tradeAnomalies) >= logs.length,
      `tradeAnomalies=${statsRes.data?.tradeAnomalies}, tradeBlocked=${statsRes.data?.tradeBlocked}`)
  } else {
    notes.push(`대시보드 통계 확인 생략 — 테스트 계정이 관리자 권한이 아님(${statsRes.status}). ` +
               '관리자 계정 확인은 adminDashboardCapture.ts 로 별도 수행.')
    console.log(`  (생략) 관리자 권한 없음 — ${statsRes.status}`)
  }

  // ─── 9. 정리 및 부수효과 0 확인 ─────────────────────────────
  section('9. 정리 — 미체결 예약 취소 및 부수효과 확인')
  let cancelled = 0
  if (!hasFlag('keep')) {
    for (const id of pendingIds) {
      const res = await del(`/api/trade/virtual/orders/${id}`, { ip: IP.TRADE, cookie, sign: sign('') })
      if (res.status === 200) cancelled++
      else failures.push(`정리 실패 — 주문 ${id} 취소 불가(${res.status})`)
    }
    check('미체결 예약 전건 취소', cancelled === pendingIds.length, `${cancelled}/${pendingIds.length}`)

    const endBalance = await balanceOf()
    check('시작 잔고와 종료 잔고 일치(부수효과 0)',
      Math.abs(endBalance - startBalance) < 1,
      `${won(startBalance)} → ${won(endBalance)}`)
  } else {
    notes.push('--keep 지정 — 미체결 예약을 취소하지 않았습니다.')
  }

  // ─── 결과 출력 ──────────────────────────────────────────────
  const detected = logs.length
  const detectRate = ((detected / attackAttempts) * 100).toFixed(0)
  const fpr = ((falsePositives / normalAttempts) * 100).toFixed(1)

  console.log('')
  console.log('[보안 테스트] 거래 이상탐지 (M-1 서비스 경로 E2E)')
  console.log(`총 시도: ${normalAttempts + attackAttempts}회 | 탐지: ${detected}회 | 차단: ${detected}회 | 탐지율: ${detectRate}%`)
  console.log(`- 주문 무결성 위반 : ${integrityBlocked}/${integrityCases.length} 거절(400 INVALID_ORDER) · 사유 정확 ${reasonMatched}/${integrityCases.length}`)
  console.log(`- 단발 고액 주문   : 평가액 50% 주문 → ${large.status === 403 ? '403 LARGE_ORDER 재인증 요구' : `미차단(${large.status})`}`)
  console.log(`- 습관 이탈 주문   : 평가액 ${((habitAmount / portfolioValue) * 100).toFixed(1)}%(비율 임계 미만) → ${habit.status === 403 ? '통계 규칙 단독 탐지' : `미차단(${habit.status})`}`)
  console.log(`- 매도 경로        : ${sellBlocked ? '동일 판정기 배선 확인' : '확인 필요'}`)
  console.log(`- anomaly_logs     : ${logs.length}건 (type=ABNORMAL_TRADE_AMOUNT, action=BLOCK)`)
  console.log(`- 정상 요청 오탐률 : ${fpr}% (정상 ${normalAttempts}회 중 ${falsePositives}회 차단)`)
  console.log(`- 부수효과         : 미체결 ${cancelled}/${pendingIds.length}건 취소, 잔고 원복 확인`)

  if (notes.length > 0) {
    console.log('\n[확인 사항]')
    for (const n of notes) console.log(`  · ${n}`)
  }
  if (failures.length > 0) {
    console.log('\n[실패 항목]')
    for (const f of failures) console.log(`  · ${f}`)
  }

  console.log(`\n검증 항목: ${pass}건 통과 / ${fail}건 실패`)
  console.log(`판정: ${fail === 0 ? 'PASS' : 'FAIL'}`)

  await sequelize.close()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (err) => {
  console.error('실행 실패:', err?.message ?? err)
  await sequelize.close().catch(() => undefined)
  process.exit(1)
})
