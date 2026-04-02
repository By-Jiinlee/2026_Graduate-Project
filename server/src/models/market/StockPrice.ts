import { DataTypes, Model, Optional } from 'sequelize'
import sequelize from '../../config/database'

interface StockPriceAttributes {
    id: number
    stock_id: number
    open: number
    high: number
    low: number
    close: number
    volume: number
    trading_value: number
    price_date: string
    created_at?: Date
}

type StockPriceCreationAttributes = Optional<StockPriceAttributes, 'id' | 'created_at'>

class StockPrice extends Model<StockPriceAttributes, StockPriceCreationAttributes>
    implements StockPriceAttributes {
    public id!: number
    public stock_id!: number
    public open!: number
    public high!: number
    public low!: number
    public close!: number
    public volume!: number
    public trading_value!: number
    public price_date!: string
    public created_at!: Date
}

StockPrice.init(
    {
        id: {
            type: DataTypes.BIGINT,
            autoIncrement: true,
            primaryKey: true,
        },
        stock_id: {
            type: DataTypes.BIGINT,
            allowNull: false,
        },
        open: {
            type: DataTypes.DECIMAL(15, 2),
            allowNull: false,
        },
        high: {
            type: DataTypes.DECIMAL(15, 2),
            allowNull: false,
        },
        low: {
            type: DataTypes.DECIMAL(15, 2),
            allowNull: false,
        },
        close: {
            type: DataTypes.DECIMAL(15, 2),
            allowNull: false,
        },
        volume: {
            type: DataTypes.BIGINT,
            allowNull: false,
            defaultValue: 0,
        },
        trading_value: {
            type: DataTypes.DECIMAL(20, 2),
            allowNull: false,
            defaultValue: 0,
        },
        price_date: {
            type: DataTypes.DATEONLY,
            allowNull: false,
        },
        created_at: {
            type: DataTypes.DATE,
            defaultValue: DataTypes.NOW,
        },
    },
    {
        sequelize,
        tableName: 'stock_prices',
        timestamps: false,
    }
)

export default StockPrice