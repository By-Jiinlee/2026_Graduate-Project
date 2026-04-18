import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import dotenv from 'dotenv'
import cors from 'cors'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import morgan from 'morgan'
import { connectDB } from './config/database'
import authRouter from './routes/auth/authRouter'
import contractTestRouter from './routes/auth/contractTestRouter'
import virtualTradeRouter from './routes/trade/virtualTradeRouter'
import surveyRouter from './routes/user/surveyRouter'

// 스케줄러
import stockPriceRouter from './routes/market/StockPrice'
import { startStockPriceScheduler } from './schedulers/market/StockPrice'
import { startFinancialStatementScheduler } from './schedulers/market/FinancialStatement'
import ecosIndicatorRouter from './routes/market/EcosIndicator'
import { startEcosIndicatorScheduler } from './schedulers/market/EcosIndicator'
import { startShortSellingScheduler } from './schedulers/market/ShortSelling'
import { startStock52WeekScheduler } from './schedulers/market/Stock52Week'
import { startForeignAndInstitutionalScheduler } from './schedulers/market/ForeignAndInstitutional'
import { startMarketIndexScheduler } from './schedulers/market/MarketIndex'
import { startListedSharesScheduler } from './schedulers/market/ListedShares'
import { startMinuteCandleScheduler } from './schedulers/market/MinuteCandle'
import { startStabilityScheduler } from './schedulers/market/Stability'
import { startKisRealtime } from './services/market/KisRealtime'
import { startMarketIndexRealtime } from './services/market/MarketIndexRealtime'
import { startLimitOrderScheduler } from './schedulers/trade/limitOrderScheduler'


dotenv.config()

const app = express()
const httpServer = createServer(app)
const io = new Server(httpServer, {
    cors: {
        origin: 'http://localhost:5173',
        credentials: true,
    },
})
const PORT = process.env.PORT || 3000

// 미들웨어
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(cookieParser())
app.use(morgan('dev'))
app.use(helmet())
app.use(cors({
    origin: 'http://localhost:5173',
    credentials: true,
}))

// 라우터
app.use('/api/auth', authRouter)
app.use('/api/test', contractTestRouter)
app.use('/api/trade/virtual', virtualTradeRouter)
app.use('/api/survey', surveyRouter)

// 스케줄러 라우터
app.use('/api/market/stock-prices', stockPriceRouter)
app.use('/api/market/ecos', ecosIndicatorRouter)

// DB 연결
connectDB()

// 서버 실행
httpServer.listen(PORT, () => {
    console.log(`서버 실행 중 : http://localhost:${PORT}`)
    // 1단계
    //startStockPriceScheduler() //일봉
    //startMarketIndexScheduler() //미국주요지수

// 2단계
    //startStock52WeekScheduler() //52주 신고가 신저가
    //startForeignAndInstitutionalScheduler() //투자자별 거래량
    //startShortSellingScheduler() //공매도
    //startMinuteCandleScheduler() //일분봉
    //startListedSharesScheduler() //상장주식수

// 3단계
    //startStabilityScheduler() //안정성 계산
    //startFinancialStatementScheduler()    //재무제표
    startEcosIndicatorScheduler() //거시경제

    // 실시간 시세 (온디맨드 폴링 항상 활성, 전종목 크롤링은 ENABLE_FULL_CRAWL=true 필요)
    startKisRealtime(io).catch(err => console.error('[KisRealtime] 시작 실패:', err.message))
    startMarketIndexRealtime(io)        // 코스피, 코스닥, S&P 500, NASDAQ, DOW 실시간 지수

    // 지정가 체결 스케줄러 (항상 활성)
    startLimitOrderScheduler()
})