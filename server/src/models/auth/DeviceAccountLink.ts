import { DataTypes, Model, Optional } from 'sequelize'
import sequelize from '../../config/database'

// ─────────────────────────────────────────────────────────────
// 단말 ↔ 계정 연결 기록 (1인 1계정 원칙 감시)
//
// 증권 서비스는 1인 1계정이 원칙이지만, 지갑은 무제한으로 만들 수 있고 휴대폰 인증도
// 문자 PIN 확인일 뿐 공인 본인확인이 아니어서 가입 단계만으로는 다계정을 막을 수 없다.
// 그래서 "한 단말에서 몇 개의 계정이 쓰이는가"를 사후에 관측한다.
//
// device_hash 는 서버가 발급한 단말 식별 쿠키 원문이 아니라 서버 비밀키로 계산한 HMAC 이다.
// DB 가 유출되어도 이 값으로 쿠키를 복원해 다른 단말을 사칭할 수 없다.
//
// 마이그레이션: src/database/migrations/20261001_wallet_nonce_device_links.sql
// ─────────────────────────────────────────────────────────────
export type DeviceLinkEvent = 'REGISTER' | 'LOGIN'

interface DeviceAccountLinkAttributes {
  id: number
  device_hash: string
  user_id: number
  first_event: DeviceLinkEvent
  first_seen_at: Date
  last_seen_at: Date
}

interface DeviceAccountLinkCreationAttributes
  extends Optional<DeviceAccountLinkAttributes, 'id' | 'first_seen_at' | 'last_seen_at'> {}

class DeviceAccountLink
  extends Model<DeviceAccountLinkAttributes, DeviceAccountLinkCreationAttributes>
  implements DeviceAccountLinkAttributes
{
  public id!: number
  public device_hash!: string
  public user_id!: number
  public first_event!: DeviceLinkEvent
  public first_seen_at!: Date
  public last_seen_at!: Date
}

DeviceAccountLink.init(
  {
    id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    device_hash: { type: DataTypes.CHAR(64), allowNull: false },
    user_id: { type: DataTypes.BIGINT, allowNull: false },
    first_event: { type: DataTypes.ENUM('REGISTER', 'LOGIN'), allowNull: false },
    first_seen_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    last_seen_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    sequelize,
    tableName: 'device_account_links',
    timestamps: false,
    indexes: [
      { name: 'uq_device_account', unique: true, fields: ['device_hash', 'user_id'] },
      { name: 'idx_device_last_seen', fields: ['device_hash', 'last_seen_at'] },
    ],
  },
)

export default DeviceAccountLink
