import { DataTypes, Model, Optional } from 'sequelize'
import sequelize from '../../config/database'

interface WalletAttributes {
  id: number
  user_id: number
  address: string
  network: string
  seed_amount: number
  is_primary: boolean
  linked_at?: Date
  created_at?: Date
}

interface WalletCreationAttributes extends Optional<WalletAttributes, 'id'> {}

class Wallet
  extends Model<WalletAttributes, WalletCreationAttributes>
  implements WalletAttributes
{
  public id!: number
  public user_id!: number
  public address!: string
  public network!: string
  public seed_amount!: number
  public is_primary!: boolean
  public linked_at?: Date
  public created_at?: Date
}

Wallet.init(
  {
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
    },
    user_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      unique: true,          // 1유저 1지갑 강제
    },
    address: {
      type: DataTypes.STRING(42),
      allowNull: false,
      unique: true,          // 지갑 주소 중복 방지
    },
    network: {
      type: DataTypes.STRING(50),
      allowNull: false,
      defaultValue: 'sepolia',
    },
    seed_amount: {
      type: DataTypes.DECIMAL(20, 8),
      allowNull: false,
      defaultValue: 0,
    },
    is_primary: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },
    linked_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    tableName: 'wallets',
    timestamps: false,
  },
)

export default Wallet