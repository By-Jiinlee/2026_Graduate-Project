import { DataTypes, Model, Optional } from 'sequelize'
import sequelize from '../../config/database'

// ─────────────────────────────────────────────────────────────
// 행동 생체인식 프로필 — 사용자별 키스트로크·마우스 리듬의 러닝 통계
//
// 세션 단위 즉시판단(BOT_BEHAVIOR_*)을 넘어, 로그인마다 수집한 행동 특징을 EWMA 로 누적해
// "이 사람의 평소 리듬"을 만든다. 이후 로그인에서 현재 특징이 프로필과 얼마나 벗어났는지
// (표준화 거리)를 재어, 임계를 넘으면 세션 탈취 의심 신호(BEHAVIOR_BIOMETRIC_MISMATCH)를 남긴다.
//
// 특징 3종(모두 세션 길이에 둔감하도록 정규화):
//   typing  = 평균 타자 간격(ms)
//   mouse_rate = 마우스 이동 횟수 / 체류 초
//   key_rate   = 키 입력 횟수 / 체류 초
// 각 특징의 평균(mean)과 분산(var)을 저장해 표준화 거리 계산에 쓴다.
// ─────────────────────────────────────────────────────────────

interface BehaviorProfileAttributes {
  user_id: number
  sample_count: number
  typing_mean: number | null
  typing_var: number | null
  mouse_rate_mean: number | null
  mouse_rate_var: number | null
  key_rate_mean: number | null
  key_rate_var: number | null
  updated_at?: Date
}

interface BehaviorProfileCreationAttributes
  extends Optional<BehaviorProfileAttributes, 'sample_count' | 'typing_mean' | 'typing_var'
    | 'mouse_rate_mean' | 'mouse_rate_var' | 'key_rate_mean' | 'key_rate_var' | 'updated_at'> {}

class BehaviorProfile
  extends Model<BehaviorProfileAttributes, BehaviorProfileCreationAttributes>
  implements BehaviorProfileAttributes
{
  public user_id!: number
  public sample_count!: number
  public typing_mean!: number | null
  public typing_var!: number | null
  public mouse_rate_mean!: number | null
  public mouse_rate_var!: number | null
  public key_rate_mean!: number | null
  public key_rate_var!: number | null
  public updated_at?: Date
}

BehaviorProfile.init(
  {
    user_id: { type: DataTypes.BIGINT, primaryKey: true },
    sample_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    typing_mean: { type: DataTypes.DOUBLE, allowNull: true },
    typing_var: { type: DataTypes.DOUBLE, allowNull: true },
    mouse_rate_mean: { type: DataTypes.DOUBLE, allowNull: true },
    mouse_rate_var: { type: DataTypes.DOUBLE, allowNull: true },
    key_rate_mean: { type: DataTypes.DOUBLE, allowNull: true },
    key_rate_var: { type: DataTypes.DOUBLE, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    sequelize,
    tableName: 'behavior_profiles',
    timestamps: false,
  },
)

export default BehaviorProfile
