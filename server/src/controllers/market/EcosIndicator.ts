import { Request, Response } from 'express'
import { Op, QueryTypes } from 'sequelize'
import EcosIndicator from '../../models/market/EcosIndicator'
import sequelize from '../../config/database'

// ─── KOSPI/KOSDAQ 조회 ───────────────────────────────────────
// /api/market/ecos/:indicator?from=20260101&to=20260418

export const getEcosIndicators = async (req: Request, res: Response): Promise<void> => {
    try {
        const { indicator } = req.params
        const from = req.query.from as string | undefined
        const to = req.query.to as string | undefined

        const where: any = { indicator }

        if (from && to) {
            where.time_period = { [Op.between]: [from, to] }
        } else if (from) {
            where.time_period = { [Op.gte]: from }
        } else if (to) {
            where.time_period = { [Op.lte]: to }
        }

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

// ─── 미국 지수 조회 ──────────────────────────────────────────
// /api/market/ecos/index/:symbol?from=2025-01-01&to=2026-04-18
// symbol: US500 (S&P500), IXIC (NASDAQ), DJI (DOW)

export const getMarketIndex = async (req: Request, res: Response): Promise<void> => {
    try {
        const { symbol } = req.params
        const from = req.query.from as string | undefined
        const to = req.query.to as string | undefined

        const allowedSymbols = ['US500', 'IXIC', 'DJI']
        if (!allowedSymbols.includes(symbol as string)) {
            res.status(400).json({ success: false, message: '지원하지 않는 지수입니다.' })
            return
        }

        let query = `
            SELECT trade_date, close_price AS value, change_rate
            FROM market_indices
            WHERE index_symbol = :symbol
        `
        const replacements: any = { symbol }

        if (from && to) {
            query += ` AND trade_date BETWEEN :from AND :to`
            replacements.from = from
            replacements.to = to
        } else if (from) {
            query += ` AND trade_date >= :from`
            replacements.from = from
        } else if (to) {
            query += ` AND trade_date <= :to`
            replacements.to = to
        }

        query += ` ORDER BY trade_date ASC`

        const data = await sequelize.query(query, {
            replacements,
            type: QueryTypes.SELECT,
        })

        res.json({ success: true, data })
    } catch (err) {
        console.error('[MarketIndex] 조회 오류:', err)
        res.status(500).json({ success: false, message: '지수 조회 실패' })
    }
}