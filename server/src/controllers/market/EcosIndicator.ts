import { Request, Response } from 'express'
import EcosIndicator from '../../models/market/EcosIndicator'
import {
    collectDailyIndicators,
    collectMonthlyIndicators,
    collectQuarterlyIndicators,
} from '../../schedulers/market/EcosIndicator'

// 지표 조회
export const getEcosIndicators = async (req: Request, res: Response): Promise<void> => {
    try {
        const { indicator } = req.params
        const { from, to } = req.query

        const where: any = { indicator }
        if (from) where.time_period = { ...where.time_period, $gte: from }
        if (to) where.time_period = { ...where.time_period, $lte: to }

        const data = await EcosIndicator.findAll({
            where,
            order: [['time_period', 'ASC']],
        })

        res.json({ success: true, data })
    } catch (err) {
        console.error('[EcosIndicator] 조회 오류:', err)
        res.status(500).json({ success: false, message: '지표 조회 실패' })
    }
}

// 수동 수집 트리거 (관리자용)
export const triggerCollect = async (req: Request, res: Response): Promise<void> => {
    try {
        const { cycle } = req.body  // 'D' | 'M' | 'Q'

        if (cycle === 'D') collectDailyIndicators()
        else if (cycle === 'M') collectMonthlyIndicators()
        else if (cycle === 'Q') collectQuarterlyIndicators()
        else {
            collectDailyIndicators()
            collectMonthlyIndicators()
            collectQuarterlyIndicators()
        }

        res.json({ success: true, message: `${cycle ?? '전체'} 수집 시작됨` })
    } catch (err) {
        console.error('[EcosIndicator] 수집 트리거 오류:', err)
        res.status(500).json({ success: false, message: '수집 트리거 실패' })
    }
}