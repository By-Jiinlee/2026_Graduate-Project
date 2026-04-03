import { Router } from 'express'
import { 
    getStockPrices, 
    triggerCollect, 
    getAllLatestPrices // 1. 전체 조회 컨트롤러 추가
} from '../../controllers/market/StockPrice'

const router = Router()

/**
 * [GET] 전체 종목의 최신 시세 리스트 조회
 * 주소: GET /api/market/stock-prices/all
 * 주의: /:stockId 라우트보다 반드시 위에 있어야 'all'을 ID로 인식하지 않습니다.
 */
router.get('/all', getAllLatestPrices)

/**
 * [GET] 특정 종목의 기간별 상세 시세 조회
 * 주소: GET /api/market/stock-prices/:stockId?from=YYYY-MM-DD&to=YYYY-MM-DD
 */
router.get('/:stockId', getStockPrices)

/**
 * [POST] 한국투자증권 데이터 수동 수집 트리거 (관리자용)
 * 주소: POST /api/market/stock-prices/collect
 */
router.post('/collect', triggerCollect)

export default router