import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import dotenv from 'dotenv'
import cors from 'cors'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import morgan from 'morgan'
import { connectDB } from './config/database'
import { corsOptions, socketCorsOptions, describeCorsPolicy } from './config/cors'
import { initUserChannels } from './services/socket/userChannel'
import authRouter from './routes/auth/authRouter'
import contractTestRouter from './routes/auth/contractTestRouter'
import honeypotRouter from './routes/security/honeypotRouter'
import adminRouter from './routes/security/adminRouter'
import { ipBlockMiddleware } from './middleware/security/ipBlockMiddleware'
import virtualTradeRouter from './routes/trade/virtualTradeRouter'
import tradePinRouter from './routes/trade/tradePinRouter'
import realTradeRouter from './routes/trade/realTradeRouter'
import surveyRouter from './routes/user/surveyRouter'
import userRouter from './routes/user/userRouter'
import predictionRouter from './routes/ai/predictionRouter'

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
import { startCommodityScheduler } from './schedulers/market/Commodity'
import { startStabilityScheduler } from './schedulers/market/Stability'
import { startKisRealtime } from './services/market/KisRealtime'
import { startMarketIndexRealtime } from './services/market/MarketIndexRealtime'
import { startLimitOrderScheduler } from './schedulers/trade/limitOrderScheduler'


dotenv.config()

const app = express()
const httpServer = createServer(app)
const io = new Server(httpServer, { cors: socketCorsOptions })
// 개인 이벤트(체결 알림 등)를 위한 사용자별 채널 — 쿠키 JWT 로 방을 배정한다.
initUserChannels(io)
const PORT = process.env.PORT || 3000

// 미들웨어
// HMAC 요청서명 검증을 위해 raw body를 보존 (서명 재계산 시 파싱 전 원본 필요)
app.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf.toString('utf8') } }))
app.use(express.urlencoded({ extended: true }))
app.use(cookieParser())
app.use(morgan('dev'))
app.use(helmet())
app.set('trust proxy', true) // 이상탐지 테스트용
app.use(cors(corsOptions))

// 보안 미들웨어 — 모든 라우터보다 먼저 실행
app.use(ipBlockMiddleware)  // 인메모리 IP 차단 목록 검사
app.use(honeypotRouter)     // 허니팟 경로 탐지

// 라우터
app.use('/api/auth', authRouter)
app.use('/api/admin/security', adminRouter)
app.use('/api/test', contractTestRouter)
// 거래 PIN 은 모의투자·실거래 공용이라 어느 한쪽 라우터에도 두지 않는다.
app.use('/api/trade/pin', tradePinRouter)
app.use('/api/trade/virtual', virtualTradeRouter)
app.use('/api/trade/real', realTradeRouter)
app.use('/api/survey', surveyRouter)
app.use('/api/user', userRouter)
app.use('/api/ai', predictionRouter)

// 스케줄러 라우터
app.use('/api/market/stock-prices', stockPriceRouter)
app.use('/api/market/ecos', ecosIndicatorRouter)

// DB 연결
connectDB()

// 서버 실행
httpServer.listen(PORT, () => {
    console.log(`서버 실행 중 : http://localhost:${PORT}`)
    console.log(describeCorsPolicy())
    // ── 시장 데이터 수집 ────────────────────────────────────
    // KIS 유량은 앱키 단위로 공유되므로 KIS 수집기는 시각을 겹치지 않게 배치했다.
    // 각 스케줄러 파일의 cron 주석 참고.
    //
    // 기동 직후 1회 수집은 기본으로 꺼져 있다(RUN_INITIAL_COLLECT). 재배포·재시작이
    // 잦은 환경에서 그때마다 전종목 수집이 처음부터 도는 것을 막기 위함이다.

    // KIS 사용 — 순차 실행
    startStockPriceScheduler()              // 일봉        평일 16:00
    startShortSellingScheduler()            // 공매도      평일 16:20
    startForeignAndInstitutionalScheduler() // 수급        평일 17:35
    // 분봉은 로컬에서 수동 수집 중이라 잠시 중단한다. 같은 KIS 앱키를 쓰므로
    // 양쪽이 동시에 돌면 유량 초과로 서로 실패한다. 로컬 수집이 끝나면 되살릴 것.
    //startMinuteCandleScheduler()          // 분봉        평일 08:00 / 19:20
    startListedSharesScheduler()            // 상장주식수  매주 월 07:00

    // 외부 API — KIS 와 무관
    startMarketIndexScheduler()             // 미국지수    평일 18:00 (Yahoo)
    startCommodityScheduler()               // 원자재      평일 18:00 (Yahoo)
    startEcosIndicatorScheduler()           // 거시경제    평일 18:00 (ECOS)
    startFinancialStatementScheduler()      // 재무제표    분기 1회 (DART)

    // DB 계산 — 수집이 끝난 뒤 실행
    startStock52WeekScheduler()             // 52주 신고저 평일 19:50

    //startStabilityScheduler() //안정성 계산 — AI 피처에 쓰이지 않아 보류

    // 실시간 시세 (온디맨드 폴링 항상 활성, 전종목 크롤링은 ENABLE_FULL_CRAWL=true 필요)
    startKisRealtime(io).catch(err => console.error('[KisRealtime] 시작 실패:', err.message))
    startMarketIndexRealtime(io)        // 코스피, 코스닥, S&P 500, NASDAQ, DOW 실시간 지수

    // 지정가 체결 스케줄러 (항상 활성)
    startLimitOrderScheduler()
})