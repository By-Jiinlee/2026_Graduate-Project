import { DataTypes, Model, Optional } from 'sequelize'
import sequelize from '../../config/database'

interface RealOrderAttributes {
  id: number
  user_id: number
  real_account_id: number
  stock_id: number
  kis_order_id?: string
  order_type: 'market' | 'limit'
  side: 'buy' | 'sell'
  quantity: number
  price: number
  total_amount: number
  status: 'pending' | 'filled' | 'cancelled' | 'failed'
  ip_address: string
  country?: string
  region?: string
  city?: string
  user_agent?: string
  ordered_at: Date
  filled_at?: Date
  created_at?: Date
}

interface RealOrderCreationAttributes extends Optional<RealOrderAttributes, 'id'> {}

class RealOrder
  extends Model<RealOrderAttributes, RealOrderCreationAttributes>
  implements RealOrderAttributes
{
  public id!: number
  public user_id!: number
  public real_account_id!: number
  public stock_id!: number
  public kis_order_id?: string
  public order_type!: 'market' | 'limit'
  public side!: 'buy' | 'sell'
  public quantity!: number
  public price!: number
  public total_amount!: number
  public status!: 'pending' | 'filled' | 'cancelled' | 'failed'
  public ip_address!: string
  public country?: string
  public region?: string
  public city?: string
  public user_agent?: string
  public ordered_at!: Date
  public filled_at?: Date
  public created_at?: Date
}

RealOrder.init(
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
    real_account_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    stock_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    kis_order_id: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    order_type: {
      type: DataTypes.ENUM('market', 'limit'),
      allowNull: false,
    },
    side: {
      type: DataTypes.ENUM('buy', 'sell'),
      allowNull: false,
    },
    quantity: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    price: {
      type: DataTypes.DECIMAL(15, 2),
      allowNull: false,
    },
    total_amount: {
      type: DataTypes.DECIMAL(20, 2),
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM('pending', 'filled', 'cancelled', 'failed'),
      allowNull: false,
      defaultValue: 'pending',
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
    ordered_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    filled_at: {
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
    tableName: 'real_orders',
    timestamps: false,
  },
)

export default RealOrder
