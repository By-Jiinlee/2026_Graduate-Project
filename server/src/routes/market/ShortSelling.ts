import { Router } from 'express'
import { getShortSelling, triggerCollect } from '../../controllers/market/ShortSelling'

const router = Router()

// GET /api/market/short-selling/:stockId?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/:stockId', getShortSelling)

// POST /api/market/short-selling/collect (관리자용 수동 수집)
router.post('/collect', triggerCollect)

export default router