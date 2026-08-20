import { DataTypes, Model, Optional } from 'sequelize'
import sequelize from '../../config/database'

// AI 예측 배치 결과 — predict_v97.py 출력을 적재한 테이블
// DB 마이그레이션: src/database/migrations/20260730_stock_predictions.sql
interface StockPredictionAttributes {
  id: number
  predict_date: string
  ticker: string
  horizon: string
  prob: number
  confidence: number
  direction: 'UP' | 'DOWN'
  recommended: boolean
  conf_rank: number
  model_version: string
  created_at?: Date
}

interface StockPredictionCreationAttributes
  extends Optional<StockPredictionAttributes, 'id' | 'created_at'> {}

class StockPrediction
  extends Model<StockPredictionAttributes, StockPredictionCreationAttributes>
  implements StockPredictionAttributes
{
  public id!: number
  public predict_date!: string
  public ticker!: string
  public horizon!: string
  public prob!: number
  public confidence!: number
  public direction!: 'UP' | 'DOWN'
  public recommended!: boolean
  public conf_rank!: number
  public model_version!: string
  public readonly created_at!: Date
}

StockPrediction.init(
  {
    id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    predict_date: { type: DataTypes.DATEONLY, allowNull: false },
    ticker: { type: DataTypes.STRING(12), allowNull: false },
    horizon: { type: DataTypes.STRING(4), allowNull: false },
    prob: { type: DataTypes.DECIMAL(6, 5), allowNull: false, get() { return Number(this.getDataValue('prob')) } },
    confidence: { type: DataTypes.DECIMAL(6, 5), allowNull: false, get() { return Number(this.getDataValue('confidence')) } },
    direction: { type: DataTypes.ENUM('UP', 'DOWN'), allowNull: false },
    recommended: { type: DataTypes.BOOLEAN, allowNull: false },
    conf_rank: { type: DataTypes.INTEGER, allowNull: false },
    model_version: { type: DataTypes.STRING(20), allowNull: false },
    created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  },
  {
    sequelize,
    tableName: 'stock_predictions',
    timestamps: false,
    indexes: [
      { unique: true, fields: ['predict_date', 'ticker', 'horizon'] },
      { fields: ['horizon', 'predict_date', 'recommended'] },
      { fields: ['ticker', 'horizon', 'predict_date'] },
    ],
  },
)

export default StockPrediction
