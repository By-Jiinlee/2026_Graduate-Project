import axios from 'axios'
import { QueryTypes } from 'sequelize'
import sequelize from '../../config/database'

// ─── 지수 설정 ────────────────────────────────────────────────

const INDEX_MAP = [
    { yahooSymbol: '%5EGSPC', dbSymbol: 'US500',  name: 'S&P500'              },
    { yahooSymbol: '%5EIXIC', dbSymbol: 'IXIC',   name: 'Nasdaq'              },
    { yahooSymbol: '%5EDJI',  dbSymbol: 'DJI',    name: 'DowJones'            },
    { yahooSymbol: '%5EVIX',  dbSymbol: 'VIX',    name: 'CBOE Volatility Index' },
]

// ─── Yahoo Finance API (직접 호출) ────────────────────────────

export const fetchIndexData = async (
    yahooSymbol: string,
    startDate: string,  // 'YYYY-MM-DD'
    endDate: string     // 'YYYY-MM-DD'
): Promise<any[]> => {
    // 전일 종가 계산을 위해 하루 전부터 조회
    const startWithPrev = new Date(startDate)
    startWithPrev.setDate(startWithPrev.getDate() - 5)  // 5일 여유 (주말/공휴일 대비)

    const period1 = Math.floor(startWithPrev.getTime() / 1000)
    const period2 = Math.floor(new Date(endDate).getTime() / 1000)

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

    const rows = timestamps.map((ts, i) => ({
        date: new Date(ts * 1000).toISOString().slice(0, 10),
        open: quotes.open?.[i] ?? null,
        high: quotes.high?.[i] ?? null,
        low: quotes.low?.[i] ?? null,
        close: quotes.close?.[i] ?? null,
    })).filter((row) => row.close !== null)

    // 전일 종가 대비 등락률 계산
    return rows.map((row, i) => {
        const prevClose = i > 0 ? rows[i - 1].close : null
        const changeRate = prevClose && row.close
            ? parseFloat(((row.close - prevClose) / prevClose * 100).toFixed(2))
            : null
        return { ...row, changeRate }
    }).filter((row) => row.date >= startDate)  // startDate 이후만 반환
}

// ─── DB ───────────────────────────────────────────────────────

export const getLastSavedDate = async (dbSymbol: string): Promise<string | null> => {
    const rows = await sequelize.query<{ last_date: string | null }>(
        `SELECT DATE_FORMAT(MAX(trade_date), '%Y-%m-%d') AS last_date
         FROM market_indices WHERE index_symbol = :dbSymbol`,
        { replacements: { dbSymbol }, type: QueryTypes.SELECT }
    )
    return rows[0]?.last_date ?? null
}

export const upsertMarketIndex = async (
    dbSymbol: string,
    name: string,
    rows: any[]
): Promise<void> => {
    if (rows.length === 0) return

    const placeholders = rows.map(() => '(?,?,?,?,?,?,?,?)').join(',')
    const flat = rows.flatMap((row) => [
        dbSymbol,
        name,
        row.date,
        row.close ?? null,
        row.open ?? null,
        row.high ?? null,
        row.low ?? null,
        row.changeRate ?? null,
    ])

    await sequelize.query(
        `INSERT INTO market_indices
         (index_symbol, index_name, trade_date, close_price, open_price, high_price, low_price, change_rate)
         VALUES ${placeholders}
             ON DUPLICATE KEY UPDATE
                                  index_name   = VALUES(index_name),
                                  close_price  = VALUES(close_price),
                                  open_price   = VALUES(open_price),
                                  high_price   = VALUES(high_price),
                                  low_price    = VALUES(low_price),
                                  change_rate  = VALUES(change_rate)`,
        { replacements: flat, type: QueryTypes.INSERT }
    )
}

export { INDEX_MAP }

// ─── 날짜 유틸 ────────────────────────────────────────────────

export const dayAfter = (dateStr: string): string => {
    const d = new Date(dateStr)
    d.setDate(d.getDate() + 1)
    return d.toISOString().slice(0, 10)
}

export const getToday = (): string => new Date().toISOString().slice(0, 10)