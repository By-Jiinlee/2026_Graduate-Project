import axios from 'axios'
import { getKisAccessToken } from './KisAuth'

// ─────────────────────────────────────────────────────────────
// 모의투자 장 운영 시간 — 한국투자증권(KRX 정규장) 기준
//
// 이전에는 모의투자 주문·지정가 체결이 24시간 동작했다. 실제 증권사에서는 장이 닫힌 시간에
// 시장가 주문이 체결될 수 없고, 휴장일에는 시세 자체가 없다. 초보자가 실제 투자 환경을 연습하는
// 서비스이므로 장 운영 규칙을 실제와 맞춘다.
//
//   - 정규장: 영업일 09:00 ~ 15:30 (KST). 이 시간에만 주문을 받고 체결한다.
//   - 영업일: 한국투자증권 국내휴장일조회(CTCA0903R)의 개장일 여부(opnd_yn). 하루 한 번 받아
//     24일치를 캐시한다 — KIS 는 이 API 를 하루 1회 정도로 호출하도록 안내한다.
//   - 지정가 주문은 당일 유효: 장이 끝날 때까지 체결되지 않으면 자동 취소한다(limitOrderScheduler).
//   - 시간외 단일가·시간외 종가·대체거래소(NXT) 시간대와 예약주문은 다루지 않는다.
//
// 휴장일 조회에 실패하면 주말만 휴장으로 보는 규칙으로 물러난다. 모의 자금이라 공휴일에 한 번
// 주문이 체결되는 피해보다 장 중인데 주문이 막히는 피해가 크다고 판단했고, 물러난 사실은 로그로 남긴다.
// MOCK_MARKET_HOURS=off 로 끌 수 있다(야간 시연·자동화 검증용).
// ─────────────────────────────────────────────────────────────

export const MARKET_HOURS = {
  OPEN_MIN: 9 * 60,          // 09:00
  CLOSE_MIN: 15 * 60 + 30,   // 15:30
} as const

const KST_MS = 9 * 3_600_000
const DAY_MS = 86_400_000

export const isMarketHoursEnforced = (): boolean => process.env.MOCK_MARKET_HOURS !== 'off'

export const kstDayKey = (d: Date): number => {
  const k = new Date(d.getTime() + KST_MS)
  return k.getUTCFullYear() * 10_000 + (k.getUTCMonth() + 1) * 100 + k.getUTCDate()
}

const kstMinuteOfDay = (d: Date): number => {
  const k = new Date(d.getTime() + KST_MS)
  return k.getUTCHours() * 60 + k.getUTCMinutes()
}

// 그 날(KST) 00:00 의 UTC 시각 + 분
const kstAt = (day: number, minute: number): Date => {
  const y = Math.floor(day / 10_000)
  const m = Math.floor(day / 100) % 100
  const dd = day % 100
  return new Date(Date.UTC(y, m - 1, dd) - KST_MS + minute * 60_000)
}

const isWeekendDay = (day: number): boolean => {
  const w = kstAt(day, 0 + 12 * 60).getUTCDay() // 정오 기준으로 요일 계산(UTC 경계 회피)
  return w === 0 || w === 6
}

// ─── 휴장일 캐시 ──────────────────────────────────────────────
export interface CalendarRow { day: number; open: boolean }

// 휴장일 출처. 검증 스크립트가 바꿔 끼울 수 있게 객체로 둔다.
export const calendarSource = {
  fetch: async (fromDay: number): Promise<CalendarRow[]> => {
    const token = await getKisAccessToken()
    const res = await axios.get(
      'https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/chk-holiday',
      {
        headers: {
          authorization: `Bearer ${token}`,
          appkey: process.env.KIS_REAL_APP_KEY!,
          appsecret: process.env.KIS_REAL_APP_SECRET!,
          tr_id: 'CTCA0903R',
          custtype: 'P',
          'content-type': 'application/json',
        },
        params: { BASS_DT: String(fromDay), CTX_AREA_NK: '', CTX_AREA_FK: '' },
        timeout: 10_000,
      },
    )
    if (res.data?.rt_cd !== '0' || !Array.isArray(res.data?.output)) {
      throw new Error(`휴장일 조회 실패: ${res.data?.msg1 ?? res.status}`)
    }
    return res.data.output
      .filter((r: any) => /^\d{8}$/.test(r?.bass_dt) && (r?.opnd_yn === 'Y' || r?.opnd_yn === 'N'))
      .map((r: any) => ({ day: Number(r.bass_dt), open: r.opnd_yn === 'Y' }))
  },
}

const openDays = new Map<number, boolean>()
let lastFailureAt = 0
const RETRY_AFTER_FAILURE_MS = 10 * 60_000
let inflight: Promise<void> | null = null

export const resetCalendarCache = (): void => {
  openDays.clear()
  lastFailureAt = 0
  inflight = null
}

export async function refreshCalendar(fromDay: number): Promise<boolean> {
  if (Date.now() - lastFailureAt < RETRY_AFTER_FAILURE_MS) return false
  if (!inflight) {
    inflight = calendarSource
      .fetch(fromDay)
      .then((rows) => {
        for (const r of rows) openDays.set(r.day, r.open)
      })
      .catch((err) => {
        lastFailureAt = Date.now()
        console.error('[MarketCalendar] 휴장일 조회 실패 — 주말만 휴장으로 판정:', err?.message ?? err)
      })
      .finally(() => {
        inflight = null
      })
  }
  await inflight
  return openDays.has(fromDay)
}

// 캐시에 없으면 주말 규칙으로 판정한다(동기 — 5초 체결 루프에서 쓴다).
export const isTradingDayCached = (day: number): boolean => openDays.get(day) ?? !isWeekendDay(day)

export async function isTradingDay(day: number): Promise<boolean> {
  if (!openDays.has(day)) await refreshCalendar(day)
  return isTradingDayCached(day)
}

// ─── 장 상태 ──────────────────────────────────────────────────
export type SessionState = 'OPEN' | 'BEFORE_OPEN' | 'AFTER_CLOSE' | 'HOLIDAY'

export interface MarketSession {
  state: SessionState
  open: boolean
  day: number
  todayOpen: Date
  todayClose: Date
  nextOpen: Date
}

const sessionFrom = (now: Date, isTrading: (day: number) => boolean): MarketSession => {
  const day = kstDayKey(now)
  const minute = kstMinuteOfDay(now)
  const trading = isTrading(day)
  let state: SessionState
  if (!trading) state = 'HOLIDAY'
  else if (minute < MARKET_HOURS.OPEN_MIN) state = 'BEFORE_OPEN'
  else if (minute < MARKET_HOURS.CLOSE_MIN) state = 'OPEN'
  else state = 'AFTER_CLOSE'

  // 다음 개장 — 오늘 개장 전이면 오늘 09:00, 아니면 다음 영업일 09:00
  let nextOpen = kstAt(day, MARKET_HOURS.OPEN_MIN)
  if (state !== 'BEFORE_OPEN') {
    let d = day
    for (let i = 0; i < 31; i++) {
      d = kstDayKey(new Date(kstAt(d, 12 * 60).getTime() + DAY_MS))
      if (isTrading(d)) break
    }
    nextOpen = kstAt(d, MARKET_HOURS.OPEN_MIN)
  }
  return {
    state, open: state === 'OPEN', day,
    todayOpen: kstAt(day, MARKET_HOURS.OPEN_MIN),
    todayClose: kstAt(day, MARKET_HOURS.CLOSE_MIN),
    nextOpen,
  }
}

// 동기 판정(캐시 기준) — 체결 스케줄러용
export const getMarketSessionCached = (now = new Date()): MarketSession => sessionFrom(now, isTradingDayCached)

// 주문 접수용 — 오늘·다음 영업일이 캐시에 없으면 먼저 받아 온다
export async function getMarketSession(now = new Date()): Promise<MarketSession> {
  const day = kstDayKey(now)
  if (!openDays.has(day)) await refreshCalendar(day)
  return sessionFrom(now, isTradingDayCached)
}

export class MarketClosedError extends Error {
  readonly nextOpen: Date
  readonly state: SessionState
  constructor(session: MarketSession) {
    const k = new Date(session.nextOpen.getTime() + KST_MS)
    const label = `${k.getUTCMonth() + 1}/${k.getUTCDate()}(${'일월화수목금토'[k.getUTCDay()]}) 09:00`
    const why = session.state === 'HOLIDAY' ? '오늘은 휴장일입니다' : '정규장 시간(09:00~15:30)이 아닙니다'
    super(`${why}. 모의투자 주문은 정규장에만 가능합니다. 다음 개장: ${label}`)
    this.name = 'MarketClosedError'
    this.nextOpen = session.nextOpen
    this.state = session.state
  }
}

export async function assertMarketOpen(now = new Date()): Promise<void> {
  if (!isMarketHoursEnforced()) return
  const s = await getMarketSession(now)
  if (!s.open) throw new MarketClosedError(s)
}

// 서버 기동 시 1회 + 매일 00:05 에 캐시를 채운다(체결 루프가 동기 판정에 쓰는 값).
export async function warmCalendar(now = new Date()): Promise<void> {
  await refreshCalendar(kstDayKey(now))
}
