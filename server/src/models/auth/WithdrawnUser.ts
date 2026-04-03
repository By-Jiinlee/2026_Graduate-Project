import { DataTypes, Model, Optional } from 'sequelize'
import sequelize from '../../config/database'

interface WithdrawnUserAttributes {
  id: number
  original_user_id: number
  email: string
  name: string
  phone?: string
  wallet_address?: string
  withdrawn_at?: Date
  expires_at: Date
  is_deleted: boolean
}

interface WithdrawnUserCreationAttributes extends Optional<WithdrawnUserAttributes, 'id'> {}

class WithdrawnUser
  extends Model<WithdrawnUserAttributes, WithdrawnUserCreationAttributes>
  implements WithdrawnUserAttributes
{
  public id!: number
  public original_user_id!: number
  public email!: string
  public name!: string
  public phone?: string
  public wallet_address?: string
  public withdrawn_at?: Date
  public expires_at!: Date
  public is_deleted!: boolean
}

WithdrawnUser.init(
  {
    id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    original_user_id: { type: DataTypes.BIGINT, allowNull: false },
    email: { type: DataTypes.STRING(100), allowNull: false },
    name: { type: DataTypes.STRING(50), allowNull: false },
    phone: { type: DataTypes.STRING(20), allowNull: true },
    wallet_address: { type: DataTypes.STRING(42), allowNull: true },
    withdrawn_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    expires_at: { type: DataTypes.DATE, allowNull: false },
    is_deleted: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },
  },
  { sequelize, tableName: 'withdrawn_users', timestamps: false },
)

export default WithdrawnUser