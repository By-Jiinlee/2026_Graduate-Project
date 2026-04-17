import axios from 'axios'
import { Server } from 'socket.io'
import { getKisAccessToken } from './KisAuth'

const BASE_URL = 'https://openapi.koreainvestment.com:9443'
const APP_KEY = process.env.KIS_REAL_APP_KEY!
const APP_SECRET = process.env.KIS_REAL_APP_SECRET!

const KR_POLL_INTERVAL_MS = 5000   // 국내 지수: 5초마다
const US_POLL_INTERVAL_MS = 60000  // 미국 지수: 1분마다 (15분 지연이라 자주 호출 불필요)

// ─── 장 시간 여부 (KST 09:00 ~ 15:30, 평일) ─────────────────

const isKrMarketOpen = (): boolean => {
    const nowKst = new Date(Date.now() + 9 * 3600 * 1000)
    const day = nowKst.getUTCDay()
    if (day === 0 || day === 6) return false
    const min = nowKst.getUTCHours() * 60 + nowKst.getUTCMinutes()
    return min >= 9 * 60 && min < 15 * 60 + 30
}

// ─── KIS API - 국내 지수 현재가 조회 ─────────────────────────

const fetchKrIndex = async (
    indexCode: string,
    indexName: string
): Promise<{
    code: string
    name: string
    price: number
    change: number
    changeRate: number
    high: number
    low: number
    open: number
    volume: number
    market: 'KR'
} | null> => {
    try {
        const token = await getKisAccessToken()

        const res = await axios.get(
            `${BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-index-price`,
            {
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${token}`,
                    appkey: APP_KEY,
                    appsecret: APP_SECRET,
                    tr_id: 'FHPUP02100000',
                },
                params: {
                    FID_COND_MRKT_DIV_CODE: 'U',
                    FID_INPUT_ISCD: indexCode,
                },
            }
        )

        if (res.data?.msg_cd === 'EGW00201') {
            console.warn(`[MarketIndex] Rate limit - ${indexName}`)
            return null
        }

        const o = res.data?.output
        if (!o || res.data?.rt_cd !== '0') return null

        return {
            code:       indexCode,
            name:       indexName,
            price:      Number(o.bstp_nmix_prpr),
            change:     Number(o.bstp_nmix_prdy_vrss),
            changeRate: Number(o.bstp_nmix_prdy_ctrt),
            high:       Number(o.bstp_nmix_hgpr),
            low:        Number(o.bstp_nmix_lwpr),
            open:       Number(o.bstp_nmix_oprc),
            volume:     Number(o.acml_vol),
            market:     'KR',
        }
    } catch (err: any) {
        if (err.response?.data?.msg_cd === 'EGW00201') {
            console.warn(`[MarketIndex] Rate limit - ${indexName}`)
            return null
        }
        console.error(`[MarketIndex] ${indexName} 조회 오류:`, err.message)
        return null
    }
}

// ─── Yahoo Finance - 미국 지수 현재가 조회 ────────────────────

const fetchUsIndex = async (
    yahooSymbol: string,
    indexCode: string,
    indexName: string
): Promise<{
    code: string
    name: string
    price: number
    change: number
    changeRate: number
    high: number
    low: number
    open: number
    volume: number
    market: 'US'
    delayed: boolean
} | null> => {
    try {
        const res = await axios.get(
            `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}`,
            {
                params: {
                    interval: '1m',
                    range: '1d',
                },
                headers: {
                    'User-Agent': 'Mozilla/5.0',
                },
            }
        )

        const result = res.data?.chart?.result?.[0]
        if (!result) return null

        const meta = result.meta
        const price      = meta.regularMarketPrice ?? 0
        const prevClose  = meta.chartPreviousClose ?? meta.previousClose ?? price
        const change     = parseFloat((price - prevClose).toFixed(2))
        const changeRate = parseFloat(((change / prevClose) * 100).toFixed(2))

        return {
            code:       indexCode,
            name:       indexName,
            price,
            change,
            changeRate,
            high:       meta.regularMarketDayHigh ?? 0,
            low:        meta.regularMarketDayLow ?? 0,
            open:       meta.regularMarketOpen ?? 0,
            volume:     meta.regularMarketVolume ?? 0,
            market:     'US',
            delayed:    true,  // Yahoo Finance는 15분 지연
        }
    } catch (err: any) {
        console.error(`[MarketIndex] ${indexName} Yahoo 조회 오류:`, err.message)
        return null
    }
}

// ─── 지수 목록 ───────────────────────────────────────────────

const KR_INDEX_LIST = [
    { code: '0001', name: 'KOSPI' },
    { code: '1001', name: 'KOSDAQ' },
]

const US_INDEX_LIST = [
    { yahooSymbol: '%5EGSPC', code: 'SP500',  name: 'S&P 500' },
    { yahooSymbol: '%5EIXIC', code: 'NASDAQ', name: 'NASDAQ' },
    { yahooSymbol: '%5EDJI',  code: 'DOW',    name: 'DOW' },
]

// ─── 실시간 폴링 ─────────────────────────────────────────────

let krPollingTimer: ReturnType<typeof setInterval> | null = null
let usPollingTimer: ReturnType<typeof setInterval> | null = null

const fetchAndEmitKrIndices = async (io: Server): Promise<void> => {
    if (!isKrMarketOpen()) return

    for (const index of KR_INDEX_LIST) {
        const result = await fetchKrIndex(index.code, index.name)
        if (result) {
            io.emit('index:price', result)
        }
        await new Promise((r) => setTimeout(r, 300))
    }
}

const fetchAndEmitUsIndices = async (io: Server): Promise<void> => {
    for (const index of US_INDEX_LIST) {
        const result = await fetchUsIndex(index.yahooSymbol, index.code, index.name)
        if (result) {
            io.emit('index:price', result)
            console.log(`[MarketIndex] ${index.name}: ${result.price} (${result.changeRate}%)`)
        }
        await new Promise((r) => setTimeout(r, 500))
    }
}

export const startMarketIndexRealtime = (io: Server): void => {
    if (krPollingTimer || usPollingTimer) return

    console.log('[MarketIndex] 실시간 지수 폴링 시작')

    // 국내 지수: 5초마다
    krPollingTimer = setInterval(() => {
        fetchAndEmitKrIndices(io).catch((err) =>
            console.error('[MarketIndex] 국내 지수 폴링 오류:', err.message)
        )
    }, KR_POLL_INTERVAL_MS)

    // 미국 지수: 1분마다
    usPollingTimer = setInterval(() => {
        fetchAndEmitUsIndices(io).catch((err) =>
            console.error('[MarketIndex] 미국 지수 폴링 오류:', err.message)
        )
    }, US_POLL_INTERVAL_MS)

    // 시작 즉시 1회 조회
    fetchAndEmitKrIndices(io).catch((err) =>
        console.error('[MarketIndex] 국내 지수 초기 조회 오류:', err.message)
    )
    fetchAndEmitUsIndices(io).catch((err) =>
        console.error('[MarketIndex] 미국 지수 초기 조회 오류:', err.message)
    )
}

export const stopMarketIndexRealtime = (): void => {
    if (krPollingTimer) {
        clearInterval(krPollingTimer)
        krPollingTimer = null
    }
    if (usPollingTimer) {
        clearInterval(usPollingTimer)
        usPollingTimer = null
    }
    console.log('[MarketIndex] 실시간 지수 폴링 중지')
}