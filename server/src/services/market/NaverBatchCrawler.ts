/**
 * NaverBatchCrawler — 네이버 금융 batch API로 전종목 실시간 시세
 *
 * - 50개씩 한 요청 → 2000개 종목을 ~40번 요청으로 완전 갱신
 * - 장 중 30초 사이클 (각 종목 최대 30초 지연)
 * - 장 외 5분 사이클
 * - 인증 불필요, rate limit 없음 (Naver 공개 API)
 * - KIS 가용 여부와 무관하게 항상 작동
 */

import axios from 'axios'
import { Server } from 'socket.io'
import { QueryTypes } from 'sequelize'
import sequelize from '../../config/database'
import { priceMap } from './KisRealtime'

const BATCH_SIZE    = 50
const BATCH_DELAY   = 300   // 배치 간 딜레이 (ms) — Naver 서버 부하 방지
const NAVER_BASE    = 'https://polling.finance.naver.com/api/realtime/domestic/stock'

const getNowKst   = () => new Date(Date.now() + 9 * 3600 * 1000)
const isWeekday   = () => { const d = getNowKst().getUTCDay(); return d !== 0 && d !== 6 }
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
const cycleInterval = () =>
    isMarketOpen() ? 30_000 : isOvertimeOpen() ? 60_000 : 5 * 60_000

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ─── 전종목 코드 로드 (5분 캐시) ──────────────────────────────

interface StockCode { id: number; code: string; market: string }
let stockCodeCache: StockCode[] = []
let cacheLoadedAt = 0

const loadStockCodes = async (): Promise<StockCode[]> => {
    if (stockCodeCache.length > 0 && Date.now() - cacheLoadedAt < 5 * 60_000) {
        return stockCodeCache
    }
    const rows = await sequelize.query<StockCode>(
        `SELECT id, code, market FROM stocks WHERE is_active = 1 AND market IN ('KOSPI','KOSDAQ')`,
        { type: QueryTypes.SELECT }
    )
    stockCodeCache = rows
    cacheLoadedAt = Date.now()
    return rows
}

// ─── 네이버 배치 가격 조회 ────────────────────────────────────

interface NaverItem {
    itemCode:                    string
    stockName:                   string
    closePriceRaw:               number | string
    compareToPreviousClosePriceRaw: number | string
    fluctuationsRatioRaw:        number | string
    accumulatedTradingVolumeRaw: number | string
    openPriceRaw:                number | string
    highPriceRaw:                number | string
    lowPriceRaw:                 number | string
}

interface PriceEvent {
    code:       string
    price:      number
    change:     number
    changeRate: number
    volume:     number
    open:       number
    high:       number
    low:        number
}

const fetchBatch = async (codes: string[]): Promise<PriceEvent[]> => {
    try {
        const res = await axios.get<{ datas: NaverItem[] }>(
            `${NAVER_BASE}/${codes.join(',')}`,
            {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                    'Referer':    'https://finance.naver.com',
                },
                timeout: 8000,
            }
        )
        return (res.data.datas ?? []).map(d => ({
            code:       d.itemCode,
            price:      Number(d.closePriceRaw),
            change:     Number(d.compareToPreviousClosePriceRaw),
            changeRate: Number(d.fluctuationsRatioRaw),
            volume:     Number(d.accumulatedTradingVolumeRaw),
            open:       Number(d.openPriceRaw),
            high:       Number(d.highPriceRaw),
            low:        Number(d.lowPriceRaw),
        })).filter(d => d.price > 0)
    } catch {
        return []
    }
}

// ─── 전체 사이클 ─────────────────────────────────────────────

let cycleCount = 0

const runCycle = async (io: Server): Promise<void> => {
    const stocks = await loadStockCodes()
    if (stocks.length === 0) return

    cycleCount++
    const cycleStart = Date.now()
    let updated = 0

    // 50개씩 배치 처리
    for (let i = 0; i < stocks.length; i += BATCH_SIZE) {
        const batch = stocks.slice(i, i + BATCH_SIZE)
        const results = await fetchBatch(batch.map(s => s.code))

        for (const r of results) {
            priceMap.set(r.code, r.price)
            io.emit('stock:price', r)
            updated++
        }

        if (i + BATCH_SIZE < stocks.length) {
            await sleep(BATCH_DELAY)
        }
    }

    const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1)
    console.log(
        `[NaverCrawler] #${cycleCount} 완료 | ${updated}/${stocks.length}개 | ${elapsed}s | 다음: ${(cycleInterval()/1000).toFixed(0)}s 후`
    )
}

// ─── 크롤러 시작 ─────────────────────────────────────────────

let running = false

const schedule = (io: Server) => {
    setTimeout(async () => {
        if (!running) return
        try { await runCycle(io) } catch (err) {
            console.error('[NaverCrawler] 사이클 오류:', (err as Error).message)
        }
        schedule(io)
    }, cycleInterval())
}

export const startNaverBatchCrawler = (io: Server): void => {
    if (running) return
    running = true
    console.log('[NaverCrawler] 전종목 배치 크롤러 시작 (네이버 금융, 50개/요청)')

    // 즉시 첫 사이클
    runCycle(io).catch(err => console.error('[NaverCrawler] 초기 사이클 오류:', err.message))
    schedule(io)
}

export const stopNaverBatchCrawler = (): void => {
    running = false
    console.log('[NaverCrawler] 중지')
}
