import { QueryTypes } from 'sequelize'
import sequelize from '../../config/database'

// ─── 타입 ─────────────────────────────────────────────────────

interface Stock52WeekRow {
    stock_code: string
    trade_date: string
    close_price: number | null
    change_rate: number | null
    high_52week: number | null
    high_52week_date: string | null
    low_52week: number | null
    low_52week_date: string | null
}

// ─── DB 계산 ──────────────────────────────────────────────────

export const calculate52Week = async (targetDate: string): Promise<Stock52WeekRow[]> => {
    // stock_prices 테이블에서 52주 고가/저가 계산
    return sequelize.query<Stock52WeekRow>(
        `SELECT
       s.code AS stock_code,
       :targetDate AS trade_date,
       today.close AS close_price,
       ROUND((today.close - prev.close) / prev.close * 100, 2) AS change_rate,
       MAX(sp.high) AS high_52week,
       (
         SELECT price_date FROM stock_prices
         WHERE stock_id = s.id AND high = MAX(sp.high)
           AND price_date >= DATE_SUB(:targetDate, INTERVAL 52 WEEK)
           AND price_date <= :targetDate
         ORDER BY price_date DESC LIMIT 1
       ) AS high_52week_date,
       MIN(sp.low) AS low_52week,
       (
         SELECT price_date FROM stock_prices
         WHERE stock_id = s.id AND low = MIN(sp.low)
           AND price_date >= DATE_SUB(:targetDate, INTERVAL 52 WEEK)
           AND price_date <= :targetDate
         ORDER BY price_date DESC LIMIT 1
       ) AS low_52week_date
     FROM stocks s
     JOIN stock_prices sp ON sp.stock_id = s.id
       AND sp.price_date >= DATE_SUB(:targetDate, INTERVAL 52 WEEK)
       AND sp.price_date <= :targetDate
     JOIN stock_prices today ON today.stock_id = s.id AND today.price_date = :targetDate
     LEFT JOIN stock_prices prev ON prev.stock_id = s.id
       AND prev.price_date = (
         SELECT MAX(price_date) FROM stock_prices
         WHERE stock_id = s.id AND price_date < :targetDate
       )
     WHERE s.is_active = 1 AND s.market IN ('KOSPI', 'KOSDAQ')
     GROUP BY s.id, s.code, today.close, prev.close`,
        {
            replacements: { targetDate },
            type: QueryTypes.SELECT,
        }
    )
}

export const upsert52Week = async (rows: Stock52WeekRow[]): Promise<void> => {
    if (rows.length === 0) return

    const placeholders = rows.map(() => '(?,?,?,?,?,?,?,?)').join(',')
    const flat = rows.flatMap((r) => [
        r.stock_code,
        r.trade_date,
        r.close_price,
        r.change_rate,
        r.high_52week,
        r.high_52week_date,
        r.low_52week,
        r.low_52week_date,
    ])

    await sequelize.query(
        `INSERT INTO stock_52week
       (stock_code, trade_date, close_price, change_rate,
        high_52week, high_52week_date, low_52week, low_52week_date)
     VALUES ${placeholders}
     ON DUPLICATE KEY UPDATE
       close_price      = VALUES(close_price),
       change_rate      = VALUES(change_rate),
       high_52week      = VALUES(high_52week),
       high_52week_date = VALUES(high_52week_date),
       low_52week       = VALUES(low_52week),
       low_52week_date  = VALUES(low_52week_date)`,
        { replacements: flat, type: QueryTypes.INSERT }
    )
}

export const getLastSavedDate = async (): Promise<string | null> => {
    const rows = await sequelize.query<{ last_date: string | null }>(
        `SELECT MAX(trade_date) AS last_date FROM stock_52week`,
        { type: QueryTypes.SELECT }
    )
    return rows[0]?.last_date ?? null
}

// ─── 날짜 유틸 ────────────────────────────────────────────────

export const getToday = (): string =>
    new Date().toISOString().slice(0, 10)

export const dayAfter = (dateStr: string): string => {
    const d = new Date(dateStr)
    d.setDate(d.getDate() + 1)
    return d.toISOString().slice(0, 10)
}