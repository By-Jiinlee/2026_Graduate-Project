import { DataTypes, Model, Optional } from 'sequelize'
import sequelize from '../../config/database'

interface FinancialStatementAttributes {
    id: number
    stock_code: string
    company_name: string
    statement_type: 'BS' | 'IS' | 'CF'
    fiscal_year_end: string
    item_code: string
    item_name: string
    current_period: number | null
    prior_period: number | null
    prior_prior_period: number | null
    created_at?: Date
}

type FinancialStatementCreationAttributes = Optional<
    FinancialStatementAttributes,
    'id' | 'current_period' | 'prior_period' | 'prior_prior_period' | 'created_at'
>

class FinancialStatement
    extends Model<FinancialStatementAttributes, FinancialStatementCreationAttributes>
    implements FinancialStatementAttributes
{
    public id!: number
    public stock_code!: string
    public company_name!: string
    public statement_type!: 'BS' | 'IS' | 'CF'
    public fiscal_year_end!: string
    public item_code!: string
    public item_name!: string
    public current_period!: number | null
    public prior_period!: number | null
    public prior_prior_period!: number | null
    public created_at!: Date
}

FinancialStatement.init(
    {
        id: {
            type: DataTypes.BIGINT,
            autoIncrement: true,
            primaryKey: true,
        },
        stock_code: {
            type: DataTypes.STRING(20),
            allowNull: false,
        },
        company_name: {
            type: DataTypes.STRING(100),
            allowNull: false,
        },
        statement_type: {
            type: DataTypes.ENUM('BS', 'IS', 'CF'),
            allowNull: false,
        },
        fiscal_year_end: {
            type: DataTypes.DATEONLY,
            allowNull: false,
        },
        item_code: {
            type: DataTypes.STRING(50),
            allowNull: false,
        },
        item_name: {
            type: DataTypes.STRING(200),
            allowNull: false,
        },
        current_period: {
            type: DataTypes.DECIMAL(25, 0),
            allowNull: true,
        },
        prior_period: {
            type: DataTypes.DECIMAL(25, 0),
            allowNull: true,
        },
        prior_prior_period: {
            type: DataTypes.DECIMAL(25, 0),
            allowNull: true,
        },
        created_at: {
            type: DataTypes.DATE,
            defaultValue: DataTypes.NOW,
        },
    },
    {
        sequelize,
        tableName: 'financial_statements',
        timestamps: false,
    }
)

export default FinancialStatement