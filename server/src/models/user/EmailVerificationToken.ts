import { DataTypes, Model, Optional } from 'sequelize'
import sequelize from '../../config/database'

interface EmailVerificationTokenAttributes {
  id: number
  user_id: number
  token: string
  type: 'register' | 'password_reset' | 'email_change'
  expires_at: Date
  created_at?: Date
}

interface EmailVerificationTokenCreationAttributes extends Optional<
  EmailVerificationTokenAttributes,
  'id'
> {}

class EmailVerificationToken
  extends Model<
    EmailVerificationTokenAttributes,
    EmailVerificationTokenCreationAttributes
  >
  implements EmailVerificationTokenAttributes
{
  public id!: number
  public user_id!: number
  public token!: string
  public type!: 'register' | 'password_reset' | 'email_change'
  public expires_at!: Date
  public created_at?: Date
}

EmailVerificationToken.init(
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
    token: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    type: {
      type: DataTypes.ENUM('register', 'password_reset', 'email_change'),
      allowNull: false,
    },
    expires_at: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    tableName: 'email_verification_tokens',
    timestamps: false,
  },
)

export default EmailVerificationToken
