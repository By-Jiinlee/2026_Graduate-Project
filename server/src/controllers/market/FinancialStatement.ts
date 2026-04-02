import { Request, Response } from 'express'
import FinancialStatement from '../../models/market/FinancialStatement'
import { collectFinancialStatements } from '../../schedulers/market/FinancialStatement'

// 특정 종목 재무제표 조회
export const getFinancialStatements = async (req: Request, res: Response): Promise<void> => {
    try {
        const { stockCode } = req.params
        const { type, year } = req.query

        const where: any = { stock_code: stockCode }
        if (type) where.statement_type = type
        if (year) where.fiscal_year_end = `${year}-12-31`

        const statements = await FinancialStatement.findAll({
            where,
            order: [['fiscal_year_end', 'DESC'], ['statement_type', 'ASC']],
        })

        res.json({ success: true, data: statements })
    } catch (err) {
        console.error('[FinancialStatement] 조회 오류:', err)
        res.status(500).json({ success: false, message: '재무제표 조회 실패' })
    }
}

// 수동 수집 트리거 (관리자용)
export const triggerCollect = async (_req: Request, res: Response): Promise<void> => {
    try {
        collectFinancialStatements().catch((err) =>
            console.error('[FinancialStatement] 수동 수집 오류:', err)
        )
        res.json({ success: true, message: '수집 시작됨' })
    } catch (err) {
        console.error('[FinancialStatement] 수집 트리거 오류:', err)
        res.status(500).json({ success: false, message: '수집 트리거 실패' })
    }
}