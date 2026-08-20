import { DataTypes, Model, Optional } from 'sequelize'
import sequelize from '../../config/database'

// AI 추론 요청 감사 로그 — 허용/차단 여부와 사유를 모두 남긴다.
// 이상탐지 요약은 anomaly_logs, 개별 호출 이력은 이 테이블이 담당한다.
// DB 마이그레이션: src/database/migrations/20260730_inference_logs.sql
export type InferenceDecision = 'ALLOW' | 'DENY'

export type InferenceDenyReason =
  | 'INVALID_SHAPE'          // 본문이 객체가 아님 / 필수 필드 누락
  | 'UNKNOWN_FIELD'          // 허용되지 않은 필드 포함(파라미터 오염)
  | 'INVALID_CODE'           // 종목코드 형식 위반
  | 'UNKNOWN_CODE'           // 형식은 맞으나 상장 종목이 아님
  | 'INVALID_HORIZON'        // 예측 구간 값이 화이트리스트 밖
  | 'RATE_LIMIT'             // 분당 호출 한도 초과
  | 'BURST_LIMIT'            // 10분 누적 호출 한도 초과
  | 'MODEL_OUTPUT_INVALID'   // 모델 응답이 계약을 위반 (fail-closed)
  | 'MODEL_UNAVAILABLE'      // 모델 호출 실패·타임아웃
  | 'NOT_PREDICTED'          // 배치에 해당 종목·구간 예측이 없음(유니버스 밖 — 정상 상태)

interface InferenceLogAttributes {
  id: number
  user_id: number | null
  ip: string
  user_agent: string | null
  stock_code: string | null
  horizon: string | null
  decision: InferenceDecision
  deny_reason: InferenceDenyReason | null
  label: number | null
  probability: number | null
  latency_ms: number | null
  adapter: string | null
  created_at?: Date
}

interface InferenceLogCreationAttributes
  extends Optional<InferenceLogAttributes, 'id' | 'created_at'> {}

class InferenceLog
  extends Model<InferenceLogAttributes, InferenceLogCreationAttributes>
  implements InferenceLogAttributes
{
  public id!: number
  public user_id!: number | null
  public ip!: string
  public user_agent!: string | null
  public stock_code!: string | null
  public horizon!: string | null
  public decision!: InferenceDecision
  public deny_reason!: InferenceDenyReason | null
  public label!: number | null
  public probability!: number | null
  public latency_ms!: number | null
  public adapter!: string | null
  public readonly created_at!: Date
}

InferenceLog.init(
  {
    id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    user_id: { type: DataTypes.BIGINT, allowNull: true },
    ip: { type: DataTypes.STRING(45), allowNull: false },
    user_agent: { type: DataTypes.TEXT, allowNull: true },
    stock_code: { type: DataTypes.STRING(12), allowNull: true },
    horizon: { type: DataTypes.STRING(4), allowNull: true },
    decision: { type: DataTypes.ENUM('ALLOW', 'DENY'), allowNull: false },
    deny_reason: { type: DataTypes.STRING(40), allowNull: true },
    label: { type: DataTypes.TINYINT, allowNull: true },
    // 응답에는 양자화된 값만 내려가지만, 사후 분석·재학습 근거를 위해 원본 확률을 보관한다.
    probability: { type: DataTypes.DECIMAL(6, 5), allowNull: true },
    latency_ms: { type: DataTypes.INTEGER, allowNull: true },
    adapter: { type: DataTypes.STRING(20), allowNull: true },
    created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  },
  {
    sequelize,
    tableName: 'inference_logs',
    timestamps: false,
    indexes: [{ fields: ['user_id'] }, { fields: ['created_at'] }, { fields: ['decision'] }],
  },
)

export default InferenceLog
