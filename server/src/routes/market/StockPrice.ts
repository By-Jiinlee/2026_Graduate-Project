import { Router } from 'express'
import {
    getStockPrices,
    triggerCollect,
    getAllLatestPrices,
    getStockDetail,
    getMinuteCandles,
    getRealtimeStatusController,
    getKisHistory,
} from '../../controllers/market/StockPrice'

const router = Router()

router.get('/all', getAllLatestPrices)
router.get('/realtime-status', getRealtimeStatusController)

router.get('/:stockId/detail', getStockDetail)
router.get('/:stockId/history', getKisHistory)  // KIS 직접 조회 (D/W/M)
router.get('/:stockId/minute', getMinuteCandles)
router.get('/:stockId', getStockPrices)

/**
 * [POST] 한국투자증권 데이터 수동 수집 트리거 (관리자용)
 * 주소: POST /api/market/stock-prices/collect
 */
router.post('/collect', triggerCollect)

export default router