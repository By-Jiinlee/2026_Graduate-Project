import { Router } from 'express'
import { getEcosIndicators, getMarketIndex } from '../../controllers/market/EcosIndicator'

const router = Router()

// GET /api/market/ecos/:indicator?from=20260101&to=20260418
// indicator: kospi, kosdaq, base_rate, cpi, m2, ...
router.get('/:indicator', getEcosIndicators)

// GET /api/market/ecos/index/:symbol?from=2025-01-01&to=2026-04-18
// symbol: US500 (S&P500), IXIC (NASDAQ), DJI (DOW)
router.get('/index/:symbol', getMarketIndex)

export default router