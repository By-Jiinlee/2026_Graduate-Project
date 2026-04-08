import { DataTypes, Model, Optional } from 'sequelize'
import sequelize from '../../config/database'

export type AnomalyType = 'BRUTE_FORCE' | 'ABNORMAL_TIME' | 'CONCURRENT_SESSION' | 'ABNORMAL_COUNTRY'
export type AnomalyAction = 'ALERT' | 'BLOCK' | 'LOCK'

interface AnomalyLogAttributes {
  id: number
  user_id: number | null
  email: string | null
  ip: string
  user_agent: string | null
  anomaly_type: AnomalyType
  action: AnomalyAction
  detail: string
  country: string | null
  resolved: boolean
  created_at?: Date
}

interface AnomalyLogCreationAttributes
  extends Optional<AnomalyLogAttributes, 'id' | 'resolved'> {}

class AnomalyLog
  extends Model<AnomalyLogAttributes, AnomalyLogCreationAttributes>
  implements AnomalyLogAttributes
{
  public id!: number
  public user_id!: number | null
  public email!: string | null
  public ip!: string
  public user_agent!: string | null
  public anomaly_type!: AnomalyType
  public action!: AnomalyAction
  public detail!: string
  public country!: string | null
  public resolved!: boolean
  public readonly created_at!: Date
}

AnomalyLog.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    user_id: { type: DataTypes.BIGINT, allowNull: true },
    email: { type: DataTypes.STRING(100), allowNull: true },
    ip: { type: DataTypes.STRING(45), allowNull: false },
    user_agent: { type: DataTypes.TEXT, allowNull: true },
    anomaly_type: {
      type: DataTypes.ENUM('BRUTE_FORCE', 'ABNORMAL_TIME', 'CONCURRENT_SESSION', 'ABNORMAL_COUNTRY'),
      allowNull: false,
    },
    action: {
      type: DataTypes.ENUM('ALERT', 'BLOCK', 'LOCK'),
      allowNull: false,
    },
    detail: { type: DataTypes.TEXT, allowNull: false },
    country: { type: DataTypes.STRING(100), allowNull: true },
    resolved: { type: DataTypes.BOOLEAN, defaultValue: false },
    created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  },
  {
    sequelize,
    tableName: 'anomaly_logs',
    timestamps: false,
    indexes: [
      { fields: ['user_id'] },
      { fields: ['ip'] },
      { fields: ['anomaly_type'] },
      { fields: ['created_at'] },
    ],
  },
)

export default AnomalyLog
