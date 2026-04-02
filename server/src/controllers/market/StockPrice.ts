import { Request, Response } from 'express'
import StockPrice from '../../models/market/StockPrice'
import { collectStockPrices } from '../../schedulers/market/StockPrice'

// 특정 종목 일봉 조회
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

// 수동 수집 트리거 (관리자용)
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