import axios from 'axios'
import { QueryTypes } from 'sequelize'
import sequelize from '../../config/database'
import { getKisAccessToken } from './KisAuth'

const APP_KEY = process.env.KIS_REAL_APP_KEY!
const APP_SECRET = process.env.KIS_REAL_APP_SECRET!
const BASE_URL = 'https://openapi.koreainvestment.com:9443'

// ─── 타입 ─────────────────────────────────────────────────────

interface Stock {
    id: number
    code: string
}

// ─── KIS API - 분봉 조회 ──────────────────────────────────────

const fetchMinuteCandlesOnce = async (
    stockCode: string,
    date: string,
    hour: string
): Promise<any[]> => {
    const token = await getKisAccessToken()

    try {
        const res = await axios.get(
            `${BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice`,
            {
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${token}`,
                    appkey: APP_KEY,
                    appsecret: APP_SECRET,
                    tr_id: 'FHKST03010200',
                },
                params: {
                    FID_COND_MRKT_DIV_CODE: 'J',
                    FID_INPUT_ISCD: stockCode,
                    FID_INPUT_HOUR_1: hour,
                    FID_INPUT_DATE_1: date,
                    FID_PW_DATA_INCU_YN: 'N',
                    FID_ETC_CLS_CODE: '',
                },
            }
        )
        return res.data?.output2 ?? []
    } catch (err: any) {
        // 403은 그대로 throw해서 상위 스케줄러가 skip set에 등록하게 함
        if (err.response?.status === 403) throw err
        // 그 외 에러는 빈 배열 (일시적 네트워크 오류 등)
        console.warn(`[MinuteCandle] ${stockCode} API 오류 (${err.response?.status ?? 'unknown'}):`, err.message)
        return []
    }
}

// ─── 하루치 분봉 전체 수집 ────────────────────────────────────

export const fetchDayCandles = async (stockCode: string, date: string, startHour?: string): Promise<any[]> => {
    const allData: any[] = []
    let currHour = startHour ?? '153000'

    while (true) {
        const rows = await fetchMinuteCandlesOnce(stockCode, date, currHour)
        if (!rows || rows.length === 0) break

        allData.push(...rows)

        const lastTime = rows[rows.length - 1]?.stck_cntg_hour
        if (!lastTime || parseInt(lastTime) <= 90000) break

        const h = parseInt(lastTime.slice(0, 2))
        const m = parseInt(lastTime.slice(2, 4))
        const s = parseInt(lastTime.slice(4, 6))
        const prevMin = new Date(2000, 0, 1, h, m, s)
        prevMin.setMinutes(prevMin.getMinutes() - 1)
        currHour = `${String(prevMin.getHours()).padStart(2, '0')}${String(prevMin.getMinutes()).padStart(2, '0')}${String(prevMin.getSeconds()).padStart(2, '0')}`

        await new Promise((r) => setTimeout(r, 300))
    }

    return allData
}

// ─── DB ───────────────────────────────────────────────────────

export const getActiveStocks = async (): Promise<Stock[]> => {
    return sequelize.query<Stock>(
        `SELECT id, code FROM stocks WHERE is_active = 1 AND market IN ('KOSPI','KOSDAQ')`,
        { type: QueryTypes.SELECT }
    )
}

export const getLastSavedDate = async (stockId: number): Promise<string | null> => {
    const rows = await sequelize.query<{ last_date: string | null }>(
        `SELECT DATE_FORMAT(MAX(candle_time), '%Y%m%d') AS last_date
         FROM stock_minute_candles WHERE stock_id = :stockId AND interval_min = 1`,
        { replacements: { stockId }, type: QueryTypes.SELECT }
    )
    return rows[0]?.last_date ?? null
}

// 전종목 마지막 분봉 날짜 한번에 조회
export const getAllLastMinuteDates = async (): Promise<Map<number, string>> => {
    const rows = await sequelize.query<{ stock_id: number; last_date: string }>(
        `SELECT stock_id, DATE_FORMAT(MAX(candle_time), '%Y%m%d') AS last_date
         FROM stock_minute_candles WHERE interval_min = 1
         GROUP BY stock_id`,
        { type: QueryTypes.SELECT }
    )
    return new Map(rows.map(r => [r.stock_id, r.last_date]))
}

// 오늘 분봉 이미 수집됐는지 확인 (가장 데이터 많은 날짜가 오늘인지)
export const isMinuteTodayComplete = async (today: string): Promise<boolean> => {
    const rows = await sequelize.query<{ best_date: string }>(
        `SELECT DATE_FORMAT(DATE(candle_time), '%Y%m%d') AS best_date
         FROM stock_minute_candles
         WHERE interval_min = 1
         GROUP BY DATE(candle_time)
         ORDER BY COUNT(*) DESC, DATE(candle_time) DESC
         LIMIT 1`,
        { type: QueryTypes.SELECT }
    )
    return rows[0]?.best_date === today
}

export const upsertMinuteCandles = async (
    stockId: number,
    date: string,
    rows: any[]
): Promise<void> => {
    if (rows.length === 0) return

    const placeholders = rows.map(() => '(?,?,?,?,?,?,?,?,?,?)').join(',')
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')

    const flat = rows.flatMap((row) => {
        const t = row.stck_cntg_hour
        const candle_time = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)} ${t.slice(0, 2)}:${t.slice(2, 4)}:00`
        return [
            stockId,
            candle_time,
            1,
            parseFloat(row.stck_oprc) || null,
            parseFloat(row.stck_hgpr) || null,
            parseFloat(row.stck_lwpr) || null,
            parseFloat(row.stck_prpr) || null,
            parseInt(row.cntg_vol) || null,
            parseFloat(row.acml_tr_pbmn) || null,
            now,
        ]
    })

    await sequelize.query(
        `INSERT IGNORE INTO stock_minute_candles
       (stock_id, candle_time, interval_min, open, high, low, close, volume, trading_value, created_at)
     VALUES ${placeholders}`,
        { replacements: flat, type: QueryTypes.INSERT }
    )
}

export const getToday = (): string =>
    new Date().toISOString().slice(0, 10).replace(/-/g, '')

export const dayAfter = (dateStr: string): string => {
    // 'YYYYMMDD' 형식 처리
    const normalized = dateStr.length === 8
        ? `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`
        : dateStr
    const d = new Date(normalized)
    d.setDate(d.getDate() + 1)
    return d.toISOString().slice(0, 10).replace(/-/g, '')
}