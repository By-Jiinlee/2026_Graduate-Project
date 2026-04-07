import { Request, Response } from 'express';
import { QueryTypes } from 'sequelize';
import sequelize from '../../config/database';
import StockPrice from '../../models/market/StockPrice';
import { collectStockPrices } from '../../schedulers/market/StockPrice';

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
                s.market, -- 시장 구분(KOSPI, KOSDAQ) 정보 추가
                sp.close AS price, 
                (sp.close - sp.open) AS \`change\`,
                ((sp.close - sp.open) / sp.open * 100) AS changeRate,
                sp.volume
            FROM stocks s
            JOIN stock_prices sp ON s.id = sp.stock_id
            WHERE sp.price_date = (SELECT MAX(price_date) FROM stock_prices)
              AND s.is_active = 1
              AND s.market IN ('KOSPI', 'KOSDAQ')
            ORDER BY sp.volume DESC; -- 거래량 높은 순 정렬
        `;

        const latestPrices = await sequelize.query(query, {
            type: QueryTypes.SELECT
        });

        res.json({ 
            success: true, 
            data: latestPrices 
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
            id: number; name: string; code: string; market: string;
            price: number; change: number; changeRate: number; volume: number;
        }>(
            `SELECT s.id, s.name, s.code, s.market,
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
                LIMIT 90
             ) t ORDER BY time ASC`,
            { replacements: { stockId }, type: QueryTypes.SELECT }
        )

        if (!info) { res.status(404).json({ success: false, message: '종목을 찾을 수 없습니다' }); return }

        res.json({ success: true, info, candles })
    } catch (err) {
        console.error('[StockPrice] 상세 조회 오류:', err)
        res.status(500).json({ success: false, message: '상세 조회 실패' })
    }
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