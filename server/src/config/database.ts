import { Sequelize } from 'sequelize'
import dotenv from 'dotenv'
dotenv.config()

const sequelize = new Sequelize(
  process.env.DB_NAME as string,
  process.env.DB_USER as string,
  process.env.DB_PASSWORD as string,
  {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    dialect: 'mysql',
    logging: false,
    pool: {
      max: 10,
      min: 0,
      acquire: 30000,
      idle: 10000,
    },
  },
)

export const connectDB = async () => {
  try {
    await sequelize.authenticate()
    console.log('DB 연결 성공')
  } catch (error) {
    console.error('DB 연결 실패:', error)
    process.exit(1)
  }
}

export default sequelize
