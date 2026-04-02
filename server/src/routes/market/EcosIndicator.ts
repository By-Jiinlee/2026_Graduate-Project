import { Router } from 'express'
import { getEcosIndicators, triggerCollect } from '../../controllers/market/EcosIndicator'

const router = Router()

// GET /api/market/ecos/:indicator?from=202401&to=202412
router.get('/:indicator', getEcosIndicators)

// POST /api/market/ecos/collect  body: { cycle: 'D' | 'M' | 'Q' }
router.post('/collect', triggerCollect)

export default router