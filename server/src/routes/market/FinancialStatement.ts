import { Router } from 'express'
import { getFinancialStatements, triggerCollect } from '../../controllers/market/FinancialStatement'

const router = Router()

// GET /api/market/financial-statements/:stockCode?type=BS&year=2024
router.get('/:stockCode', getFinancialStatements)

// POST /api/market/financial-statements/collect (관리자용 수동 수집)
router.post('/collect', triggerCollect)

export default router