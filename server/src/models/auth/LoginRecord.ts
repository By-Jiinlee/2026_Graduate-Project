import { DataTypes, Model, Optional } from 'sequelize'
import sequelize from '../../config/database'

interface LoginRecordAttributes {
  id: number
  user_id: number
  wallet_address: string
  ip_address: string
  country?: string
  region?: string
  city?: string
  user_agent?: string
  logged_at: Date
}

interface LoginRecordCreationAttributes
  extends Optional<LoginRecordAttributes, 'id'> {}

class LoginRecord
  extends Model<LoginRecordAttributes, LoginRecordCreationAttributes>
  implements LoginRecordAttributes
{
  public id!: number
  public user_id!: number
  public wallet_address!: string
  public ip_address!: string
  public country?: string
  public region?: string
  public city?: string
  public user_agent?: string
  public logged_at!: Date
}

LoginRecord.init(
  {
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
    },
    user_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    wallet_address: {
      type: DataTypes.STRING(42),
      allowNull: false,
    },
    ip_address: {
      type: DataTypes.STRING(45),
      allowNull: false,
    },
    country: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    region: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    city: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    user_agent: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    logged_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    tableName: 'login_records',
    timestamps: false,
  },
)

export default LoginRecord