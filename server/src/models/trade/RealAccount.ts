import { DataTypes, Model, Optional } from 'sequelize'
import sequelize from '../../config/database'

// CREATE TABLE real_accounts (
//   id BIGINT AUTO_INCREMENT PRIMARY KEY,
//   user_id BIGINT NOT NULL UNIQUE,
//   app_key TEXT NOT NULL,
//   app_secret TEXT NOT NULL,
//   cano TEXT NOT NULL,
//   acnt_prdt_cd VARCHAR(10) NOT NULL,
//   is_active TINYINT NOT NULL DEFAULT 1,
//   registered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
// );

interface RealAccountAttributes {
  id: number
  user_id: number
  app_key: string
  app_secret: string
  cano: string
  acnt_prdt_cd: string
  is_active: boolean
  registered_at: Date
}

interface RealAccountCreationAttributes extends Optional<RealAccountAttributes, 'id' | 'registered_at'> {}

class RealAccount
  extends Model<RealAccountAttributes, RealAccountCreationAttributes>
  implements RealAccountAttributes
{
  public id!: number
  public user_id!: number
  public app_key!: string
  public app_secret!: string
  public cano!: string
  public acnt_prdt_cd!: string
  public is_active!: boolean
  public registered_at!: Date
}

RealAccount.init(
  {
    id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    user_id: { type: DataTypes.BIGINT, allowNull: false, unique: true },
    app_key: { type: DataTypes.TEXT, allowNull: false },
    app_secret: { type: DataTypes.TEXT, allowNull: false },
    cano: { type: DataTypes.TEXT, allowNull: false },
    acnt_prdt_cd: { type: DataTypes.STRING(10), allowNull: false },
    is_active: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 1 },
    registered_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, tableName: 'real_accounts', timestamps: false },
)

export default RealAccount
