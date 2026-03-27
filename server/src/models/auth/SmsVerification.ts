import { DataTypes, Model, Optional } from 'sequelize'
import sequelize from '../../config/database'

interface SmsVerificationAttributes {
  id: number
  phone: string
  code: string
  expires_at: Date
  is_used: boolean
  fail_count: number
  created_at?: Date
}

interface SmsVerificationCreationAttributes
  extends Optional<SmsVerificationAttributes, 'id'> {}

class SmsVerification
  extends Model<SmsVerificationAttributes, SmsVerificationCreationAttributes>
  implements SmsVerificationAttributes
{
  public id!: number
  public phone!: string
  public code!: string
  public expires_at!: Date
  public is_used!: boolean
  public fail_count!: number
  public created_at?: Date
}

SmsVerification.init(
  {
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
    },
    phone: {
      type: DataTypes.STRING(20),
      allowNull: false,
    },
    code: {
      type: DataTypes.STRING(6),
      allowNull: false,
    },
    expires_at: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    is_used: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },
    fail_count: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    tableName: 'sms_verifications',
    timestamps: false,
  },
)

export default SmsVerification