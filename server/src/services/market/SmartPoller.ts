/**
 * SmartPoller — 보유종목 & 미체결 주문 종목 능동적 가격 조회
 *
 * 전종목 크롤러(KisRealtime)와 독립적으로 동작.
 * 지정가 체결 & 포트폴리오 실시간 갱신에 필요한 종목만 집중 폴링.
 * KIS API 실패(rate limit/키 오류) 시 Yahoo Finance 자동 폴백.
 */

import axios from 'axios'
import { Server } from 'socket.io'
import { QueryTypes } from 'sequelize'
import sequelize from '../../config/database'
import { priceMap } from './KisRealtime'
import { getKisAccessToken } from './KisAuth'
import { processPendingOrders } from '../../schedulers/trade/limitOrderScheduler'

const BASE_URL    = 'https://openapi.koreainvestment.com:9443'
const APP_KEY     = process.env.KIS_REAL_APP_KEY
const APP_SECRET  = process.env.KIS_REAL_APP_SECRET
const KIS_ENABLED = !!(APP_KEY && APP_SECRET)

// 장 중: 10초, 시간외: 30초, 장 외: 5분
const getNowKst  = () => new Date(Date.now() + 9 * 3600 * 1000)
const isWeekday  = () => { const d = getNowKst().getUTCDay(); return d !== 0 && d !== 6 }
const isMarketOpen = () => {
    if (!isWeekday()) return false
    const min = getNowKst().getUTCHours() * 60 + getNowKst().getUTCMinutes()
    return min >= 9 * 60 && min < 15 * 60 + 30
}
const isOvertimeOpen = () => {
    if (!isWeekday()) return false
    const min = getNowKst().getUTCHours() * 60 + getNowKst().getUTCMinutes()
    return min >= 16 * 60 && min < 18 * 60
}
const pollInterval = () =>
    isMarketOpen() ? 10_000 : isOvertimeOpen() ? 30_000 : 5 * 60_000

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ─── DB에서 지금 당장 가격이 필요한 종목 조회 ─────────────────

interface StockRow { id: number; code: string; market: string }

const getNeededStocks = async (): Promise<StockRow[]> => {
    return sequelize.query<StockRow>(
        `SELECT DISTINCT s.id, s.code, s.market
         FROM stocks s
         WHERE s.is_active = 1
           AND (
             EXISTS (SELECT 1 FROM virtual_holdings vh WHERE vh.stock_id = s.id)
             OR EXISTS (
               SELECT 1 FROM virtual_orders vo
               WHERE vo.stock_id = s.id AND vo.status = 'pending'
             )
           )`,
        { type: QueryTypes.SELECT }
    )
}

// ─── 가격 결과 타입 ───────────────────────────────────────────

interface PriceResult {
    price:      number
    change:     number
    changeRate: number
    volume:     number
    open:       number
    high:       number
    low:        number
    source:     'KIS' | 'Yahoo'
}

// ─── KIS REST API (FHKST01010100) ────────────────────────────

let kisTokenFailed = false  // KIS 토큰 발급 자체 실패 시 Yahoo로만 동작

const fetchKis = async (code: string): Promise<PriceResult | null> => {
    if (!KIS_ENABLED || kisTokenFailed) return null
    try {
        const token = await getKisAccessToken()
        const res = await axios.get(
            `${BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-price`,
            {
                headers: {
                    authorization: `Bearer ${token}`,
                    appkey:        APP_KEY!,
                    appsecret:     APP_SECRET!,
                    tr_id:         'FHKST01010100',
                    'content-type': 'application/json',
                },
                params: { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code },
                timeout: 5000,
            }
        )
        if (res.data?.msg_cd === 'EGW00201') return null  // rate limit → Yahoo 폴백
        const o = res.data?.output
        if (!o || res.data?.rt_cd !== '0') return null
        return {
            price:      Number(o.stck_prpr),
            change:     Number(o.prdy_vrss),
            changeRate: Number(o.prdy_ctrt),
            volume:     Number(o.acml_vol),
            open:       Number(o.stck_oprc),
            high:       Number(o.stck_hgpr),
            low:        Number(o.stck_lwpr),
            source:     'KIS',
        }
    } catch (err: any) {
        // 인증/앱키 오류: 이후 호출도 실패할 것이므로 KIS 비활성화
        if (err.response?.status === 401 || err.response?.data?.msg_cd === 'EGW00000') {
            console.warn('[SmartPoller] KIS 인증 실패 — Yahoo Finance 전용 모드로 전환')
            kisTokenFailed = true
        }
        return null
    }
}

// ─── Yahoo Finance (KOSPI: .KS, KOSDAQ: .KQ) ─────────────────
// 15~20분 지연 데이터 (모의투자 지정가 체결에는 충분)

const fetchYahoo = async (code: string, market: string): Promise<PriceResult | null> => {
    const suffix = market === 'KOSDAQ' ? '.KQ' : '.KS'
    try {
        const res = await axios.get(
            `https://query1.finance.yahoo.com/v8/finance/chart/${code}${suffix}`,
            {
                params:  { interval: '1m', range: '1d' },
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; UpTick/1.0)' },
                timeout: 8000,
            }
        )
        const result = res.data?.chart?.result?.[0]
        if (!result) return null
        const meta   = result.meta
        const price  = meta.regularMarketPrice ?? 0
        if (!price) return null
        const prev       = meta.chartPreviousClose ?? meta.previousClose ?? price
        const change     = parseFloat((price - prev).toFixed(2))
        const changeRate = prev > 0 ? parseFloat(((change / prev) * 100).toFixed(2)) : 0
        return {
            price,
            change,
            changeRate,
            volume: meta.regularMarketVolume ?? 0,
            open:   meta.regularMarketOpen   ?? price,
            high:   meta.regularMarketDayHigh ?? price,
            low:    meta.regularMarketDayLow  ?? price,
            source: 'Yahoo',
        }
    } catch {
        return null
    }
}

// ─── 단건 종목 가격 조회 (KIS → Yahoo 폴백) ──────────────────

const fetchPrice = async (stock: StockRow): Promise<PriceResult | null> => {
    const kis = await fetchKis(stock.code)
    if (kis) return kis

    await sleep(150)  // KIS 실패 후 Yahoo 요청 사이 짧은 간격
    return fetchYahoo(stock.code, stock.market)
}

// ─── 전체 폴링 사이클 ─────────────────────────────────────────

let cycleCount = 0

const runCycle = async (io: Server): Promise<void> => {
    const stocks = await getNeededStocks()
    if (stocks.length === 0) return

    cycleCount++
    const sources = { KIS: 0, Yahoo: 0, fail: 0 }

    for (const stock of stocks) {
        const result = await fetchPrice(stock)
        if (result) {
            priceMap.set(stock.code, result.price)
            io.emit('stock:price', {
                code:       stock.code,
                price:      result.price,
                change:     result.change,
                changeRate: result.changeRate,
                volume:     result.volume,
                open:       result.open,
                high:       result.high,
                low:        result.low,
            })
            sources[result.source]++
        } else {
            sources.fail++
        }
        // 종목 간 딜레이 — KIS rate limit(20 req/s) & Yahoo 부하 방지
        await sleep(KIS_ENABLED && !kisTokenFailed ? 120 : 400)
    }

    if (cycleCount % 6 === 1) {  // 1분마다 한 번 로그 (10s * 6)
        console.log(
            `[SmartPoller] #${cycleCount} | ${stocks.length}개 종목 | KIS: ${sources.KIS} Yahoo: ${sources.Yahoo} 실패: ${sources.fail}`
        )
    }

    // 가격 업데이트 직후 지정가 주문 즉시 체결 시도
    if (sources.KIS + sources.Yahoo > 0) {
        processPendingOrders().catch(err =>
            console.error('[SmartPoller] 지정가 체결 트리거 오류:', (err as Error).message)
        )
    }
}

// ─── 폴러 시작 ────────────────────────────────────────────────

let running = false

const schedule = (io: Server) => {
    setTimeout(async () => {
        if (!running) return
        try { await runCycle(io) } catch (err) {
            console.error('[SmartPoller] 사이클 오류:', (err as Error).message)
        }
        schedule(io)  // 완료 후 다음 예약 (동적 인터벌)
    }, pollInterval())
}

export const startSmartPoller = (io: Server): void => {
    if (running) return
    running = true

    const mode = KIS_ENABLED ? 'KIS + Yahoo 폴백' : 'Yahoo Finance 전용'
    console.log(`[SmartPoller] 시작 — ${mode} | 대상: 보유종목/미체결 주문`)

    // 즉시 첫 사이클 (서버 시작 시 priceMap 빠른 채움)
    runCycle(io).catch(err => console.error('[SmartPoller] 초기 사이클 오류:', err.message))
    schedule(io)
}

export const stopSmartPoller = (): void => {
    running = false
    console.log('[SmartPoller] 중지')
}
