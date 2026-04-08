import { DataTypes, Model, Optional } from 'sequelize'
import sequelize from '../../config/database'

export type DeviceType = 'pc' | 'mobile'

interface TrustedDeviceAttributes {
  id: number
  user_id: number
  device_type: DeviceType          // 유저당 pc 1대, mobile 1대로 제한
  device_token: string             // SHA-256 해시 저장 (쿠키에는 평문)
  device_fingerprint: string       // UA + IP 해시 — 토큰 탈취 감지용
  user_agent: string | null
  ip: string | null
  label: string | null             // 예: "Chrome · Windows"
  last_used_at: Date
  expires_at: Date
  created_at?: Date
}

interface TrustedDeviceCreationAttributes
  extends Optional<TrustedDeviceAttributes, 'id' | 'last_used_at'> {}

class TrustedDevice
  extends Model<TrustedDeviceAttributes, TrustedDeviceCreationAttributes>
  implements TrustedDeviceAttributes
{
  public id!: number
  public user_id!: number
  public device_type!: DeviceType
  public device_token!: string
  public device_fingerprint!: string
  public user_agent!: string | null
  public ip!: string | null
  public label!: string | null
  public last_used_at!: Date
  public expires_at!: Date
  public readonly created_at!: Date
}

TrustedDevice.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    user_id: { type: DataTypes.BIGINT, allowNull: false },
    device_type: { type: DataTypes.ENUM('pc', 'mobile'), allowNull: false },
    device_token: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    device_fingerprint: { type: DataTypes.STRING(64), allowNull: false },
    user_agent: { type: DataTypes.TEXT, allowNull: true },
    ip: { type: DataTypes.STRING(45), allowNull: true },
    label: { type: DataTypes.STRING(100), allowNull: true },
    last_used_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    expires_at: { type: DataTypes.DATE, allowNull: false },
    created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  },
  {
    sequelize,
    tableName: 'trusted_devices',
    timestamps: false,
    indexes: [
      // (user_id, device_type) 유니크 → PC/모바일 각 1대 DB 레벨 보장
      { unique: true, fields: ['user_id', 'device_type'], name: 'uq_user_device_type' },
      { fields: ['device_token'] },
      { fields: ['expires_at'] },
    ],
  },
)

export default TrustedDevice
