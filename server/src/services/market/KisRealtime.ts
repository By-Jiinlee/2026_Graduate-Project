import axios from 'axios'
import fs from 'fs'
import path from 'path'
import { Server, Socket } from 'socket.io'
import { QueryTypes } from 'sequelize'
import sequelize from '../../config/database'
import { getKisAccessToken } from './KisAuth'

const BASE_URL      = 'https://openapi.koreainvestment.com:9443'
const APP_KEY       = process.env.KIS_REAL_APP_KEY!
const APP_SECRET    = process.env.KIS_REAL_APP_SECRET!

const CRAWL_DELAY_MS    = 70    // 장 중 크롤링 딜레이 (~14 req/s, 한도 20 대비 여유)
const OVERTIME_DELAY_MS = 300   // 시간외 크롤링 딜레이 (~3 req/s, 느긋하게)
const POLL_INTERVAL_MS  = 1000  // 온디맨드 폴링 주기 (장 중/시간외 공통 1s, 종목 1개라 부담 없음)

const FULL_CRAWL_ENABLED = process.env.ENABLE_FULL_CRAWL !== 'false'

// ─── 서버 가격 스냅샷 ────────────────────────────────────────
export const priceMap = new Map<string, number>()

// ─── priceMap 영속화 (재시작 시 복원) ────────────────────────
const CACHE_PATH = path.join(__dirname, '../../../cache/priceCache.json')

const loadPriceCache = () => {
    try {
        if (!fs.existsSync(CACHE_PATH)) return
        const raw = fs.readFileSync(CACHE_PATH, 'utf-8')
        const obj: Record<string, number> = JSON.parse(raw)
        for (const [code, price] of Object.entries(obj)) {
            priceMap.set(code, price)
        }
        console.log(`[PriceCache] 복원 완료 — ${priceMap.size}개 종목`)
    } catch (err) {
        console.warn('[PriceCache] 캐시 로드 실패 (무시):', (err as Error).message)
    }
}

const savePriceCache = () => {
    try {
        const dir = path.dirname(CACHE_PATH)
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        const obj = Object.fromEntries(priceMap)
        fs.writeFileSync(CACHE_PATH, JSON.stringify(obj), 'utf-8')
    } catch (err) {
        console.warn('[PriceCache] 캐시 저장 실패:', (err as Error).message)
    }
}

// ─── 시간대 판별 (KST) ────────────────────────────────────────

const getNowKst = () => new Date(Date.now() + 9 * 3600 * 1000)

const isWeekday = (): boolean => {
    const day = getNowKst().getUTCDay()
    return day !== 0 && day !== 6
}

// 정규장: 09:00 ~ 15:30
const isMarketOpen = (): boolean => {
    if (!isWeekday()) return false
    const now = getNowKst()
    const min = now.getUTCHours() * 60 + now.getUTCMinutes()
    return min >= 9 * 60 && min < 15 * 60 + 30
}

// 시간외 단일가: 16:00 ~ 18:00
const isOvertimeOpen = (): boolean => {
    if (!isWeekday()) return false
    const now = getNowKst()
    const min = now.getUTCHours() * 60 + now.getUTCMinutes()
    return min >= 16 * 60 && min < 18 * 60
}

const getTimeZoneLabel = (): string => {
    if (isMarketOpen())    return '장 중'
    if (isOvertimeOpen())  return '시간외 단일가'
    return '장 외'
}

// ─── KIS REST API: 정규장 현재가 (FHKST01010100) ─────────────
// 장 중: 실시간 현재가 / 장 외: 마지막 종가 반환
type FetchResult = {
    code: string; price: number; change: number; changeRate: number
    volume: number; open?: number; high?: number; low?: number
} | null | 'RATE_LIMIT'

const fetchCurrentPrice = async (code: string): Promise<FetchResult> => {
    try {
        const token = await getKisAccessToken()
        const res = await axios.get(
            `${BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-price`,
            {
                headers: {
                    authorization: `Bearer ${token}`,
                    appkey:    APP_KEY,
                    appsecret: APP_SECRET,
                    tr_id:     'FHKST01010100',
                    'content-type': 'application/json',
                },
                params: {
                    FID_COND_MRKT_DIV_CODE: 'J',
                    FID_INPUT_ISCD: code,
                },
            }
        )
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

// ─── KIS REST API: 시간외 단일가 현재가 (FHPST02300000) ───────
// 사용 시간대: 16:00 ~ 18:00
// 시간외 거래가 없는 종목은 ovtm_untp_prpr = 0 → null 반환
const fetchOvertimePrice = async (code: string): Promise<FetchResult> => {
    try {
        const token = await getKisAccessToken()
        const res = await axios.get(
            `${BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-overtime-price`,
            {
                headers: {
                    authorization: `Bearer ${token}`,
                    appkey:    APP_KEY,
                    appsecret: APP_SECRET,
                    tr_id:     'FHPST02300000',
                    'content-type': 'application/json',
                },
                params: {
                    FID_COND_MRKT_DIV_CODE: 'J',
                    FID_INPUT_ISCD: code,
                },
            }
        )
        if (res.data?.msg_cd === 'EGW00201') return 'RATE_LIMIT'
        const o = res.data?.output
        if (!o || res.data?.rt_cd !== '0') return null

        const price = Number(o.ovtm_untp_prpr)
        if (!price) return null  // 시간외 거래 없는 종목 → caller가 종가 fallback

        return {
            code,
            price,
            change:     Number(o.ovtm_untp_prdy_vrss),
            changeRate: Number(o.ovtm_untp_prdy_ctrt),
            volume:     Number(o.ovtm_untp_vol),
        }
    } catch (err: any) {
        if (err.response?.data?.msg_cd === 'EGW00201') return 'RATE_LIMIT'
        return null
    }
}

// ─── 시간대별 fetch 선택 ──────────────────────────────────────
// 시간외(16~18): ovtm price 시도 → 0이면 정규 종가 fallback
// 장 외(18~): inquire-price가 마지막 종가 반환하므로 그대로 사용
const fetchPrice = async (code: string): Promise<FetchResult> => {
    if (isMarketOpen()) return fetchCurrentPrice(code)

    if (isOvertimeOpen()) {
        const result = await fetchOvertimePrice(code)
        if (result === 'RATE_LIMIT') return 'RATE_LIMIT'
        if (result !== null) return result
        // 시간외 거래 없는 종목: 정규 종가(15:30 기준) fallback
        return fetchCurrentPrice(code)
    }

    // 장 외 (18:00 이후 / 장전): inquire-price → 전 거래일 종가
    return fetchCurrentPrice(code)
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ─── 전종목 크롤러 ───────────────────────────────────────────
let crawlerRunning = false

const startFullCrawler = async (io: Server): Promise<void> => {
    if (crawlerRunning) return
    crawlerRunning = true
    console.log('[KisCrawler] 전종목 크롤링 모드 시작')

    let lastClosedLog = 0

    while (true) {
        const market   = isMarketOpen()
        const overtime = isOvertimeOpen()

        // 장 외 대기
        if (!market && !overtime) {
            const now = Date.now()
            if (now - lastClosedLog > 5 * 60_000) {
                const t = getNowKst().toISOString().slice(11, 16)
                console.log(`[KisCrawler] 장 외 대기 중... (${t} KST) — 개장/시간외 시 자동 재개`)
                lastClosedLog = now
            }
            await sleep(30_000)
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

        const label    = getTimeZoneLabel()
        const delay    = market ? CRAWL_DELAY_MS : OVERTIME_DELAY_MS
        const cycleStart = Date.now()
        console.log(`\n[KisCrawler] ━━━ 사이클 시작 (${label}) ━━━ ${stocks.length}개 / ${new Date().toLocaleTimeString('ko-KR')}`)

        let updated = 0, changed = 0, rateLimitHits = 0

        for (let i = 0; i < stocks.length; i++) {
            const stock = stocks[i]

            // 시간대 전환 감지 → 현재 사이클 중단, 다음 루프에서 새 시간대로 시작
            const stillValid = market ? isMarketOpen() : isOvertimeOpen()
            if (!stillValid) {
                console.log(`[KisCrawler] 시간대 전환 감지 (${label} 종료) — ${i}번째에서 중단`)
                break
            }

            const prevPrice = priceMap.get(stock.code)
            const result    = await fetchPrice(stock.code)

            if (result === 'RATE_LIMIT') {
                rateLimitHits++
                if (rateLimitHits <= 3) console.warn(`[KisCrawler] ⚠ Rate limit — ${i + 1}번째 종목 — 2초 대기`)
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

            // 처음 5개: 초기 확인 로그
            if (i < 5) {
                const status = result ? `✓ ${result.price}원` : '✗ null'
                console.log(`[KisCrawler] [${i + 1}/5] ${stock.code} → ${status}`)
            }

            // 300개마다 진행 로그
            if (i >= 5 && (i + 1) % 300 === 0) {
                const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(0)
                console.log(`[KisCrawler] 진행 ${i + 1}/${stocks.length} (${elapsed}s) | 업데이트 ${updated}개`)
            }

            await sleep(delay)
        }

        const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1)
        const sample  = [...priceMap.entries()].slice(0, 5).map(([c, p]) => `${c}=${p}`).join(' | ')
        console.log(`\n========================================`)
        console.log(`✅ [KisCrawler] 사이클 완료 (${label})`)
        console.log(`   소요시간: ${elapsed}s | 업데이트: ${updated}개 | 가격변동: ${changed}개 | RateLimit: ${rateLimitHits}회`)
        console.log(`   샘플: ${sample || '없음'}`)
        console.log(`========================================\n`)
    }
}

// ─── 온디맨드 폴링 (상세 페이지용) ──────────────────────────
const refCount   = new Map<string, number>()
const pollTimers = new Map<string, ReturnType<typeof setInterval> | null>()

const doFetch = async (code: string, io: Server) => {
    const result = await fetchPrice(code)
    if (result && typeof result !== 'string') {
        priceMap.set(result.code, result.price)
        io.emit('stock:price', result)
    }
}

const startPolling = (code: string, io: Server) => {
    if (pollTimers.has(code)) return

    // 즉시 첫 fetch (시간대 무관 — 종가 포함)
    doFetch(code, io)

    // 장 외 완전 종료 (18:00~ / 장전): 1회만 가져오면 충분
    if (!isMarketOpen() && !isOvertimeOpen()) {
        pollTimers.set(code, null)
        console.log(`[KisRealtime] 장 외 종가 1회 조회: ${code}`)
        return
    }

    const timer = setInterval(async () => {
        const market   = isMarketOpen()
        const overtime = isOvertimeOpen()

        // 장 외 진입 감지 → 마지막 종가 1회 더 가져오고 폴링 중단
        if (!market && !overtime) {
            stopPolling(code)
            doFetch(code, io)
            return
        }

        await doFetch(code, io)
    }, POLL_INTERVAL_MS)

    pollTimers.set(code, timer)
    console.log(`[KisRealtime] 온디맨드 폴링 시작 (${getTimeZoneLabel()}): ${code}`)
}

const stopPolling = (code: string) => {
    const timer = pollTimers.get(code)
    if (timer) clearInterval(timer)
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
    mode:            FULL_CRAWL_ENABLED ? 'full-crawl' : 'on-demand',
    crawlerRunning,
    timeZone:        getTimeZoneLabel(),
    isMarketOpen:    isMarketOpen(),
    isOvertimeOpen:  isOvertimeOpen(),
    priceMapSize:    priceMap.size,
    onDemandPolling: [...pollTimers.keys()],
    samplePrices:    [...priceMap.entries()].slice(0, 10).map(([code, price]) => ({ code, price })),
})

// ─── 진입점 ──────────────────────────────────────────────────
export const startKisRealtime = async (io: Server): Promise<void> => {
    // 재시작 시 이전 가격 복원
    loadPriceCache()

    // 60초마다 priceMap → 파일 저장
    setInterval(savePriceCache, 60_000)

    if (FULL_CRAWL_ENABLED) {
        console.log('[KisRealtime] 전종목 크롤링 모드 (ENABLE_FULL_CRAWL=true)')
        startFullCrawler(io).catch(err =>
            console.error('[KisCrawler] 크롤러 오류:', err.message)
        )
    } else {
        console.log('[KisRealtime] 온디맨드 폴링 모드 (ENABLE_FULL_CRAWL=false)')
    }

    // 상세 페이지 온디맨드 폴링 — 항상 활성
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
