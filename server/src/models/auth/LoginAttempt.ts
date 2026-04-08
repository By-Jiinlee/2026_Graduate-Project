import { DataTypes, Model, Optional } from 'sequelize'
import sequelize from '../../config/database'

interface LoginAttemptAttributes {
  id: number
  identifier: string
  identifier_type: 'EMAIL' | 'IP'   // 이메일 또는 IP
  ip: string
  success: boolean
  created_at?: Date
}

interface LoginAttemptCreationAttributes
  extends Optional<LoginAttemptAttributes, 'id'> {}

class LoginAttempt
  extends Model<LoginAttemptAttributes, LoginAttemptCreationAttributes>
  implements LoginAttemptAttributes
{
  public id!: number
  public identifier!: string
  public identifier_type!: 'EMAIL' | 'IP'
  public ip!: string
  public success!: boolean
  public readonly created_at!: Date
}

LoginAttempt.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    identifier: { type: DataTypes.STRING(100), allowNull: false },
    identifier_type: { type: DataTypes.ENUM('EMAIL', 'IP'), allowNull: false },
    ip: { type: DataTypes.STRING(45), allowNull: false },
    success: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  },
  {
    sequelize,
    tableName: 'login_attempts',
    timestamps: false,
    indexes: [
      { fields: ['identifier', 'identifier_type'] },
      { fields: ['ip'] },
      { fields: ['created_at'] },
    ],
  },
)

export default LoginAttempt
