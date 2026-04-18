import { DataTypes, Model } from 'sequelize'
import sequelize from '../../config/database'

class EcosIndicator extends Model {
    declare id: number
    declare indicator: string
    declare time_period: string
    declare cycle: 'D' | 'M' | 'Q'
    declare value: number | null
    declare created_at: Date
}

EcosIndicator.init(
    {
        id: {
            type: DataTypes.BIGINT,
            autoIncrement: true,
            primaryKey: true,
        },
        indicator: {
            type: DataTypes.STRING(50),
            allowNull: false,
        },
        time_period: {
            type: DataTypes.STRING(10),
            allowNull: false,
        },
        cycle: {
            type: DataTypes.STRING(1),
            allowNull: false,
        },
        value: {
            type: DataTypes.DECIMAL(20, 6),
            allowNull: true,
        },
        created_at: {
            type: DataTypes.DATE,
            defaultValue: DataTypes.NOW,
        },
    },
    {
        sequelize,
        tableName: 'ecos_indicators',
        timestamps: false,
    }
)

export default EcosIndicator