import { DataTypes, Model, Optional } from 'sequelize'
import sequelize from '../../config/database'

// ─────────────────────────────────────────────────────────────
// 거래 인증(PIN / 지갑 서명) 시도 기록
//
// PIN 실패 이력이 인메모리 Map 에만 있어서 서버 재시작 시 사라졌고, 무엇보다
// "여러 번 실패한 뒤 성공"이라는 판정(M-5)을 성공 시점에 조회할 방법이 없었다.
// 크리덴셜 스터핑은 "결국 성공한다"는 점이 핵심이라, 성공 자체를 막을 게 아니라
// 성공 직전의 실패 이력을 근거로 고위험 태깅을 해야 한다. 그래서 영속 기록이 필요하다.
//
// 마이그레이션: src/database/migrations/20260820_anomaly_detection_m2_m8.sql
// ─────────────────────────────────────────────────────────────
export type TradeAuthMethod = 'PIN' | 'WALLET_SIGNATURE'

interface TradeAuthAttemptAttributes {
  id: number
  user_id: number
  method: TradeAuthMethod
  success: boolean
  ip: string
  user_agent: string | null
  attempted_at: Date
}

interface TradeAuthAttemptCreationAttributes
  extends Optional<TradeAuthAttemptAttributes, 'id' | 'attempted_at' | 'user_agent'> {}

class TradeAuthAttempt
  extends Model<TradeAuthAttemptAttributes, TradeAuthAttemptCreationAttributes>
  implements TradeAuthAttemptAttributes
{
  public id!: number
  public user_id!: number
  public method!: TradeAuthMethod
  public success!: boolean
  public ip!: string
  public user_agent!: string | null
  public attempted_at!: Date
}

TradeAuthAttempt.init(
  {
    id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    user_id: { type: DataTypes.BIGINT, allowNull: false },
    method: { type: DataTypes.ENUM('PIN', 'WALLET_SIGNATURE'), allowNull: false },
    success: { type: DataTypes.BOOLEAN, allowNull: false },
    ip: { type: DataTypes.STRING(45), allowNull: false },
    user_agent: { type: DataTypes.STRING(500), allowNull: true },
    attempted_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    sequelize,
    tableName: 'trade_auth_attempts',
    timestamps: false,
    indexes: [{ name: 'idx_trade_auth_user_time', fields: ['user_id', 'attempted_at'] }],
  },
)

export default TradeAuthAttempt
