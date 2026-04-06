import { QueryTypes } from 'sequelize'
import sequelize from '../../config/database'

// ─── 기술적 데이터 조회 ───────────────────────────────────────

interface TechnicalData {
    close: number | null              // 당일 종가
    high_52week: number | null        // 52주 고가
    low_52week: number | null         // 52주 저가
    avg_volume_20: number | null      // 20일 평균 거래량
    today_volume: number | null       // 당일 거래량
    volatility: number | null         // 20일 변동성 (표준편차)
    vix: number | null                // VIX 지수
}

const getTechnicalData = async (stockId: number, stockCode: string, calcDate: string): Promise<TechnicalData> => {
    // 당일 종가 + 당일 거래량
    const todayRows = await sequelize.query<{ close: number | null, volume: number | null }>(
        `SELECT close, volume
         FROM stock_prices
         WHERE stock_id = :stockId AND price_date = :calcDate`,
        { replacements: { stockId, calcDate }, type: QueryTypes.SELECT }
    )

    // 52주 고가/저가
    const week52Rows = await sequelize.query<{ high_52week: number | null, low_52week: number | null }>(
        `SELECT high_52week, low_52week
         FROM stock_52week
         WHERE stock_code = :stockCode AND trade_date = :calcDate`,
        { replacements: { stockCode, calcDate }, type: QueryTypes.SELECT }
    )

    // 20일 평균 거래량 + 변동성 (등락률 표준편차)
    const statsRows = await sequelize.query<{ avg_volume: number | null, volatility: number | null }>(
        `SELECT
             AVG(volume) AS avg_volume,
             STDDEV(change_rate) AS volatility
         FROM (
                  SELECT
                      volume,
                      (close - LAG(close) OVER (ORDER BY price_date)) / LAG(close) OVER (ORDER BY price_date) * 100 AS change_rate
                  FROM stock_prices
                  WHERE stock_id = :stockId
                    AND price_date <= :calcDate
                    AND price_date >= DATE_SUB(:calcDate, INTERVAL 21 DAY)
              ) t
         WHERE change_rate IS NOT NULL`,
        { replacements: { stockId, calcDate }, type: QueryTypes.SELECT }
    )

    // VIX 최근값
    const vixRows = await sequelize.query<{ vix: number | null }>(
        `SELECT close_price AS vix
         FROM market_indices
         WHERE index_symbol = 'VIX'
           AND trade_date <= :calcDate
         ORDER BY trade_date DESC LIMIT 1`,
        { replacements: { calcDate }, type: QueryTypes.SELECT }
    )

    return {
        close: todayRows[0]?.close ?? null,
        high_52week: week52Rows[0]?.high_52week ?? null,
        low_52week: week52Rows[0]?.low_52week ?? null,
        avg_volume_20: statsRows[0]?.avg_volume ?? null,
        today_volume: todayRows[0]?.volume ?? null,
        volatility: statsRows[0]?.volatility ?? null,
        vix: vixRows[0]?.vix ?? null,
    }
}

// ─── 점수 계산 ────────────────────────────────────────────────

// 52주 위치 점수 (10점)
const calc52WeekScore = (
    close: number | null,
    high52: number | null,
    low52: number | null
): number => {
    if (!close || !high52 || !low52 || high52 === low52) return 0
    const position = ((close - low52) / (high52 - low52)) * 100
    if (position >= 20 && position <= 60) return 10
    if (position > 60 && position <= 80) return 5
    return 0
}

// 거래량 점수 (10점)
const calcVolumeScore = (
    todayVolume: number | null,
    avgVolume: number | null
): number => {
    if (!todayVolume || !avgVolume || avgVolume === 0) return 0
    const ratio = todayVolume / avgVolume
    if (ratio >= 0.5 && ratio <= 2) return 10
    if (ratio < 0.5) return 5
    return 5  // 2배 초과도 변동성 위험이라 5점
}

// 변동성 점수 (10점)
const calcVolatilityScore = (volatility: number | null): number => {
    if (volatility === null) return 0
    if (volatility < 1) return 10
    if (volatility <= 3) return 5
    return 0
}

// VIX 점수 (10점)
const calcVixScore = (vix: number | null): number => {
    if (vix === null) return 0
    if (vix <= 20) return 10
    if (vix <= 30) return 5
    return 0
}

// ─── 기술적 안정성 총점 계산 ──────────────────────────────────

export interface TechnicalScoreResult {
    week52_score: number
    volume_score: number
    volatility_score: number
    vix_score: number
    technical_score: number  // 총점 (40점 만점)
}

export const calcTechnicalScore = async (
    stockId: number,
    stockCode: string,
    calcDate: string
): Promise<TechnicalScoreResult> => {
    const data = await getTechnicalData(stockId, stockCode, calcDate)

    const week52_score     = calc52WeekScore(data.close, data.high_52week, data.low_52week)
    const volume_score     = calcVolumeScore(data.today_volume, data.avg_volume_20)
    const volatility_score = calcVolatilityScore(data.volatility)
    const vix_score        = calcVixScore(data.vix)

    const technical_score = week52_score + volume_score + volatility_score + vix_score

    return {
        week52_score,
        volume_score,
        volatility_score,
        vix_score,
        technical_score,
    }
}