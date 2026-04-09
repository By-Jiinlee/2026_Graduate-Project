import { DataTypes, Model, Optional } from 'sequelize'
import sequelize from '../../config/database'

interface VirtualHoldingAttributes {
  id: number
  user_id: number
  stock_id: number
  quantity: number
  avg_price: number
  created_at?: Date
  updated_at?: Date
}

interface VirtualHoldingCreationAttributes extends Optional<VirtualHoldingAttributes, 'id'> {}

class VirtualHolding
  extends Model<VirtualHoldingAttributes, VirtualHoldingCreationAttributes>
  implements VirtualHoldingAttributes
{
  public id!: number
  public user_id!: number
  public stock_id!: number
  public quantity!: number
  public avg_price!: number
  public created_at?: Date
  public updated_at?: Date
}

VirtualHolding.init(
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
    stock_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    quantity: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    avg_price: {
      type: DataTypes.DECIMAL(15, 2),
      allowNull: false,
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
    tableName: 'virtual_holdings',
    timestamps: false,
    indexes: [
      { unique: true, fields: ['user_id', 'stock_id'] },
    ],
  },
)

export default VirtualHolding
