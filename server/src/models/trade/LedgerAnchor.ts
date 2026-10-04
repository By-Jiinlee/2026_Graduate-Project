import { DataTypes, Model, Optional } from 'sequelize'
import sequelize from '../../config/database'

// ─────────────────────────────────────────────────────────────
// 일별 모의투자 체결 장부 고정 기록
//
// 하루치 체결 주문 전체를 머클 트리로 묶은 루트와, 그 루트를 만든 잎 목록을 보관한다.
// 루트는 MockTrade.anchorLedger 로 체인에 고정되며(LEDGER_ANCHOR_ON_CHAIN=true), 체인의 루트와
// 일치하는 잎 목록은 그 자체로 진본이 증명되므로 DB 에 두어도 된다 — 나중에 장부가 바뀌었을 때
// 현재 주문과 이 목록을 비교하면 어느 주문이 바뀌었는지까지 특정할 수 있다.
//
// 마이그레이션: src/database/migrations/20261001_ledger_anchor.sql
// ─────────────────────────────────────────────────────────────
export type LedgerAnchorStatus = 'LOCAL' | 'SUBMITTED' | 'FAILED'
export type LedgerVerifyResult = 'MATCH' | 'MISMATCH'

interface LedgerAnchorAttributes {
  id: number
  anchor_date: number
  merkle_root: string
  leaf_count: number
  leaves: string
  status: LedgerAnchorStatus
  tx_hash: string | null
  last_verify_result: LedgerVerifyResult | null
  verified_at: Date | null
  created_at: Date
}

interface LedgerAnchorCreationAttributes
  extends Optional<LedgerAnchorAttributes, 'id' | 'tx_hash' | 'last_verify_result' | 'verified_at' | 'created_at'> {}

class LedgerAnchor
  extends Model<LedgerAnchorAttributes, LedgerAnchorCreationAttributes>
  implements LedgerAnchorAttributes
{
  public id!: number
  public anchor_date!: number
  public merkle_root!: string
  public leaf_count!: number
  public leaves!: string
  public status!: LedgerAnchorStatus
  public tx_hash!: string | null
  public last_verify_result!: LedgerVerifyResult | null
  public verified_at!: Date | null
  public created_at!: Date
}

LedgerAnchor.init(
  {
    id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    // KST 날짜 yyyymmdd — 컨트랙트 키와 같은 형식
    anchor_date: { type: DataTypes.INTEGER, allowNull: false, unique: true },
    merkle_root: { type: DataTypes.CHAR(66), allowNull: false },
    leaf_count: { type: DataTypes.INTEGER, allowNull: false },
    // [[orderId, leafHex], ...] — 주문 번호 오름차순
    leaves: { type: DataTypes.TEXT('long'), allowNull: false },
    status: { type: DataTypes.ENUM('LOCAL', 'SUBMITTED', 'FAILED'), allowNull: false },
    tx_hash: { type: DataTypes.STRING(66), allowNull: true },
    last_verify_result: { type: DataTypes.ENUM('MATCH', 'MISMATCH'), allowNull: true },
    verified_at: { type: DataTypes.DATE, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    sequelize,
    tableName: 'ledger_anchors',
    timestamps: false,
  },
)

export default LedgerAnchor
