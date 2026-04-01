import { DataTypes, Model, Optional } from 'sequelize'
import sequelize from '../../config/database'

interface UserAttributes {
  id: number
  email: string
  password_hash: string
  name: string
  phone: string
  role: 'user' | 'admin'
  is_email_verified: boolean
  is_locked: boolean
  status: 'active' | 'dormant' | 'withdrawn'
  terms_agreed: boolean
  privacy_agreed: boolean
  location_agreed: boolean
  age_agreed: boolean
  marketing_agreed: boolean
  provider?: string
  provider_id?: string
  created_at?: Date
  updated_at?: Date
  deleted_at?: Date
}

interface UserCreationAttributes extends Optional<UserAttributes, 'id'> {}

class User
  extends Model<UserAttributes, UserCreationAttributes>
  implements UserAttributes
{
  public id!: number
  public email!: string
  public password_hash!: string
  public name!: string
  public phone!: string
  public role!: 'user' | 'admin'
  public is_email_verified!: boolean
  public is_locked!: boolean
  public status!: 'active' | 'dormant' | 'withdrawn'
  public terms_agreed!: boolean
  public privacy_agreed!: boolean
  public location_agreed!: boolean
  public age_agreed!: boolean
  public marketing_agreed!: boolean
  public provider?: string
  public provider_id?: string
  public created_at?: Date
  public updated_at?: Date
  public deleted_at?: Date
}

User.init(
  {
    id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    email: { type: DataTypes.STRING(100), allowNull: false, unique: true },
    password_hash: { type: DataTypes.STRING(255), allowNull: false },
    name: { type: DataTypes.STRING(50), allowNull: false },
    phone: { type: DataTypes.STRING(20), allowNull: true, unique: true },
    role: {
      type: DataTypes.ENUM('user', 'admin'),
      allowNull: false,
      defaultValue: 'user',
    },
    is_email_verified: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },
    is_locked: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },
    status: {
      type: DataTypes.ENUM('active', 'dormant', 'withdrawn'),
      allowNull: false,
      defaultValue: 'active',
    },
    terms_agreed: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },
    privacy_agreed: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },
    location_agreed: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },
    age_agreed: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },
    marketing_agreed: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },
    provider: { type: DataTypes.STRING(30), allowNull: true },
    provider_id: { type: DataTypes.STRING(100), allowNull: true },
    created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    updated_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
  },
  { sequelize, tableName: 'users', timestamps: false },
)

export default User
