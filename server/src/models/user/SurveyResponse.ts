import { DataTypes, Model, Optional } from 'sequelize'
import sequelize from '../../config/database'

interface SurveyResponseAttributes {
  id: number
  user_id: number
  question_num: number
  selected_option: number
  created_at?: Date
}

interface SurveyResponseCreationAttributes extends Optional<SurveyResponseAttributes, 'id'> {}

class SurveyResponse
  extends Model<SurveyResponseAttributes, SurveyResponseCreationAttributes>
  implements SurveyResponseAttributes
{
  public id!: number
  public user_id!: number
  public question_num!: number
  public selected_option!: number
  public created_at?: Date
}

SurveyResponse.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    question_num: { type: DataTypes.INTEGER, allowNull: false },
    selected_option: { type: DataTypes.INTEGER, allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: true },
  },
  { sequelize, tableName: 'survey_responses', timestamps: false },
)

export default SurveyResponse
