import { Sequelize } from 'sequelize'
import dotenv from 'dotenv'
dotenv.config()

// 접속 정보는 DATABASE_URL 하나로만 받는다.
// 예전에는 값이 없으면 DB_HOST/DB_NAME 등으로 조용히 폴백했는데, 그 경로는 실제로
// 쓰이지 않으면서 URL 을 빠뜨렸을 때 "undefined 로 접속 시도" 라는 알아보기 어려운
// 에러만 만들었다. 설정 누락은 기동 시점에 분명한 메시지로 끝내는 편이 낫다.
const DATABASE_URL = process.env.DATABASE_URL?.trim()
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL 이 설정되지 않았습니다 — server/.env 를 확인하세요.')
}

// 레일웨이 내부 네트워크(*.railway.internal)는 컨테이너 간 사설망이라 TLS 를 제공하지
// 않는다. 공개 프록시로 붙을 때만 TLS 를 요구한다 — 내부 주소에 ssl.require 를 걸면
// 핸드셰이크 단계에서 연결 자체가 실패한다.
const DB_HOST = new URL(DATABASE_URL).hostname
const IS_INTERNAL = DB_HOST.endsWith('.railway.internal')

const sequelize = new Sequelize(DATABASE_URL, {
  dialect: 'mysql',
  logging: false,
  dialectOptions: {
    ...(IS_INTERNAL ? {} : {
      ssl: {
        require: true,
        rejectUnauthorized: false,
      },
    }),
    // Railway 프록시 경유라 최초 핸드셰이크가 4초 내외로 느리다. mysql2 기본
    // 10초로는 네트워크가 흔들릴 때 연결 자체가 끊겨 정상 요청까지 실패한다.
    connectTimeout: 60_000,
    charset: 'utf8mb4',
  },
  pool: {
    max: 10,
    min: 0,
    acquire: 60_000,
    idle: 10_000,
  },
})

export const connectDB = async () => {
  try {
    await sequelize.authenticate()
    // 접속 대상을 로그로 남기되 자격 증명은 노출하지 않는다
    console.log(`DB 연결 성공 (${new URL(DATABASE_URL).host})`)
  } catch (error) {
    console.error('DB 연결 실패:', error)
    process.exit(1)
  }
}

export default sequelize