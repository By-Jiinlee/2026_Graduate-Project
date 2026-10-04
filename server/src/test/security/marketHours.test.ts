/**
 * [검증] 모의투자 장 운영 시간 — 한국투자증권(KRX 정규장) 기준
 *
 *   1) 장 상태 판정 — 개장·마감 경계(08:59/09:00/15:29/15:30), 휴장일·주말 연휴를 건너뛴 다음 개장
 *   2) 휴장일 출처 장애 — KIS 조회 실패 시 주말 규칙으로 물러남(문서화된 동작)
 *   3) 주문 접수 — 장 외 주문은 409 MARKET_CLOSED 로 거부되고 PIN 검증·이상탐지까지 가지 않는다
 *   4) 당일 유효 — 장 마감 후 미체결 지정가는 자동 취소, 매수 예약금(수수료 포함) 환불, 장 외 체결 없음
 *   5) 해제 스위치 — MOCK_MARKET_HOURS=off 면 기존처럼 24시간
 *
 * 휴장일 데이터는 2026-09-30 에 KIS 국내휴장일조회(CTCA0903R)로 실제 받은 응답과 같은 값을 쓴다
 * (10/3 토·10/4 일·10/5 개천절 대체휴일·10/9 한글날 휴장). DB·KIS 에 접속하지 않는다.
 *
 * 실행: cd server && npx ts-node src/test/security/marketHours.test.ts
 */
import sequelize from '../../config/database'
import VirtualOrder from '../../models/trade/VirtualOrder'
import VirtualAccount from '../../models/trade/VirtualAccount'
import {
  assertMarketOpen,
  calendarSource,
  getMarketSession,
  MarketClosedError,
  resetCalendarCache,
  warmCalendar,
} from '../../services/market/marketCalendar'
import { isExpiredDayOrder, processPendingOrders } from '../../schedulers/trade/limitOrderScheduler'
import { buyStock } from '../../controllers/trade/virtualTradeController'

/* eslint-disable @typescript-eslint/no-var-requires */
const TRADE: any = require('../../services/trade/virtualTradeService')
const CHANNEL: any = require('../../services/socket/userChannel')

const checks: { name: string; ok: boolean; detail: string }[] = []
const check = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail })

// KST 시각 → Date
const kst = (y: number, m: number, d: number, hh: number, mm: number) => new Date(Date.UTC(y, m - 1, d, hh - 9, mm))
const fmt = (d: Date) => {
  const k = new Date(d.getTime() + 9 * 3_600_000)
  return `${k.getUTCMonth() + 1}/${k.getUTCDate()} ${String(k.getUTCHours()).padStart(2, '0')}:${String(k.getUTCMinutes()).padStart(2, '0')}`
}

// 2026-09-30 KIS 실응답과 같은 개장 여부
const KIS_ROWS = [
  [20260930, 'Y'], [20261001, 'Y'], [20261002, 'Y'], [20261003, 'N'], [20261004, 'N'], [20261005, 'N'],
  [20261006, 'Y'], [20261007, 'Y'], [20261008, 'Y'], [20261009, 'N'], [20261010, 'N'], [20261011, 'N'],
  [20261012, 'Y'], [20261013, 'Y'],
].map(([day, yn]) => ({ day: Number(day), open: yn === 'Y' }))

let fetchCalls = 0
const useKis = () => { calendarSource.fetch = async () => { fetchCalls++; return KIS_ROWS } }

async function main() {
  console.log('\n[검증] 모의투자 장 운영 시간 (KRX 정규장 · KIS 휴장일)')
  process.env.MOCK_MARKET_HOURS = 'on'

  // ═════ 1) 장 상태 판정 ═══════════════════════════════════════
  resetCalendarCache(); useKis()
  const cases: [string, Date, string, string][] = [
    ['수 08:59 개장 전', kst(2026, 10, 7, 8, 59), 'BEFORE_OPEN', '10/7 09:00'],
    ['수 09:00 개장', kst(2026, 10, 7, 9, 0), 'OPEN', '10/8 09:00'],
    ['수 15:29 장 중', kst(2026, 10, 7, 15, 29), 'OPEN', '10/8 09:00'],
    ['수 15:30 마감', kst(2026, 10, 7, 15, 30), 'AFTER_CLOSE', '10/8 09:00'],
    ['금 16:00 → 토·일·개천절 대체휴일 건너뜀', kst(2026, 10, 2, 16, 0), 'AFTER_CLOSE', '10/6 09:00'],
    ['월 10:00 개천절 대체휴일', kst(2026, 10, 5, 10, 0), 'HOLIDAY', '10/6 09:00'],
    ['목 15:30 → 한글날·주말 건너뜀', kst(2026, 10, 8, 15, 30), 'AFTER_CLOSE', '10/12 09:00'],
    ['토 11:00 주말', kst(2026, 10, 10, 11, 0), 'HOLIDAY', '10/12 09:00'],
    ['자정 00:00 (KST 날짜 경계)', kst(2026, 10, 6, 0, 0), 'BEFORE_OPEN', '10/6 09:00'],
  ]
  for (const [name, now, state, next] of cases) {
    const s = await getMarketSession(now)
    check(`장 상태: ${name}`, s.state === state && fmt(s.nextOpen) === next, `${s.state} · 다음 개장 ${fmt(s.nextOpen)}`)
  }
  check('휴장일 조회는 캐시 — 9회 판정에 KIS 호출 1회', fetchCalls === 1, `호출 ${fetchCalls}회`)

  // ═════ 2) 휴장일 출처 장애 ═══════════════════════════════════
  resetCalendarCache()
  calendarSource.fetch = async () => { throw new Error('KIS 장애(모의)') }
  const errLog = console.error
  console.error = () => undefined
  const holidayDuringOutage = await getMarketSession(kst(2026, 10, 5, 10, 0))
  const weekendDuringOutage = await getMarketSession(kst(2026, 10, 10, 11, 0))
  console.error = errLog
  check('조회 실패 시 평일 공휴일은 장 중으로 판정(주말 규칙으로 물러남)', holidayDuringOutage.state === 'OPEN', holidayDuringOutage.state)
  check('조회 실패 시에도 주말은 휴장', weekendDuringOutage.state === 'HOLIDAY', weekendDuringOutage.state)

  // ═════ 3) 주문 접수 ══════════════════════════════════════════
  resetCalendarCache(); useKis()
  let pinCalls = 0
  TRADE.verifyPin = async () => { pinCalls++ }
  TRADE.getOrderValuation = async () => { throw new Error('도달하면 안 됨') }
  const realNow = Date.now
  const callBuy = async (now: Date) => {
    Date.now = () => now.getTime()
    const res: any = { statusCode: 200, body: null, status(c: number) { this.statusCode = c; return this }, json(b: any) { this.body = b; return this } }
    await buyStock({ user: { id: 32 }, body: { stockId: 1, stockCode: '005930', quantity: 1, orderType: 'market', pin: '123456' }, headers: {}, socket: {} } as any, res)
    Date.now = realNow
    return res
  }
  // assertMarketOpen 은 기본 인자로 new Date() 를 쓰므로 Date.now 고정만으로는 부족하다 — 시각을 직접 넘겨 확인
  let closedErr: unknown = null
  try { await assertMarketOpen(kst(2026, 10, 5, 10, 0)) } catch (e) { closedErr = e }
  check('휴장일 주문 거부(MarketClosedError)', closedErr instanceof MarketClosedError,
    closedErr instanceof Error ? closedErr.message : '')
  check('거부 메시지에 다음 개장 시각', closedErr instanceof Error && closedErr.message.includes('10/6(화) 09:00'))
  let openErr: unknown = null
  try { await assertMarketOpen(kst(2026, 10, 7, 10, 0)) } catch (e) { openErr = e }
  check('장 중 주문 허용', openErr === null)

  // 컨트롤러 — 실제 시계 기준이므로, 지금이 장 중이면 휴장으로 고정한 달력으로 바꿔 장 외 상황을 만든다
  calendarSource.fetch = async () => [{ day: Number(new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10).replace(/-/g, '')), open: false }]
  resetCalendarCache()
  const r = await callBuy(new Date())
  check('컨트롤러: 장 외 주문 409 MARKET_CLOSED', r.statusCode === 409 && r.body?.code === 'MARKET_CLOSED', `${r.statusCode} ${r.body?.code}`)
  check('컨트롤러: 장 외 주문은 PIN 검증까지 가지 않음', pinCalls === 0, `PIN 호출 ${pinCalls}회`)

  // ═════ 4) 당일 유효 — 장 마감 후 만료 ═════════════════════════
  resetCalendarCache(); useKis()
  await warmCalendar(kst(2026, 10, 7, 0, 0))
  type P = { id: number; user_id: number; stock_id: number; stock_code: string; side: 'buy' | 'sell'; quantity: number; price: number; total_amount: number; ordered_at: string; status: string }
  let pending: P[] = []
  const balances = new Map<number, number>()
  const emitted: string[] = []
  ;(sequelize as any).query = async () => pending.filter((p) => p.status === 'pending').map((p) => ({ ...p }))
  ;(sequelize as any).transaction = async () => ({ commit: async () => undefined, rollback: async () => undefined })
  ;(VirtualOrder as any).findByPk = async (id: number) => {
    const o = pending.find((p) => p.id === id)
    return o ? { ...o, update: async (u: any) => Object.assign(o, u) } : null
  }
  ;(VirtualAccount as any).findOne = async ({ where }: any) => ({
    seed_balance: balances.get(where.user_id) ?? 0,
    update: async (u: any) => balances.set(where.user_id, Number(u.seed_balance)),
  })
  CHANNEL.emitToUser = (_uid: number, ev: string) => emitted.push(ev)
  CHANNEL.emitOrderFilled = () => emitted.push('order:filled')
  const settle = () => new Promise((res) => setTimeout(res, 50))
  const log = console.log
  console.log = () => undefined

  const seedOrders = () => {
    pending = [
      { id: 1, user_id: 7, stock_id: 1, stock_code: '005930', side: 'buy', quantity: 10, price: 70000, total_amount: 700105, ordered_at: kst(2026, 10, 7, 10, 0).toISOString(), status: 'pending' },
      { id: 2, user_id: 7, stock_id: 1, stock_code: '005930', side: 'sell', quantity: 5, price: 90000, total_amount: 450000, ordered_at: kst(2026, 10, 7, 11, 0).toISOString(), status: 'pending' },
      { id: 3, user_id: 8, stock_id: 2, stock_code: '000660', side: 'buy', quantity: 1, price: 100000, total_amount: 100015, ordered_at: kst(2026, 10, 6, 14, 0).toISOString(), status: 'pending' },
    ]
    balances.set(7, 1_000_000); balances.set(8, 0)
    emitted.length = 0
  }

  seedOrders()
  await processPendingOrders(kst(2026, 10, 7, 15, 31)); await settle()
  check('마감 후 미체결 전부 취소', pending.every((p) => p.status === 'cancelled'), pending.map((p) => `${p.id}:${p.status}`).join(' '))
  check('매수 예약금(수수료 포함) 환불', balances.get(7) === 1_000_000 + 700105 && balances.get(8) === 100015, `user7 ${balances.get(7)} · user8 ${balances.get(8)}`)
  check('매도 취소는 예수금 변화 없음(보유 수량을 잡아 두지 않음)', balances.get(7) === 1_700_105)
  check('만료 알림 전송, 체결 알림 없음', emitted.filter((e) => e === 'order:expired').length === 3 && !emitted.includes('order:filled'), emitted.join(','))

  seedOrders()
  await processPendingOrders(kst(2026, 10, 7, 10, 30)); await settle()
  check('장 중: 전 영업일 주문만 만료', pending.find((p) => p.id === 3)!.status === 'cancelled' && pending.find((p) => p.id === 1)!.status === 'pending',
    pending.map((p) => `${p.id}:${p.status}`).join(' '))

  seedOrders()
  await processPendingOrders(kst(2026, 10, 5, 10, 0)); await settle()
  check('휴장일: 체결 없이 만료만', pending.every((p) => p.status === 'cancelled') && !emitted.includes('order:filled'))
  console.log = log

  // 경계 순수 판정
  const s = await getMarketSession(kst(2026, 10, 7, 9, 0))
  check('개장 09:00 정각 주문은 당일 주문', !isExpiredDayOrder(kst(2026, 10, 7, 9, 0).toISOString(), s))
  check('개장 1초 전 주문은 전일 주문으로 만료', isExpiredDayOrder(new Date(kst(2026, 10, 7, 9, 0).getTime() - 1000).toISOString(), s))

  // ═════ 5) 해제 스위치 ════════════════════════════════════════
  process.env.MOCK_MARKET_HOURS = 'off'
  let offErr: unknown = null
  try { await assertMarketOpen(kst(2026, 10, 5, 3, 0)) } catch (e) { offErr = e }
  check('MOCK_MARKET_HOURS=off: 휴장일 새벽 주문 허용', offErr === null)
  seedOrders()
  await processPendingOrders(kst(2026, 10, 5, 3, 0)); await settle()
  check('MOCK_MARKET_HOURS=off: 만료 처리 없음', pending.every((p) => p.status === 'pending'))

  // ── 출력 ─────────────────────────────────────────────────────
  const failed = checks.filter((c) => !c.ok)
  for (const c of checks) console.log(`  ${c.ok ? '✔' : '✘'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`)
  console.log(`검증 항목: ${checks.length - failed.length}건 통과 / ${failed.length}건 실패`)
  console.log(`판정: ${failed.length === 0 ? 'PASS' : 'FAIL'}`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('검증 실행 오류:', err)
  process.exit(1)
})
