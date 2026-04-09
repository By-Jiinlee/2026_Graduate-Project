import axios from 'axios'
import { Server, Socket } from 'socket.io'
import { QueryTypes } from 'sequelize'
import sequelize from '../../config/database'
import { getKisAccessToken } from './KisAuth'

const BASE_URL = 'https://openapi.koreainvestment.com:9443'
const APP_KEY = process.env.KIS_REAL_APP_KEY!
const APP_SECRET = process.env.KIS_REAL_APP_SECRET!

const POLL_INTERVAL_MS = 2000   // 상세 페이지 온디맨드 폴링 주기
const CRAWL_DELAY_MS   = 70     // 전종목 크롤링 딜레이 (~14 req/s, 한도 20 대비 여유)

// 롤백 플래그: .env에서 ENABLE_FULL_CRAWL=false 로 즉시 비활성화 가능
const FULL_CRAWL_ENABLED = process.env.ENABLE_FULL_CRAWL !== 'false'

// ─── 서버 가격 스냅샷 ────────────────────────────────────────
export const priceMap = new Map<string, number>()

// ─── 장 시간 여부 (KST 09:00 ~ 15:30, 평일) ─────────────────

const isMarketOpen = (): boolean => {
    const nowKst = new Date(Date.now() + 9 * 3600 * 1000)
    const day = nowKst.getUTCDay()
    if (day === 0 || day === 6) return false
    const min = nowKst.getUTCHours() * 60 + nowKst.getUTCMinutes()
    return min >= 9 * 60 && min < 15 * 60 + 30
}

// ─── KIS REST API 현재가 조회 ─────────────────────────────────

// 반환값: 정상 데이터 | null(에러) | 'RATE_LIMIT'(EGW00201)
const fetchCurrentPrice = async (code: string): Promise<
    { code: string; price: number; change: number; changeRate: number; volume: number; open: number; high: number; low: number } | null | 'RATE_LIMIT'
> => {
    try {
        const token = await getKisAccessToken()
        const res = await axios.get(
            `${BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-price`,
            {
                headers: {
                    authorization: `Bearer ${token}`,
                    appkey: APP_KEY,
                    appsecret: APP_SECRET,
                    tr_id: 'FHKST01010100',
                    'content-type': 'application/json',
                },
                params: {
                    FID_COND_MRKT_DIV_CODE: 'J',
                    FID_INPUT_ISCD: code,
                },
            }
        )

        // 한도 초과 에러
        if (res.data?.msg_cd === 'EGW00201') return 'RATE_LIMIT'

        const o = res.data?.output
        if (!o || res.data?.rt_cd !== '0') return null

        return {
            code,
            price:      Number(o.stck_prpr),
            change:     Number(o.prdy_vrss),
            changeRate: Number(o.prdy_ctrt),
            volume:     Number(o.acml_vol),
            open:       Number(o.stck_oprc),
            high:       Number(o.stck_hgpr),
            low:        Number(o.stck_lwpr),
        }
    } catch (err: any) {
        if (err.response?.data?.msg_cd === 'EGW00201') return 'RATE_LIMIT'
        return null
    }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ─── 전종목 크롤러 ───────────────────────────────────────────

let crawlerRunning = false

const startFullCrawler = async (io: Server): Promise<void> => {
    if (crawlerRunning) return
    crawlerRunning = true
    console.log('[KisCrawler] 전종목 크롤링 모드 시작')

    while (true) {
        if (!isMarketOpen()) {
            await sleep(30_000)  // 장 외: 30초마다 체크
            continue
        }

        let stocks: { id: number; code: string }[]
        try {
            stocks = await sequelize.query<{ id: number; code: string }>(
                `SELECT id, code FROM stocks WHERE is_active = 1 AND market IN ('KOSPI','KOSDAQ')`,
                { type: QueryTypes.SELECT }
            )
        } catch {
            await sleep(10_000)
            continue
        }

        const cycleStart = Date.now()
        console.log(`\n[KisCrawler] ━━━ 사이클 시작 ━━━ ${stocks.length}개 종목 / ${new Date().toLocaleTimeString('ko-KR')}`)

        let updated = 0
        let changed = 0
        let rateLimitHits = 0

        for (let i = 0; i < stocks.length; i++) {
            const stock = stocks[i]
            if (!isMarketOpen()) {
                console.log(`[KisCrawler] 장 마감 감지 — ${i}번째에서 중단`)
                break
            }

            const prevPrice = priceMap.get(stock.code)
            const result = await fetchCurrentPrice(stock.code)

            if (result === 'RATE_LIMIT') {
                rateLimitHits++
                if (rateLimitHits <= 3) {
                    console.warn(`[KisCrawler] ⚠ Rate limit (EGW00201) ${i + 1}번째 종목 — 2초 대기`)
                }
                await sleep(2000)
                continue
            }

            if (result) {
                if (prevPrice !== result.price) changed++
                priceMap.set(result.code, result.price)
                io.emit('stock:price', result)
                updated++
                rateLimitHits = 0
            }

            // 처음 5개: 즉시 확인용 로그
            if (i < 5) {
                const status = !result ? '✗ null' : typeof result === 'string' ? '⚠ rate limit' : `✓ ${result.price}원`
                console.log(`[KisCrawler] [${i + 1}/5 초기확인] ${stock.code} → ${status}`)
            }

            // 이후 300개마다 중간 진행 로그
            if (i >= 5 && (i + 1) % 300 === 0) {
                const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(0)
                const sample = [...priceMap.entries()].slice(0, 3).map(([c, p]) => `${c}:${p}`).join(' | ')
                console.log(`[KisCrawler] 진행 ${i + 1}/${stocks.length} (${elapsed}s) | 업데이트 ${updated}개 | 샘플: ${sample}`)
            }

            await sleep(CRAWL_DELAY_MS)
        }

        const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1)
        const sample = [...priceMap.entries()].slice(0, 5).map(([c, p]) => `${c}=${p}`).join(' | ')
        console.log(`\n========================================`)
        console.log(`✅ [KisCrawler] 전종목 크롤링 완료`)
        console.log(`   소요시간: ${elapsed}s | 업데이트: ${updated}개 | 가격변동: ${changed}개 | RateLimit: ${rateLimitHits}회`)
        console.log(`   샘플: ${sample || '없음'}`)
        console.log(`========================================\n`)
    }
}

// ─── 온디맨드 폴링 (상세 페이지용) ──────────────────────────

const refCount   = new Map<string, number>()
const pollTimers = new Map<string, ReturnType<typeof setInterval>>()

const startPolling = (code: string, io: Server) => {
    if (pollTimers.has(code)) return

    const timer = setInterval(async () => {
        const result = await fetchCurrentPrice(code)
        if (result && result !== 'RATE_LIMIT') {
            priceMap.set(result.code, result.price)
            io.emit('stock:price', result)
        }
    }, POLL_INTERVAL_MS)

    pollTimers.set(code, timer)
    console.log(`[KisRealtime] 온디맨드 폴링 시작: ${code}`)
}

const stopPolling = (code: string) => {
    const timer = pollTimers.get(code)
    if (!timer) return
    clearInterval(timer)
    pollTimers.delete(code)
    console.log(`[KisRealtime] 온디맨드 폴링 중지: ${code}`)
}

const decrement = (code: string) => {
    const count = refCount.get(code) ?? 0
    if (count <= 1) {
        refCount.delete(code)
        stopPolling(code)
    } else {
        refCount.set(code, count - 1)
    }
}

// ─── 상태 진단 ───────────────────────────────────────────────

export const getRealtimeStatus = () => ({
    mode: FULL_CRAWL_ENABLED ? 'full-crawl' : 'on-demand',
    crawlerRunning,
    isMarketOpen: isMarketOpen(),
    priceMapSize: priceMap.size,
    onDemandPolling: [...pollTimers.keys()],
    samplePrices: [...priceMap.entries()].slice(0, 10).map(([code, price]) => ({ code, price })),
})

// ─── 진입점 ──────────────────────────────────────────────────

export const startKisRealtime = async (io: Server): Promise<void> => {
    if (FULL_CRAWL_ENABLED) {
        console.log('[KisRealtime] 전종목 크롤링 모드 (ENABLE_FULL_CRAWL=true)')
        startFullCrawler(io).catch(err =>
            console.error('[KisCrawler] 크롤러 오류:', err.message)
        )
    } else {
        console.log('[KisRealtime] 온디맨드 폴링 모드 (ENABLE_FULL_CRAWL=false)')
    }

    // 상세 페이지 온디맨드 폴링은 항상 유지
    io.on('connection', (socket: Socket) => {
        const socketSubs = new Set<string>()

        socket.on('subscribe:stock', (code: string) => {
            if (socketSubs.has(code)) return
            socketSubs.add(code)
            const count = refCount.get(code) ?? 0
            refCount.set(code, count + 1)
            if (count === 0) startPolling(code, io)
        })

        socket.on('unsubscribe:stock', (code: string) => {
            if (!socketSubs.has(code)) return
            socketSubs.delete(code)
            decrement(code)
        })

        socket.on('disconnect', () => {
            socketSubs.forEach(code => decrement(code))
        })
    })
}
