import { Request, Response } from 'express';
import { QueryTypes } from 'sequelize';
import sequelize from '../../config/database';
import StockPrice from '../../models/market/StockPrice';
import { collectStockPrices } from '../../schedulers/market/StockPrice';
import { priceMap, getRealtimeStatus } from '../../services/market/KisRealtime';
import { fetchDayCandles, upsertMinuteCandles } from '../../services/market/MinuteCandle';

/**
 * [GET] 전체 종목의 최신 시세 리스트 조회
 * UI의 '국내 종목 리스트'와 '시장 필터(코스피/코스닥)'를 위한 API입니다.
 * * * 수정 사항: 
 * 1. s.market 컬럼을 추가하여 프론트엔드에서 시장별 필터링이 가능하게 함.
 */
export const getAllLatestPrices = async (_req: Request, res: Response): Promise<void> => {
    try {
        const query = `
            SELECT
                s.id,
                s.name,
                s.code,
                s.market,
                CASE
                     WHEN s.name REGEXP '\\\\s+EF[A-Z0-9]*(\\\\s+[0-9]+)?$' THEN 'ETF'
                     WHEN s.name REGEXP '\\\\s+MF[A-Z0-9]*(\\\\s+[0-9]+)?$' THEN '펀드'
                     ELSE s.market
                END AS type,
                sp.close AS price,
                (sp.close - sp.open) AS \`change\`,
                ((sp.close - sp.open) / sp.open * 100) AS changeRate,
                sp.volume
            FROM stocks s
            JOIN stock_prices sp ON s.id = sp.stock_id
            WHERE sp.price_date = (
                SELECT price_date FROM stock_prices
                GROUP BY price_date
                ORDER BY COUNT(*) DESC, price_date DESC
                LIMIT 1
            )
              AND s.is_active = 1
              AND s.market IN ('KOSPI', 'KOSDAQ')
            ORDER BY sp.volume DESC;
        `;

        const latestPrices = await sequelize.query(query, {
            type: QueryTypes.SELECT
        });

        // 실시간 시세가 있으면 덮어씌우기
        const merged = (latestPrices as any[]).map(row => {
            const live = priceMap.get(row.code)
            if (live != null) {
                const open = Number(row.price) - Number(row.change)
                const change = live - open
                const changeRate = open !== 0 ? (change / open) * 100 : 0
                return { ...row, price: live, change, changeRate }
            }
            return row
        })

        res.json({
            success: true,
            data: merged
        });
    } catch (err) {
        console.error('[StockPrice] 전체 리스트 조회 오류:', err);
        res.status(500).json({ 
            success: false, 
            message: '전체 종목 리스트를 불러오는데 실패했습니다.' 
        });
    }
};

/**
 * [GET] 특정 종목 상세 조회 (기본 유지)
 */
export const getStockPrices = async (req: Request, res: Response): Promise<void> => {
    try {
        const { stockId } = req.params
        const { from, to } = req.query

        const where: any = { stock_id: stockId }
        if (from) where.price_date = { ...where.price_date, $gte: from }
        if (to) where.price_date = { ...where.price_date, $lte: to }

        const prices = await StockPrice.findAll({
            where,
            order: [['price_date', 'ASC']],
        })

        res.json({ success: true, data: prices })
    } catch (err) {
        console.error('[StockPrice] 조회 오류:', err)
        res.status(500).json({ success: false, message: '시세 조회 실패' })
    }
}

/**
 * [GET] 종목 기본정보 + 최근 90일 일봉 (상세 페이지용)
 * 주소: GET /api/market/stock-prices/:stockId/detail
 */
export const getStockDetail = async (req: Request, res: Response): Promise<void> => {
    try {
        const { stockId } = req.params

        const [info] = await sequelize.query<{
            id: number; name: string; code: string; market: string; type: string;
            price: number; change: number; changeRate: number; volume: number;
        }>(
            `SELECT s.id, s.name, s.code, s.market,
                    CASE
                         WHEN s.name REGEXP '\\\\s+EF[A-Z0-9]*(\\\\s+[0-9]+)?$' THEN 'ETF'
                         WHEN s.name REGEXP '\\\\s+MF[A-Z0-9]*(\\\\s+[0-9]+)?$' THEN '펀드'
                         ELSE s.market
                    END AS type,
                    sp.close AS price,
                    (sp.close - sp.open) AS \`change\`,
                    ((sp.close - sp.open) / sp.open * 100) AS changeRate,
                    sp.volume
             FROM stocks s
             JOIN stock_prices sp ON s.id = sp.stock_id
             WHERE s.id = :stockId
               AND sp.price_date = (SELECT MAX(price_date) FROM stock_prices WHERE stock_id = :stockId)`,
            { replacements: { stockId }, type: QueryTypes.SELECT }
        )

        const candles = await sequelize.query<{
            time: string; open: number; high: number; low: number; close: number; volume: number;
        }>(
            `SELECT * FROM (
                SELECT DATE_FORMAT(price_date, '%Y-%m-%d') AS time,
                       open, high, low, close, volume
                FROM stock_prices
                WHERE stock_id = :stockId
                ORDER BY price_date DESC
                LIMIT 3650
             ) t ORDER BY time ASC`,
            { replacements: { stockId }, type: QueryTypes.SELECT }
        )

        if (!info) { res.status(404).json({ success: false, message: '종목을 찾을 수 없습니다' }); return }

        // 실시간 시세가 있으면 덮어씌우기
        const live = priceMap.get(info.code)
        if (live != null) {
            const open = Number(info.price) - Number(info.change)
            info.price = live
            info.change = live - open
            info.changeRate = open !== 0 ? ((live - open) / open) * 100 : 0
        }

        res.json({ success: true, info, candles })
    } catch (err) {
        console.error('[StockPrice] 상세 조회 오류:', err)
        res.status(500).json({ success: false, message: '상세 조회 실패' })
    }
}

/**
 * [GET] 특정 종목 분봉 조회 (오늘 or 최근 거래일)
 * 주소: GET /api/market/stock-prices/:stockId/minute?interval=1
 */
export const getMinuteCandles = async (req: Request, res: Response): Promise<void> => {
    try {
        const { stockId } = req.params
        const interval = parseInt((req.query.interval as string) ?? '1')

        const todayStr = new Date().toISOString().slice(0, 10) // YYYY-MM-DD

        // 오늘 데이터 DB에 있는지 확인
        const [todayCheck] = await sequelize.query<{ cnt: number }>(
            `SELECT COUNT(*) AS cnt FROM stock_minute_candles
             WHERE stock_id = :stockId AND interval_min = :interval AND DATE(candle_time) = :today`,
            { replacements: { stockId, interval, today: todayStr }, type: QueryTypes.SELECT }
        )

        // 오늘 데이터가 없고 장 시간(09:00~16:00 KST)이면 KIS API에서 직접 가져오기
        if (Number(todayCheck.cnt) === 0) {
            const kstHour = new Date().getUTCHours() + 9  // KST = UTC+9
            const isMarketHours = kstHour >= 9 && kstHour < 16

            if (isMarketHours) {
                const [stockRow] = await sequelize.query<{ code: string }>(
                    `SELECT code FROM stocks WHERE id = :stockId`,
                    { replacements: { stockId }, type: QueryTypes.SELECT }
                )
                if (stockRow) {
                    const nowKst = new Date(Date.now() + 9 * 3600 * 1000)
                    const todayKst = nowKst.toISOString().slice(0, 10).replace(/-/g, '')
                    const startHour = `${String(nowKst.getUTCHours()).padStart(2, '0')}${String(nowKst.getUTCMinutes()).padStart(2, '0')}00`
                    const rows = await fetchDayCandles(stockRow.code, todayKst, startHour).catch(() => [])
                    if (rows.length > 0) {
                        await upsertMinuteCandles(Number(stockId), todayKst, rows)
                    }
                }
            }
        }

        // 분봉 데이터가 있는 가장 최근 날짜 기준으로 조회
        const candles = await sequelize.query<{
            time: string; open: number; high: number; low: number; close: number; volume: number;
        }>(
            `SELECT DATE_FORMAT(candle_time, '%Y-%m-%dT%H:%i:%S') AS time,
                    open, high, low, close, volume
             FROM stock_minute_candles
             WHERE stock_id = :stockId
               AND interval_min = :interval
               AND DATE(candle_time) = (
                   SELECT DATE(MAX(candle_time)) FROM stock_minute_candles
                   WHERE stock_id = :stockId AND interval_min = :interval
               )
             ORDER BY candle_time ASC`,
            { replacements: { stockId, interval }, type: QueryTypes.SELECT }
        )

        res.json({ success: true, candles })
    } catch (err) {
        console.error('[StockPrice] 분봉 조회 오류:', err)
        res.status(500).json({ success: false, message: '분봉 조회 실패' })
    }
}

/**
 * [GET] 실시간 시세 연결 상태 진단
 * 주소: GET /api/market/stock-prices/realtime-status
 */
export const getRealtimeStatusController = (_req: Request, res: Response): void => {
    res.json({ success: true, data: getRealtimeStatus() })
}

/**
 * [POST] 수동 수집 트리거 (기본 유지)
 */
export const triggerCollect = async (_req: Request, res: Response): Promise<void> => {
    try {
        collectStockPrices().catch((err) =>
            console.error('[StockPrice] 수동 수집 오류:', err)
        )
        res.json({ success: true, message: '수집 시작됨' })
    } catch (err) {
        console.error('[StockPrice] 수집 트리거 오류:', err)
        res.status(500).json({ success: false, message: '수집 트리거 실패' })
    }
}