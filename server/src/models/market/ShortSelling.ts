import { DataTypes, Model, Optional } from 'sequelize'
import sequelize from '../../config/database'

interface ShortSellingAttributes {
    id: number
    stock_id: number
    trade_date: string
    short_volume: number | null
    short_amount: number | null
    total_volume: number | null
    total_amount: number | null
    short_volume_ratio: number | null
    short_amount_ratio: number | null
    short_balance_qty: number | null
    short_balance_amount: number | null
    listed_shares: number | null
    short_balance_ratio: number | null
    created_at?: Date
}

type ShortSellingCreationAttributes = Optional<
    ShortSellingAttributes,
    'id' | 'short_volume' | 'short_amount' | 'total_volume' | 'total_amount' |
    'short_volume_ratio' | 'short_amount_ratio' | 'short_balance_qty' |
    'short_balance_amount' | 'listed_shares' | 'short_balance_ratio' | 'created_at'
>

class ShortSelling
    extends Model<ShortSellingAttributes, ShortSellingCreationAttributes>
    implements ShortSellingAttributes
{
    public id!: number
    public stock_id!: number
    public trade_date!: string
    public short_volume!: number | null
    public short_amount!: number | null
    public total_volume!: number | null
    public total_amount!: number | null
    public short_volume_ratio!: number | null
    public short_amount_ratio!: number | null
    public short_balance_qty!: number | null
    public short_balance_amount!: number | null
    public listed_shares!: number | null
    public short_balance_ratio!: number | null
    public created_at!: Date
}

ShortSelling.init(
    {
        id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
        stock_id: { type: DataTypes.BIGINT, allowNull: false },
        trade_date: { type: DataTypes.DATEONLY, allowNull: false },
        short_volume: { type: DataTypes.BIGINT, allowNull: true },
        short_amount: { type: DataTypes.DECIMAL(20, 2), allowNull: true },
        total_volume: { type: DataTypes.BIGINT, allowNull: true },
        total_amount: { type: DataTypes.DECIMAL(20, 2), allowNull: true },
        short_volume_ratio: { type: DataTypes.DECIMAL(8, 4), allowNull: true },
        short_amount_ratio: { type: DataTypes.DECIMAL(8, 4), allowNull: true },
        short_balance_qty: { type: DataTypes.BIGINT, allowNull: true },
        short_balance_amount: { type: DataTypes.DECIMAL(20, 2), allowNull: true },
        listed_shares: { type: DataTypes.BIGINT, allowNull: true },
        short_balance_ratio: { type: DataTypes.DECIMAL(8, 4), allowNull: true },
        created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    },
    {
        sequelize,
        tableName: 'short_selling',
        timestamps: false,
    }
)

export default ShortSelling