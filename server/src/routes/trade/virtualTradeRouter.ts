import { Router } from 'express'
import { isAuthenticated } from '../../middleware/auth/authMiddleware'
import * as ctrl from '../../controllers/trade/virtualTradeController'


const router = Router()

router.use(isAuthenticated)

router.post('/pin', ctrl.setPin)                  // PIN 설정
router.post('/account/open', ctrl.openAccount)    // 계좌 개설
router.post('/buy', ctrl.buyStock)                // 매수
router.post('/sell', ctrl.sellStock)              // 매도
router.get('/portfolio', ctrl.getPortfolio)       // 포트폴리오 조회
router.get('/orders', ctrl.getOrders)             // 거래내역 조회

export default router
