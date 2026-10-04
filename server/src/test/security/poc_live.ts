/**
 * [QA PoC] 라이브 DB 연동 검증 — 단위 테스트가 다루지 않은 "DB 로더 + 영속화(anomaly_logs 생성)"를
 * 실제 서비스 함수로 끝까지 태워본다. 실행 결과로 anomaly_logs/behavior_profiles/trusted_devices 에
 * 실제 행이 생기므로 관리자 대시보드에서도 바로 확인할 수 있다.
 *
 * ⚠️ 안전장치
 *   · TEST_USER_ID (일회용 QA 계정 id) 를 반드시 지정해야 한다. 이 계정의 trusted_devices·
 *     behavior_profiles 는 PoC 가 덮어쓰고 마지막에 삭제하므로, 실사용 계정을 쓰면 안 된다.
 *   · 거래 주문은 전부 센티넬 IP(203.0.113.250)로 삽입하고, 끝에 그 IP 기준으로만 지운다
 *     → 해당 계정의 실제 주문/로그는 건드리지 않는다.
 *   · POC_KEEP=true 로 두면 대시보드 확인용으로 생성한 행을 남긴다(기본은 정리).
 *
 * 실행:
 *   cd server
 *   TEST_USER_ID=<일회용계정id> npx ts-node src/test/security/poc_live.ts
 *   TEST_USER_ID=<id> POC_KEEP=true npx ts-node src/test/security/poc_live.ts   # 대시보드 확인용으로 남김
 *   TEST_USER_ID=<id> POC_STOCK=005930 npx ts-node src/test/security/poc_live.ts # 종목 지정
 */
import { QueryTypes } from 'sequelize'
import sequelize from '../../config/database'
import VirtualOrder from '../../models/trade/VirtualOrder'
import AnomalyLog from '../../models/auth/AnomalyLog'
import TrustedDevice from '../../models/auth/TrustedDevice'
import BehaviorProfile from '../../models/auth/BehaviorProfile'
import { evaluateTradeRequest, loadCancelPattern, loadSelfChurn, loadOrderIntervals } from '../../services/auth/tradeAnomalyService'
import { processLoginBehavior, type RawBehavior } from '../../services/auth/behaviorProfileService'
import { recordBiometricMismatch, recordDeviceFingerprintMismatch } from '../../services/auth/anomalyService'
import { registerTrustedDevice, verifyTrustedDevice, revokeAllTrustedDevices } from '../../services/auth/trustedDeviceService'

const SENTINEL_IP = '203.0.113.250'
const PC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 PoC'
const KEEP = process.env.POC_KEEP === 'true'

let pass = 0, fail = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass++; console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`) }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`) }
}

async function resolveUser(): Promise<number> {
  const raw = process.env.TEST_USER_ID
  if (!raw) {
    console.error('❌ TEST_USER_ID 환경변수가 필요합니다(일회용 QA 계정 id). 실사용 계정 금지.')
    console.error('   예: TEST_USER_ID=42 npx ts-node src/test/security/poc_live.ts')
    process.exit(2)
  }
  const id = Number(raw)
  const rows = await sequelize.query<{ id: number; email: string }>(
    'SELECT id, email FROM users WHERE id = :id',
    { replacements: { id }, type: QueryTypes.SELECT },
  )
  if (!rows.length) { console.error(`❌ users 에 id=${id} 가 없습니다.`); process.exit(2) }
  console.log(`대상 계정: id=${id} (${rows[0].email})  — trusted_devices/behavior_profiles 는 덮어쓰고 정리됨`)
  return id
}

async function resolveStock(): Promise<{ id: number; code: string }> {
  const code = process.env.POC_STOCK
  const rows = code
    ? await sequelize.query<{ id: number; code: string }>('SELECT id, code FROM stocks WHERE code = :code LIMIT 1', { replacements: { code }, type: QueryTypes.SELECT })
    : await sequelize.query<{ id: number; code: string }>('SELECT id, code FROM stocks ORDER BY id LIMIT 1', { type: QueryTypes.SELECT })
  if (!rows.length) { console.error('❌ stocks 테이블에서 종목을 찾지 못했습니다.'); process.exit(2) }
  return rows[0]
}

async function clearSentinelOrders(userId: number): Promise<void> {
  await sequelize.query('DELETE FROM virtual_orders WHERE user_id = :userId AND ip_address = :ip',
    { replacements: { userId, ip: SENTINEL_IP } })
}

async function insertOrder(opts: {
  userId: number; stockId: number; side: 'buy' | 'sell'; type: 'market' | 'limit'
  status: 'pending' | 'filled' | 'cancelled'; orderedAt: Date; cancelledAt?: Date; price?: number; qty?: number
}): Promise<void> {
  const price = opts.price ?? 10000
  const qty = opts.qty ?? 10
  await VirtualOrder.create({
    user_id: opts.userId, stock_id: opts.stockId, order_type: opts.type, side: opts.side,
    quantity: qty, price, total_amount: price * qty, status: opts.status,
    ip_address: SENTINEL_IP, ordered_at: opts.orderedAt,
    filled_at: opts.status === 'filled' ? opts.orderedAt : undefined,
    cancelled_at: opts.cancelledAt,
  } as any)
}

// 진단 — 삽입된 센티넬 주문이 실제로 DB에 있고 로더 조건에 걸리는지 눈으로 확인한다.
async function dbgSentinelRows(userId: number): Promise<void> {
  const rows = await sequelize.query<any>(
    `SELECT o.side, o.order_type, o.status, o.ordered_at, o.cancelled_at, s.code
       FROM virtual_orders o JOIN stocks s ON s.id = o.stock_id
      WHERE o.user_id = :userId AND o.ip_address = :ip ORDER BY o.id DESC LIMIT 12`,
    { replacements: { userId, ip: SENTINEL_IP }, type: QueryTypes.SELECT },
  )
  console.log(`   [진단] 센티넬 주문 ${rows.length}건:`, JSON.stringify(rows))
}

// 진단 — 윈도우 비교의 타임존 skew 를 한 줄로 드러낸다.
// db_now(=MySQL 현재시각), sent_ws(=로더가 보내는 windowStart 가 MySQL 에 보이는 값),
// mn/mx(=저장된 ordered_at 범위), in_window(=ordered_at >= sent_ws 를 만족하는 건수)
async function dbgWindow(userId: number): Promise<void> {
  const ws = new Date(Date.now() - 3600_000)
  const rows = await sequelize.query<any>(
    `SELECT NOW() AS db_now, :ws AS sent_ws,
            COUNT(*) AS total,
            SUM(ordered_at >= :ws) AS in_window,
            MIN(ordered_at) AS mn, MAX(ordered_at) AS mx
       FROM virtual_orders WHERE user_id = :userId AND ip_address = :ip`,
    { replacements: { userId, ip: SENTINEL_IP, ws }, type: QueryTypes.SELECT },
  )
  console.log('   [진단-윈도우]', JSON.stringify(rows[0]))
}

async function countAnomalies(userId: number, type: string): Promise<number> {
  const rows = await sequelize.query<{ c: number }>(
    'SELECT COUNT(*) AS c FROM anomaly_logs WHERE user_id = :userId AND anomaly_type = :type AND ip = :ip',
    { replacements: { userId, type, ip: SENTINEL_IP }, type: QueryTypes.SELECT },
  )
  return Number(rows[0]?.c ?? 0)
}

async function main(): Promise<void> {
  await sequelize.authenticate()
  const userId = await resolveUser()
  const stock = await resolveStock()
  console.log(`대상 종목: ${stock.code} (id=${stock.id})\n`)
  const now = Date.now()

  // ───────────────────────────────────────────────────────────
  // Phase 1 — 거래 봇 / 시장 조작 (DB 로더 + 기록 경로)
  // ───────────────────────────────────────────────────────────
  console.log('── Phase 1-A: 허수주문(SPOOFING_ORDER) ──')
  await clearSentinelOrders(userId)
  for (let i = 0; i < 4; i++) {
    const t = new Date(now - i * 60_000) // 최근 1시간 내
    await insertOrder({ userId, stockId: stock.id, side: 'buy', type: 'limit', status: 'cancelled', orderedAt: t, cancelledAt: new Date(t.getTime() + 500) }) // 0.5초 만에 취소 = 단명
  }
  await dbgSentinelRows(userId)
  await dbgWindow(userId)
  console.log('   [진단] loadCancelPattern:', JSON.stringify(await loadCancelPattern(userId, 'virtual')))
  {
    const before = await countAnomalies(userId, 'SPOOFING_ORDER')
    const a = await evaluateTradeRequest({ userId, ip: SENTINEL_IP, userAgent: PC_UA, market: 'virtual', side: 'buy', stockCode: stock.code, quantity: 10, price: 10000, portfolioValue: null, hasSignature: false })
    check('assessTrade 신호에 SPOOFING_ORDER 포함', a.signals.includes('SPOOFING_ORDER'), a.signals.join(',') || '없음')
    check('관측이므로 verdict=ALLOW(주문 진행)', a.verdict === 'ALLOW', a.verdict)
    const after = await countAnomalies(userId, 'SPOOFING_ORDER')
    check('anomaly_logs 에 SPOOFING_ORDER 기록 생성', after > before, `${before}→${after}`)
  }

  console.log('\n── Phase 1-B: 자전거래(WASH_TRADE) ──')
  await clearSentinelOrders(userId)
  for (let i = 0; i < 2; i++) {
    await insertOrder({ userId, stockId: stock.id, side: 'buy', type: 'market', status: 'filled', orderedAt: new Date(now - i * 60_000) })
    await insertOrder({ userId, stockId: stock.id, side: 'sell', type: 'market', status: 'filled', orderedAt: new Date(now - i * 60_000 - 30_000) })
  }
  await dbgSentinelRows(userId)
  console.log('   [진단] loadSelfChurn:', JSON.stringify(await loadSelfChurn(userId, 'virtual', stock.code)))
  {
    const before = await countAnomalies(userId, 'WASH_TRADE')
    const a = await evaluateTradeRequest({ userId, ip: SENTINEL_IP, userAgent: PC_UA, market: 'virtual', side: 'sell', stockCode: stock.code, quantity: 10, price: 10000, portfolioValue: null, hasSignature: false })
    check('assessTrade 신호에 WASH_TRADE 포함', a.signals.includes('WASH_TRADE'), a.signals.join(',') || '없음')
    const after = await countAnomalies(userId, 'WASH_TRADE')
    check('anomaly_logs 에 WASH_TRADE 기록 생성', after > before, `${before}→${after}`)
  }

  console.log('\n── Phase 1-C: 거래 자동화(BOT_TRADE_BEHAVIOR) ──')
  await clearSentinelOrders(userId)
  for (let i = 0; i < 7; i++) { // 정확히 30초 간격 7건 → 간격 변동계수 0
    await insertOrder({ userId, stockId: stock.id, side: 'buy', type: 'market', status: 'filled', orderedAt: new Date(now - i * 30_000) })
  }
  console.log('   [진단] loadOrderIntervals(ms):', JSON.stringify(await loadOrderIntervals(userId, 'virtual')))
  {
    const before = await countAnomalies(userId, 'BOT_TRADE_BEHAVIOR')
    const a = await evaluateTradeRequest({ userId, ip: SENTINEL_IP, userAgent: PC_UA, market: 'virtual', side: 'buy', stockCode: stock.code, quantity: 10, price: 10000, portfolioValue: null, hasSignature: false, behavior: { mouseMoveCount: 0, timeOnPage: 1500 } })
    check('assessTrade 신호에 BOT_TRADE_BEHAVIOR 포함', a.signals.includes('BOT_TRADE_BEHAVIOR'), a.signals.join(',') || '없음')
    const after = await countAnomalies(userId, 'BOT_TRADE_BEHAVIOR')
    check('anomaly_logs 에 BOT_TRADE_BEHAVIOR 기록 생성', after > before, `${before}→${after}`)
  }

  // ───────────────────────────────────────────────────────────
  // Phase 2 — 행동 생체인식 (behavior_profiles 누적 + 불일치)
  // ───────────────────────────────────────────────────────────
  console.log('\n── Phase 2: 행동 생체인식(BEHAVIOR_BIOMETRIC_MISMATCH) ──')
  await BehaviorProfile.destroy({ where: { user_id: userId } }) // 깨끗한 상태에서 시작
  const normal: RawBehavior = { mouseMoveCount: 45, avgTypingInterval: 210, timeOnPage: 4000, keyPressCount: 22 }
  let lastOutcome = ''
  for (let i = 0; i < 6; i++) { // 같은 리듬으로 6회 로그인 → 프로필 등록·수렴
    const r = await processLoginBehavior(userId, { ...normal, avgTypingInterval: 210 + (i % 3) * 5, mouseMoveCount: 45 + (i % 3) })
    lastOutcome = r.outcome
  }
  check('반복 로그인으로 프로필 등록됨', lastOutcome === 'match' || lastOutcome === 'enrolling', lastOutcome)
  {
    const prof = await BehaviorProfile.findByPk(userId)
    check('behavior_profiles 행 존재 + 표본 누적', !!prof && prof.sample_count >= 5, `sample_count=${prof?.sample_count}`)
  }
  {
    // 같은 사람 재방문 → 일치
    const same = await processLoginBehavior(userId, { ...normal, avgTypingInterval: 212, mouseMoveCount: 46 })
    check('같은 리듬: match(불일치 아님)', same.outcome === 'match', `${same.outcome} score=${same.score?.toFixed(2)}`)

    // 세션 탈취(전혀 다른 리듬) → 불일치
    const attacker: RawBehavior = { mouseMoveCount: 2, avgTypingInterval: 65, timeOnPage: 3000, keyPressCount: 24 }
    const mis = await processLoginBehavior(userId, attacker)
    check('다른 리듬: mismatch 판정', mis.outcome === 'mismatch', `${mis.outcome} score=${mis.score?.toFixed(2)}`)
    if (mis.outcome === 'mismatch') {
      const before = await countAnomalies(userId, 'BEHAVIOR_BIOMETRIC_MISMATCH')
      await recordBiometricMismatch({ userId, email: '', ip: SENTINEL_IP, userAgent: PC_UA, detail: mis.detail })
      const after = await countAnomalies(userId, 'BEHAVIOR_BIOMETRIC_MISMATCH')
      check('anomaly_logs 에 BEHAVIOR_BIOMETRIC_MISMATCH 기록', after > before, `${before}→${after}`)
    }
    const prof2 = await BehaviorProfile.findByPk(userId)
    check('불일치 세션은 프로필 미갱신(오염 방지)', !!prof2, `sample_count=${prof2?.sample_count}`)
  }

  // ───────────────────────────────────────────────────────────
  // Phase 3 — 디바이스 핑거프린트 (지문 변화 시 신뢰 미파기)
  // ───────────────────────────────────────────────────────────
  console.log('\n── Phase 3: 디바이스 핑거프린트(DEVICE_FINGERPRINT_MISMATCH) ──')
  await revokeAllTrustedDevices(userId) // 깨끗한 상태
  const rawToken = await registerTrustedDevice(userId, PC_UA, SENTINEL_IP, 'COMPONENTS_HASH_A')
  {
    const ok = await verifyTrustedDevice(userId, rawToken, PC_UA, SENTINEL_IP, 'COMPONENTS_HASH_A')
    check('동일 컴포넌트: trusted=true, 불일치 아님', ok.trusted && !ok.componentMismatch, JSON.stringify(ok))

    const changed = await verifyTrustedDevice(userId, rawToken, PC_UA, SENTINEL_IP, 'COMPONENTS_HASH_B')
    check('컴포넌트 변경: trusted 유지 + componentMismatch=true', changed.trusted && changed.componentMismatch, JSON.stringify(changed))

    // ★ 핵심 불변식 — 불일치여도 기기 레코드가 삭제되지 않았는가
    const stillThere = await TrustedDevice.findOne({ where: { user_id: userId } })
    check('★ 지문 불일치에도 신뢰 기기 미삭제', !!stillThere)

    if (changed.componentMismatch) {
      const before = await countAnomalies(userId, 'DEVICE_FINGERPRINT_MISMATCH')
      await recordDeviceFingerprintMismatch({ userId, email: '', ip: SENTINEL_IP, userAgent: PC_UA })
      const after = await countAnomalies(userId, 'DEVICE_FINGERPRINT_MISMATCH')
      check('anomaly_logs 에 DEVICE_FINGERPRINT_MISMATCH 기록', after > before, `${before}→${after}`)
    }
  }

  // ───────────────────────────────────────────────────────────
  // 정리
  // ───────────────────────────────────────────────────────────
  if (KEEP) {
    console.log('\n[POC_KEEP=true] 생성 데이터 유지 — 관리자 대시보드에서 확인하세요.')
    console.log(`  정리하려면: TEST_USER_ID=${userId} POC_CLEANUP_ONLY=true npx ts-node src/test/security/poc_live.ts`)
  } else {
    await cleanup(userId)
    console.log('\n생성한 PoC 데이터 정리 완료(센티넬 IP 주문/로그 + 테스트 계정 프로필·기기).')
  }

  console.log(`\n검증 항목: ${pass}건 통과 / ${fail}건 실패`)
  if (fail > 0) { console.log('실패 목록: ' + failures.join(', ')) }
  console.log(`판정: ${fail === 0 ? 'PASS' : 'FAIL'}`)
  await sequelize.close()
  process.exit(fail === 0 ? 0 : 1)
}

async function cleanup(userId: number): Promise<void> {
  await sequelize.query('DELETE FROM anomaly_logs WHERE ip = :ip', { replacements: { ip: SENTINEL_IP } })
  await sequelize.query('DELETE FROM virtual_orders WHERE user_id = :userId AND ip_address = :ip', { replacements: { userId, ip: SENTINEL_IP } })
  await BehaviorProfile.destroy({ where: { user_id: userId } })
  await revokeAllTrustedDevices(userId)
}

// 정리만 수행하는 모드
if (process.env.POC_CLEANUP_ONLY === 'true') {
  ;(async () => {
    await sequelize.authenticate()
    const id = Number(process.env.TEST_USER_ID)
    if (!id) { console.error('TEST_USER_ID 필요'); process.exit(2) }
    await cleanup(id)
    console.log('정리 완료.')
    await sequelize.close()
    process.exit(0)
  })()
} else {
  main().catch(async (e) => {
    console.error('\n실행 실패:', e?.message ?? e)
    await sequelize.close().catch(() => {})
    process.exit(1)
  })
}
