import { Request, Response } from 'express'
import ShortSelling from '../../models/market/ShortSelling'
import { collectShortSelling } from '../../schedulers/market/ShortSelling'

// 특정 종목 공매도 조회
export const getShortSelling = async (req: Request, res: Response): Promise<void> => {
    try {
        const { stockId } = req.params
        const { from, to } = req.query

        const where: any = { stock_id: stockId }
        if (from) where.trade_date = { ...where.trade_date, $gte: from }
        if (to) where.trade_date = { ...where.trade_date, $lte: to }

        const data = await ShortSelling.findAll({
            where,
            order: [['trade_date', 'ASC']],
        })

        res.json({ success: true, data })
    } catch (err) {
        console.error('[ShortSelling] 조회 오류:', err)
        res.status(500).json({ success: false, message: '공매도 조회 실패' })
    }
}

// 수동 수집 트리거 (관리자용)
export const triggerCollect = async (_req: Request, res: Response): Promise<void> => {
    try {
        collectShortSelling().catch((err) =>
            console.error('[ShortSelling] 수동 수집 오류:', err)
        )
        res.json({ success: true, message: '수집 시작됨' })
    } catch (err) {
        console.error('[ShortSelling] 수집 트리거 오류:', err)
        res.status(500).json({ success: false, message: '수집 트리거 실패' })
    }
}