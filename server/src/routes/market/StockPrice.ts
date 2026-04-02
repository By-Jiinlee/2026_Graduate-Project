import { Router } from 'express'
import { getStockPrices, triggerCollect } from '../../controllers/market/StockPrice'

const router = Router()

// GET /api/market/stock-prices/:stockId?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/:stockId', getStockPrices)

// POST /api/market/stock-prices/collect  (관리자용 수동 수집)
router.post('/collect', triggerCollect)

export default router