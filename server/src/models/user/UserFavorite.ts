import { DataTypes, Model, Optional } from 'sequelize'
import sequelize from '../../config/database'

interface UserFavoriteAttributes {
  id: number
  user_id: number
  stock_id: number
  order_index: number
  created_at?: Date
}

interface UserFavoriteCreationAttributes extends Optional<UserFavoriteAttributes, 'id' | 'created_at'> {}

class UserFavorite
  extends Model<UserFavoriteAttributes, UserFavoriteCreationAttributes>
  implements UserFavoriteAttributes
{
  public id!: number
  public user_id!: number
  public stock_id!: number
  public order_index!: number
  public created_at?: Date
}

UserFavorite.init(
  {
    id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    user_id: { type: DataTypes.BIGINT, allowNull: false },
    stock_id: { type: DataTypes.BIGINT, allowNull: false },
    order_index: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  },
  { sequelize, tableName: 'user_favorites', timestamps: false },
)

export default UserFavorite
