import { DataTypes, Model, Optional } from 'sequelize'
import sequelize from '../../config/database'

interface BlacklistAttributes {
  id: number
  email?: string
  phone?: string
  wallet_address?: string
  reason: string
  blocked_by?: number
  blocked_at?: Date
}

interface BlacklistCreationAttributes extends Optional<BlacklistAttributes, 'id'> {}

class Blacklist
  extends Model<BlacklistAttributes, BlacklistCreationAttributes>
  implements BlacklistAttributes
{
  public id!: number
  public email?: string
  public phone?: string
  public wallet_address?: string
  public reason!: string
  public blocked_by?: number
  public blocked_at?: Date
}

Blacklist.init(
  {
    id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    email: { type: DataTypes.STRING(100), allowNull: true },
    phone: { type: DataTypes.STRING(20), allowNull: true },
    wallet_address: { type: DataTypes.STRING(42), allowNull: true },
    reason: { type: DataTypes.STRING(500), allowNull: false },
    blocked_by: { type: DataTypes.BIGINT, allowNull: true },
    blocked_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  },
  { sequelize, tableName: 'blacklist', timestamps: false },
)

export default Blacklist