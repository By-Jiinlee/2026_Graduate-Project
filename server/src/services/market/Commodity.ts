import axios from 'axios'
import { QueryTypes } from 'sequelize'
import sequelize from '../../config/database'

// ─── 원자재 설정 ──────────────────────────────────────────────
// dbName 은 commodity_prices.commodity 에 저장되는 값으로,
// AI 쪽 build_commodity_feature.py 가 이 값으로 피처 접두어를 만든다(wti/gold/copper/natgas).
// yahooSymbol 은 URL 경로에 그대로 들어가므로 '=' 를 %3D 로 인코딩해 둔다.

const COMMODITY_MAP = [
    { yahooSymbol: 'CL%3DF', dbName: 'WTI'    },
    { yahooSymbol: 'GC%3DF', dbName: 'GOLD'   },
    { yahooSymbol: 'HG%3DF', dbName: 'COPPER' },
    { yahooSymbol: 'NG%3DF', dbName: 'NATGAS' },
]

// ─── Yahoo Finance API (직접 호출) ────────────────────────────

export const fetchCommodityData = async (
    yahooSymbol: string,
    startDate: string,  // 'YYYY-MM-DD'
    endDate: string     // 'YYYY-MM-DD'
): Promise<any[]> => {
    // 주말·공휴일로 시작일에 거래가 없을 수 있어 여유를 둔다
    const startWithPrev = new Date(startDate)
    startWithPrev.setDate(startWithPrev.getDate() - 5)

    const period1 = Math.floor(startWithPrev.getTime() / 1000)
    const period2 = Math.floor(new Date(endDate).getTime() / 1000) + 86400  // 종료일 당일 포함

    const res = await axios.get(
        `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}`,
        {
            params: {
                period1,
                period2,
                interval: '1d',
                events: 'history',
            },
            headers: {
                'User-Agent': 'Mozilla/5.0',
            },
        }
    )

    const chart = res.data?.chart?.result?.[0]
    if (!chart) return []

    const timestamps: number[] = chart.timestamp ?? []
    const quotes = chart.indicators?.quote?.[0] ?? {}

    return timestamps.map((ts, i) => ({
        date: new Date(ts * 1000).toISOString().slice(0, 10),
        open: quotes.open?.[i] ?? null,
        high: quotes.high?.[i] ?? null,
        low: quotes.low?.[i] ?? null,
        close: quotes.close?.[i] ?? null,
        volume: quotes.volume?.[i] ?? null,
    }))
        .filter((row) => row.close !== null)
        .filter((row) => row.date >= startDate)  // startDate 이후만 반환
}

// ─── DB ───────────────────────────────────────────────────────

export const getLastSavedDate = async (commodity: string): Promise<string | null> => {
    const rows = await sequelize.query<{ last_date: string | null }>(
        `SELECT DATE_FORMAT(MAX(trade_date), '%Y-%m-%d') AS last_date
         FROM commodity_prices WHERE commodity = :commodity`,
        { replacements: { commodity }, type: QueryTypes.SELECT }
    )
    return rows[0]?.last_date ?? null
}

export const upsertCommodityPrices = async (
    commodity: string,
    rows: any[]
): Promise<void> => {
    if (rows.length === 0) return

    // uk_date_commodity(trade_date, commodity) 유니크 키로 중복 적재를 막는다
    const placeholders = rows.map(() => '(?,?,?,?,?,?,?)').join(',')
    const flat = rows.flatMap((row) => [
        row.date,
        commodity,
        row.open ?? null,
        row.high ?? null,
        row.low ?? null,
        row.close ?? null,
        row.volume ?? null,
    ])

    await sequelize.query(
        `INSERT INTO commodity_prices
         (trade_date, commodity, \`open\`, \`high\`, \`low\`, \`close\`, volume)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE
             \`open\`  = VALUES(\`open\`),
             \`high\`  = VALUES(\`high\`),
             \`low\`   = VALUES(\`low\`),
             \`close\` = VALUES(\`close\`),
             volume    = VALUES(volume)`,
        { replacements: flat, type: QueryTypes.INSERT }
    )
}

export { COMMODITY_MAP }

// ─── 날짜 유틸 ────────────────────────────────────────────────

export const dayAfter = (dateStr: string): string => {
    const d = new Date(dateStr)
    d.setDate(d.getDate() + 1)
    return d.toISOString().slice(0, 10)
}

export const getToday = (): string => new Date().toISOString().slice(0, 10)
