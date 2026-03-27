import { DataTypes, Model, Optional } from 'sequelize'
import sequelize from '../../config/database'

interface EmailVerificationAttributes {
  id: number
  email: string
  code: string
  expires_at: Date
  is_used: boolean
  fail_count: number
  created_at?: Date
}

interface EmailVerificationCreationAttributes
  extends Optional<EmailVerificationAttributes, 'id'> {}

class EmailVerification
  extends Model<EmailVerificationAttributes, EmailVerificationCreationAttributes>
  implements EmailVerificationAttributes
{
  public id!: number
  public email!: string
  public code!: string
  public expires_at!: Date
  public is_used!: boolean
  public fail_count!: number
  public created_at?: Date
}

EmailVerification.init(
  {
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
    },
    email: {
      type: DataTypes.STRING(100),
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
    tableName: 'email_verifications',
    timestamps: false,
  },
)

export default EmailVerification