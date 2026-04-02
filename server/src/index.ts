import express from 'express'
import dotenv from 'dotenv'
import cors from 'cors'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import morgan from 'morgan'
import { connectDB } from './config/database'
import authRouter from './routes/auth/authRouter'
import contractTestRouter from './routes/auth/contractTestRouter'

// 스케줄러
import stockPriceRouter from './routes/market/StockPrice'
import { startStockPriceScheduler } from './schedulers/market/StockPrice'
import financialStatementRouter from './routes/market/FinancialStatement'
import { startFinancialStatementScheduler } from './schedulers/market/FinancialStatement'
import ecosIndicatorRouter from './routes/market/EcosIndicator'
import { startEcosIndicatorScheduler } from './schedulers/market/EcosIndicator'
import shortSellingRouter from './routes/market/ShortSelling'
import { startShortSellingScheduler } from './schedulers/market/ShortSelling'
import { startStock52WeekScheduler } from './schedulers/market/Stock52Week'
import { startForeignAndInstitutionalScheduler } from './schedulers/market/ForeignAndInstitutional'

dotenv.config()

const app = express()
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

// 스케줄러 라우터
app.use('/api/market/stock-prices', stockPriceRouter)
app.use('/api/market/financial-statements', financialStatementRouter)
app.use('/api/market/ecos', ecosIndicatorRouter)
app.use('/api/market/short-selling', shortSellingRouter)

// DB 연결
connectDB()

// 서버 실행
app.listen(PORT, () => {
    console.log(`서버 실행 중 : http://localhost:${PORT}`)
    //startStockPriceScheduler()
    //startFinancialStatementScheduler()
    //startEcosIndicatorScheduler()
    //startShortSellingScheduler()
    //startStock52WeekScheduler()
    //startForeignAndInstitutionalScheduler()
})

export default app