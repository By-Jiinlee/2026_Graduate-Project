import { DataTypes, Model, Optional } from 'sequelize'
import sequelize from '../../config/database'

interface VirtualAccountAttributes {
  id: number
  user_id: number
  seed_balance: number
  initial_seed: number
  is_active: boolean
  activated_at?: Date
  created_at?: Date
  updated_at?: Date
}

interface VirtualAccountCreationAttributes extends Optional<VirtualAccountAttributes, 'id'> {}

class VirtualAccount
  extends Model<VirtualAccountAttributes, VirtualAccountCreationAttributes>
  implements VirtualAccountAttributes
{
  public id!: number
  public user_id!: number
  public seed_balance!: number
  public initial_seed!: number
  public is_active!: boolean
  public activated_at?: Date
  public created_at?: Date
  public updated_at?: Date
}

VirtualAccount.init(
  {
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
    },
    user_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      unique: true,
    },
    seed_balance: {
      type: DataTypes.DECIMAL(20, 2),
      allowNull: false,
    },
    initial_seed: {
      type: DataTypes.DECIMAL(20, 2),
      allowNull: false,
    },
    is_active: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 1,
    },
    activated_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    updated_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    tableName: 'virtual_accounts',
    timestamps: false,
  },
)

export default VirtualAccount
