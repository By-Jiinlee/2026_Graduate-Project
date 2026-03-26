import express from 'express'
import dotenv from 'dotenv'
import cors from 'cors'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import morgan from 'morgan'
import { connectDB } from './config/database'
import authRouter from './routes/auth/authRouter'
import contractTestRouter from './routes/auth/contractTestRouter'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 3000

// 미들웨어
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(cookieParser())
app.use(morgan('dev'))
app.use(helmet())
app.use(
  cors({
    origin: 'http://localhost:5173',
    credentials: true,
  }),
)

// 라우터
app.use('/api/auth', authRouter)
app.use('/api/auth', authRouter)
app.use('/api/contract', contractTestRouter)

// DB 연결
connectDB()

// 서버 실행
app.listen(PORT, () => {
  console.log(`서버 실행 중 : http://localhost:${PORT}`)
})

export default app
