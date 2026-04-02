import { DataTypes, Model, Optional } from 'sequelize'
import sequelize from '../../config/database'

interface EcosIndicatorAttributes {
    id: number
    indicator: string
    time_period: string
    cycle: 'D' | 'M' | 'Q'
    value: number | null
    created_at?: Date
}

type EcosIndicatorCreationAttributes = Optional<
    EcosIndicatorAttributes,
    'id' | 'value' | 'created_at'
>

class EcosIndicator
    extends Model<EcosIndicatorAttributes, EcosIndicatorCreationAttributes>
    implements EcosIndicatorAttributes
{
    public id!: number
    public indicator!: string
    public time_period!: string
    public cycle!: 'D' | 'M' | 'Q'
    public value!: number | null
    public created_at!: Date
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
            type: DataTypes.ENUM('D', 'M', 'Q'),
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