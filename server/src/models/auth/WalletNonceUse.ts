import { DataTypes, Model, Optional } from 'sequelize'
import sequelize from '../../config/database'

// ─────────────────────────────────────────────────────────────
// 온체인 서명 논스 사용 기록
//
// 컨트랙트의 논스는 검증 트랜잭션이 블록에 포함된 뒤에야 증가한다. 서버는 트랜잭션을
// 전송만 하고 포함을 기다리지 않으므로, 포함 전(Sepolia 블록 주기 약 12초) 동안은
// 같은 서명이 사전 실행(simulateContract) 검증을 다시 통과했다. 한 번의 서명으로
// 로그인이나 고액 주문이 두 번 이루어질 수 있는 창이다.
//
// (지갑, 용도, 논스) 유일 제약으로 "서버가 이미 소비한 논스"를 블록 포함과 무관하게
// 즉시 확정한다. 메모리가 아니라 DB 에 두는 이유는 서버 재시작 직후에도 창이 열리지
// 않게 하기 위함이다. 행은 지우지 않는다 — 같은 지갑의 과거 논스가 다시 유효해지는
// 경로(재등록)를 막는 근거로도 쓰인다.
//
// 마이그레이션: src/database/migrations/20261001_wallet_nonce_device_links.sql
// ─────────────────────────────────────────────────────────────
export type NoncePurpose = 'AUTH' | 'TRADE'

interface WalletNonceUseAttributes {
  id: number
  wallet_address: string
  purpose: NoncePurpose
  nonce: string
  tx_hash: string | null
  created_at: Date
}

interface WalletNonceUseCreationAttributes
  extends Optional<WalletNonceUseAttributes, 'id' | 'tx_hash' | 'created_at'> {}

class WalletNonceUse
  extends Model<WalletNonceUseAttributes, WalletNonceUseCreationAttributes>
  implements WalletNonceUseAttributes
{
  public id!: number
  public wallet_address!: string
  public purpose!: NoncePurpose
  public nonce!: string
  public tx_hash!: string | null
  public created_at!: Date
}

WalletNonceUse.init(
  {
    id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    wallet_address: { type: DataTypes.STRING(42), allowNull: false },
    purpose: { type: DataTypes.ENUM('AUTH', 'TRADE'), allowNull: false },
    // uint256 십진 문자열. JS number 는 2^53 이상에서 깨지고, DB DECIMAL 은 최대 65자리라 78자리를 담지 못한다.
    nonce: { type: DataTypes.STRING(78), allowNull: false },
    tx_hash: { type: DataTypes.STRING(66), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    sequelize,
    tableName: 'wallet_nonce_uses',
    timestamps: false,
    indexes: [
      { name: 'uq_wallet_nonce_use', unique: true, fields: ['wallet_address', 'purpose', 'nonce'] },
    ],
  },
)

export default WalletNonceUse
