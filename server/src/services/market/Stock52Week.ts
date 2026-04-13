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
    market_cap: number | null
}

// ─── DB 계산 ──────────────────────────────────────────────────

export const calculate52Week = async (targetDate: string): Promise<Stock52WeekRow[]> => {
    return sequelize.query<Stock52WeekRow>(
        `SELECT
             s.code AS stock_code,
             :targetDate AS trade_date,
             today.close AS close_price,
             ROUND((today.close - prev.close) / prev.close * 100, 2) AS change_rate,
             w.high_52week,
             (
                 SELECT price_date FROM stock_prices
                 WHERE stock_id = s.id
                   AND high = w.high_52week
                   AND price_date >= DATE_SUB(:targetDate, INTERVAL 52 WEEK)
                   AND price_date <= :targetDate
                 ORDER BY price_date DESC LIMIT 1
             ) AS high_52week_date,
             w.low_52week,
             (
                 SELECT price_date FROM stock_prices
                 WHERE stock_id = s.id
                   AND low = w.low_52week
                   AND price_date >= DATE_SUB(:targetDate, INTERVAL 52 WEEK)
                   AND price_date <= :targetDate
                 ORDER BY price_date DESC LIMIT 1
             ) AS low_52week_date,
             FLOOR(today.close * s.listed_shares / 1000000) AS market_cap
         FROM stocks s
             JOIN (
             SELECT stock_id, MAX(high) AS high_52week, MIN(low) AS low_52week
             FROM stock_prices
             WHERE price_date >= DATE_SUB(:targetDate, INTERVAL 52 WEEK)
             AND price_date <= :targetDate
             GROUP BY stock_id
             ) w ON w.stock_id = s.id
             JOIN stock_prices today ON today.stock_id = s.id AND today.price_date = :targetDate
             LEFT JOIN stock_prices prev ON prev.stock_id = s.id
             AND prev.price_date = (
             SELECT MAX(price_date) FROM stock_prices
             WHERE stock_id = s.id AND price_date < :targetDate
             )
         WHERE s.is_active = 1 AND s.market IN ('KOSPI', 'KOSDAQ')`,
        {
            replacements: { targetDate },
            type: QueryTypes.SELECT,
        }
    )
}

export const upsert52Week = async (rows: Stock52WeekRow[]): Promise<void> => {
    if (rows.length === 0) return

    const placeholders = rows.map(() => '(?,?,?,?,?,?,?,?,?)').join(',')
    const flat = rows.flatMap((r) => [
        r.stock_code,
        r.trade_date,
        r.close_price,
        r.change_rate,
        r.high_52week,
        r.high_52week_date,
        r.low_52week,
        r.low_52week_date,
        r.market_cap,
    ])

    await sequelize.query(
        `INSERT INTO stock_52week
         (stock_code, trade_date, close_price, change_rate,
          high_52week, high_52week_date, low_52week, low_52week_date, market_cap)
         VALUES ${placeholders}
             ON DUPLICATE KEY UPDATE
                                  close_price      = VALUES(close_price),
                                  change_rate      = VALUES(change_rate),
                                  high_52week      = VALUES(high_52week),
                                  high_52week_date = VALUES(high_52week_date),
                                  low_52week       = VALUES(low_52week),
                                  low_52week_date  = VALUES(low_52week_date),
                                  market_cap       = VALUES(market_cap)`,
        { replacements: flat, type: QueryTypes.INSERT }
    )
}

// 가장 최근 저장일 조회 (신규 날짜 수집 기준)
export const getLastSavedDate = async (): Promise<string | null> => {
    const rows = await sequelize.query<{ last_date: string | null }>(
        `SELECT MAX(trade_date) AS last_date FROM stock_52week`,
        { type: QueryTypes.SELECT }
    )
    return rows[0]?.last_date ?? null
}

// 가장 처음 저장일 조회 (누락 탐지 시작 기준)
export const getCollectStartDate = async (): Promise<string | null> => {
    const rows = await sequelize.query<{ first_date: string | null }>(
        `SELECT MIN(trade_date) AS first_date FROM stock_52week`,
        { type: QueryTypes.SELECT }
    )
    return rows[0]?.first_date ?? null
}

// ─── 종목별 누락 날짜 탐지 ────────────────────────────────────
// since 이후 stock_prices 기준 영업일 중 stock_52week에 없는 날짜를 반환
// COLLATE 명시로 collation 충돌 에러 방지

export const getMissingDatesPerStock = async (
    since: string
): Promise<Map<string, string[]>> => {
    const rows = await sequelize.query<{ stock_code: string; missing_date: string }>(
        `SELECT s.code AS stock_code,
                DATE_FORMAT(sp.price_date, '%Y-%m-%d') AS missing_date
         FROM stocks s
         JOIN stock_prices sp ON sp.stock_id = s.id
         LEFT JOIN stock_52week w
               ON w.stock_code COLLATE utf8mb4_0900_ai_ci = s.code
               AND w.trade_date = sp.price_date
         WHERE s.is_active = 1
           AND s.market IN ('KOSPI', 'KOSDAQ')
           AND sp.price_date >= :since
           AND w.trade_date IS NULL
         ORDER BY s.code, sp.price_date`,
        { replacements: { since }, type: QueryTypes.SELECT }
    )

    const map = new Map<string, string[]>()
    for (const row of rows) {
        if (!map.has(row.stock_code)) map.set(row.stock_code, [])
        map.get(row.stock_code)!.push(row.missing_date)
    }
    return map
}

// ─── 날짜 유틸 ────────────────────────────────────────────────

export const getToday = (): string =>
    new Date().toISOString().slice(0, 10)

export const dayAfter = (dateStr: string): string => {
    const d = new Date(dateStr)
    d.setDate(d.getDate() + 1)
    return d.toISOString().slice(0, 10)
}
