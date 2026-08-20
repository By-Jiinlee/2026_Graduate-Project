import { DataTypes, Model, Optional } from 'sequelize'
import sequelize from '../../config/database'

interface LoginRecordAttributes {
  id: number
  user_id: number
  wallet_address: string
  ip_address: string
  country?: string
  region?: string
  city?: string
  latitude?: number | null
  longitude?: number | null
  user_agent?: string
  logged_at: Date
}

interface LoginRecordCreationAttributes
  extends Optional<LoginRecordAttributes, 'id'> {}

class LoginRecord
  extends Model<LoginRecordAttributes, LoginRecordCreationAttributes>
  implements LoginRecordAttributes
{
  public id!: number
  public user_id!: number
  public wallet_address!: string
  public ip_address!: string
  public country?: string
  public region?: string
  public city?: string
  public latitude?: number | null
  public longitude?: number | null
  public user_agent?: string
  public logged_at!: Date
}

LoginRecord.init(
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
    wallet_address: {
      type: DataTypes.STRING(42),
      allowNull: false,
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
    // Impossible Travel(M-4) 속도 계산용 좌표. GeoIP 조회 실패 시 null 이며,
    // null 인 기록은 비교 대상에서 제외한다(추정 좌표로 오탐을 만들지 않기 위함).
    // DECIMAL 은 sequelize 가 문자열로 돌려주므로 getter 에서 숫자로 변환한다.
    latitude: {
      type: DataTypes.DECIMAL(9, 6),
      allowNull: true,
      get(this: any): number | null {
        const v = this.getDataValue('latitude')
        return v == null ? null : Number(v)
      },
    },
    longitude: {
      type: DataTypes.DECIMAL(9, 6),
      allowNull: true,
      get(this: any): number | null {
        const v = this.getDataValue('longitude')
        return v == null ? null : Number(v)
      },
    },
    user_agent: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    logged_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    tableName: 'login_records',
    timestamps: false,
  },
)

export default LoginRecord