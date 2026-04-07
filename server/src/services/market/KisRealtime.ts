import WebSocket from 'ws'
import axios from 'axios'
import { Server, Socket } from 'socket.io'
import { QueryTypes } from 'sequelize'
import sequelize from '../../config/database'

const WS_URL = 'wss://openapivts.koreainvestment.com:31000'  // 모의투자 (실전: openapi.koreainvestment.com:21000)
const CHUNK_SIZE = 40
const CONNECT_INTERVAL_MS = 5000
const MAX_RETRIES = 3
const MAX_CONNECTIONS = 2  // 로그 기준 KIS 허용 한계

// ─── 승인키 자동 갱신 ────────────────────────────────────────

let cachedApprovalKey: string | null = null
let keyFetchPromise: Promise<string> | null = null

const getApprovalKey = (): Promise<string> => {
    if (cachedApprovalKey) return Promise.resolve(cachedApprovalKey)
    if (keyFetchPromise) return keyFetchPromise

    keyFetchPromise = (async () => {
        try {
            const res = await axios.post(
                'https://openapivts.koreainvestment.com:29443/oauth2/Approval',
                {
                    grant_type: 'client_credentials',
                    appkey: process.env.APP_KEY,
                    secretkey: process.env.KIS_MOCK_APP_SECRET,
                },
                { headers: { 'content-type': 'application/json' } }
            )
            const key = res.data.approval_key
            if (!key) throw new Error('approval_key 없음')
            console.log('[KisRealtime] 모의투자 승인키 발급 완료:', key.slice(0, 8) + '...')
            cachedApprovalKey = key
            return key
        } catch (err: any) {
            console.error('[KisRealtime] 승인키 발급 실패:', err.message)
            throw err
        } finally {
            keyFetchPromise = null
        }
    })()

    return keyFetchPromise
}

// ─── H0STCNT0 파싱 ───────────────────────────────────────────

const parseRealtimeData = (raw: string) => {
    const parts = raw.split('|')
    if (parts.length < 4) return null
    if (parts[1] !== 'H0STCNT0') return null

    const f = parts[3].split('^')
    return {
        code:       f[0],
        time:       f[1],
        price:      Number(f[2]),
        sign:       f[3],
        change:     Number(f[4]),
        changeRate: Number(f[5]),
        open:       Number(f[7]),
        high:       Number(f[8]),
        low:        Number(f[9]),
        volume:     Number(f[13]),
    }
}

// ─── 단일 WebSocket 연결 관리 ─────────────────────────────────

class KisConnection {
    private ws: WebSocket | null = null
    private readonly subscribed = new Set<string>()
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null
    private failCount = 0
    private connected = false

    constructor(
        private readonly label: string,
        private readonly io: Server,
        private readonly onGiveUp?: (codes: string[]) => void,
    ) {}

    async connect() {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer)

        const key = await getApprovalKey()
        if (!key) {
            console.error(`[KisRealtime] ${this.label} 승인키 없음 — 30초 후 재시도`)
            this.reconnectTimer = setTimeout(() => this.connect(), 30000)
            return
        }

        this.ws = new WebSocket(WS_URL)

        this.ws.on('open', () => {
            this.failCount = 0
            this.connected = true
            console.log(`[KisRealtime] ${this.label} 연결됨`)
            this.subscribed.forEach(code => this.sendMsg(code, '1', key))
        })

        this.ws.on('message', (data: Buffer) => {
            const raw = data.toString()
            if (raw.includes('PINGPONG')) { this.ws?.pong(); return }
            if (raw.startsWith('{')) return
            const parsed = parseRealtimeData(raw)
            if (parsed) this.io.emit('stock:price', parsed)
        })

        this.ws.on('error', (err) => {
            console.error(`[KisRealtime] ${this.label} 오류:`, err.message)
        })

        this.ws.on('close', () => {
            if (!this.connected) this.failCount++

            if (this.failCount >= MAX_RETRIES) {
                console.warn(`[KisRealtime] ${this.label} ${MAX_RETRIES}회 실패 — 포기`)
                this.onGiveUp?.([...this.subscribed])
                return
            }

            this.connected = false
            console.log(`[KisRealtime] ${this.label} 종료 — 5초 후 재연결 (${this.failCount}/${MAX_RETRIES})`)
            this.reconnectTimer = setTimeout(() => this.connect(), 5000)
        })
    }

    subscribe(code: string) {
        if (this.subscribed.has(code)) return
        this.subscribed.add(code)
        if (this.ws?.readyState === WebSocket.OPEN) {
            getApprovalKey().then(key => this.sendMsg(code, '1', key))
        }
    }

    unsubscribe(code: string) {
        if (!this.subscribed.has(code)) return
        this.subscribed.delete(code)
        if (this.ws?.readyState === WebSocket.OPEN) {
            getApprovalKey().then(key => this.sendMsg(code, '2', key))
        }
    }

    has(code: string) { return this.subscribed.has(code) }
    size()            { return this.subscribed.size }

    private sendMsg(code: string, trType: '1' | '2', key: string) {
        this.ws?.send(JSON.stringify({
            header: {
                approval_key: key,
                custtype: 'P',
                tr_type: trType,
                'content-type': 'utf-8',
            },
            body: { input: { tr_id: 'H0STCNT0', tr_key: code } },
        }))
    }
}

// ─── 동적 구독 ───────────────────────────────────────────────

let dynamicConn: KisConnection
const dynamicRefCount = new Map<string, number>()
const allSubscribed = new Set<string>()

const decrementRef = (code: string) => {
    const count = dynamicRefCount.get(code) ?? 0
    if (count <= 1) {
        dynamicRefCount.delete(code)
        dynamicConn.unsubscribe(code)
        console.log(`[KisRealtime] 동적 구독 해제: ${code}`)
    } else {
        dynamicRefCount.set(code, count - 1)
    }
}

// ─── 진입점 ──────────────────────────────────────────────────

export const startKisRealtime = async (io: Server): Promise<void> => {
    // 승인키 확인
    await getApprovalKey()

    // 거래량 상위 종목 (MAX_CONNECTIONS × CHUNK_SIZE 개)
    const limit = MAX_CONNECTIONS * CHUNK_SIZE
    const topStocks = await sequelize.query<{ code: string }>(
        `SELECT s.code
         FROM stocks s
         JOIN stock_prices sp ON s.id = sp.stock_id
         WHERE sp.price_date = (SELECT MAX(price_date) FROM stock_prices)
           AND s.is_active = 1
           AND s.market IN ('KOSPI', 'KOSDAQ')
         ORDER BY sp.volume DESC
         LIMIT ${limit}`,
        { type: QueryTypes.SELECT }
    )

    console.log(`[KisRealtime] 거래량 상위 ${topStocks.length}개 종목 → ${MAX_CONNECTIONS}개 연결 (${CONNECT_INTERVAL_MS / 1000}초 간격)`)

    for (let i = 0; i < topStocks.length; i += CHUNK_SIZE) {
        const chunk = topStocks.slice(i, i + CHUNK_SIZE)
        const chunkIndex = Math.floor(i / CHUNK_SIZE)

        setTimeout(() => {
            const conn = new KisConnection(`#${chunkIndex}`, io, (failedCodes) => {
                failedCodes.forEach(code => allSubscribed.delete(code))
                console.log(`[KisRealtime] #${chunkIndex} 포기 — ${failedCodes.length}개 동적 구독으로 전환`)
            })
            conn.connect()
            chunk.forEach(s => {
                conn.subscribe(s.code)
                allSubscribed.add(s.code)
            })
        }, chunkIndex * CONNECT_INTERVAL_MS)
    }

    // 동적 구독 연결 (상세 페이지 진입 종목 + 고정 구독 밖의 종목)
    dynamicConn = new KisConnection('DYNAMIC', io)
    dynamicConn.connect()

    io.on('connection', (socket: Socket) => {
        const socketSubs = new Set<string>()

        socket.on('subscribe:stock', (code: string) => {
            if (allSubscribed.has(code) || socketSubs.has(code)) return
            socketSubs.add(code)
            const count = dynamicRefCount.get(code) ?? 0
            dynamicRefCount.set(code, count + 1)
            if (count === 0) {
                dynamicConn.subscribe(code)
                console.log(`[KisRealtime] 동적 구독 추가: ${code}`)
            }
        })

        socket.on('unsubscribe:stock', (code: string) => {
            if (!socketSubs.has(code)) return
            socketSubs.delete(code)
            decrementRef(code)
        })

        socket.on('disconnect', () => {
            socketSubs.forEach(code => decrementRef(code))
        })
    })
}
