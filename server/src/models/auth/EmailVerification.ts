import { DataTypes, Model, Optional } from 'sequelize'
import sequelize from '../../config/database'

// 인증 기록의 의미를 분리한다(2026-10-01).
//   is_used     : 이 코드를 더 이상 입력받지 않음(성공·재발송 무효화·5회 실패 폐기 모두 포함)
//   verified_at : 코드 입력에 성공한 시각 — "인증 성공"은 이 값으로만 판단한다
//   consumed_at : 이 인증으로 가입을 마친 시각 — 한 번의 인증으로 계정을 두 개 만들지 못하게 한다
//   purpose     : 가입·마이페이지 휴대폰 변경·이메일 변경 — 다른 용도의 인증을 가입에 쓰지 못하게 한다
// 이전에는 is_used 하나로 성공 여부까지 판단해서, 재발송만으로 이전 코드가 is_used 가 되어
// 코드를 입력하지 않고도 가입 인증을 통과했다.
// 마이그레이션: src/database/migrations/20261001_signup_verification.sql
export type VerificationPurpose = 'SIGNUP' | 'PHONE_CHANGE' | 'EMAIL_CHANGE'

interface EmailVerificationAttributes {
  id: number
  email: string
  code: string
  expires_at: Date
  is_used: boolean
  fail_count: number
  purpose: VerificationPurpose
  verified_at?: Date | null
  consumed_at?: Date | null
  created_at?: Date
}

interface EmailVerificationCreationAttributes
  extends Optional<EmailVerificationAttributes, 'id' | 'purpose'> {}

class EmailVerification
  extends Model<EmailVerificationAttributes, EmailVerificationCreationAttributes>
  implements EmailVerificationAttributes
{
  public id!: number
  public email!: string
  public code!: string
  public expires_at!: Date
  public is_used!: boolean
  public fail_count!: number
  public purpose!: VerificationPurpose
  public verified_at?: Date | null
  public consumed_at?: Date | null
  public created_at?: Date
}

EmailVerification.init(
  {
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
    },
    email: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    code: {
      type: DataTypes.STRING(6),
      allowNull: false,
    },
    expires_at: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    is_used: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },
    fail_count: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    purpose: {
      type: DataTypes.ENUM('SIGNUP', 'PHONE_CHANGE', 'EMAIL_CHANGE'),
      allowNull: false,
      defaultValue: 'SIGNUP',
    },
    verified_at: { type: DataTypes.DATE, allowNull: true },
    consumed_at: { type: DataTypes.DATE, allowNull: true },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    tableName: 'email_verifications',
    timestamps: false,
  },
)

export default EmailVerification