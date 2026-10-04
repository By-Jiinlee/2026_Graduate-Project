import { Op, UniqueConstraintError } from 'sequelize'
import { type Hex } from 'viem'
import VirtualOrder from '../../models/trade/VirtualOrder'
import LedgerAnchor from '../../models/trade/LedgerAnchor'
import { recordLedgerTampering } from '../auth/anomalyService'
import * as contract from './contractService'
import {
  buildMerkleLayers,
  computeLedger,
  DAY_MS,
  isValidDayKey,
  kstDayKey,
  kstDayRange,
  merkleProof,
  merkleRoot,
  leafFields,
  orderLeaf,
  type LedgerEntry,
  type LedgerOrder,
} from './ledgerMerkle'

export * from './ledgerMerkle'

// ─────────────────────────────────────────────────────────────
// 모의투자 체결 장부 일별 고정 (머클 앵커링)
//
// 지금까지 체인에 남는 모의투자 기록은 초기 자금 지급과 재인증을 거친 고액 주문뿐이었고,
// 나머지 체결 내역은 데이터베이스에만 있어 쓰기 권한을 가진 사람이 고쳐도 알 수 없었다.
// 건마다 체인에 쓰면 거래 수에 비례해 비용이 든다(logTrade 1건 약 17만 gas). 그래서 하루치
// 체결 주문 전체를 머클 트리로 묶고 루트 하나만 고정한다 — 거래 수와 무관하게 하루 한 번의 비용으로
// 그날의 모든 체결이 위·변조 탐지 대상이 된다.
//
// 잎·트리 규칙은 ledgerMerkle.ts 참조.
// ─────────────────────────────────────────────────────────────

export const LEDGER_POLICY = {
  // 매일 이 기간의 미고정 날짜를 메우고, 고정된 날짜를 다시 검증한다.
  LOOKBACK_DAYS: 7,
} as const

export const isLedgerOnChain = (): boolean => process.env.LEDGER_ANCHOR_ON_CHAIN === 'true'

export const loadDayOrders = async (day: number): Promise<LedgerOrder[]> => {
  const { start, end } = kstDayRange(day)
  const rows = await VirtualOrder.findAll({
    where: { status: 'filled', filled_at: { [Op.gte]: start, [Op.lt]: end } },
    attributes: ['id', 'user_id', 'stock_id', 'side', 'order_type', 'quantity', 'price', 'total_amount', 'filled_at'],
    order: [['id', 'ASC']],
    raw: true,
  })
  return rows as unknown as LedgerOrder[]
}

const parseEntries = (raw: string): LedgerEntry[] => {
  const v = JSON.parse(raw)
  if (!Array.isArray(v)) throw new Error('장부 잎 목록 형식 오류')
  return v.map((e: unknown) => {
    if (!Array.isArray(e) || !Number.isSafeInteger(e[0]) || typeof e[1] !== 'string' || !/^0x[0-9a-f]{64}$/i.test(e[1])) {
      throw new Error('장부 잎 목록 형식 오류')
    }
    return [e[0], e[1] as Hex]
  })
}

// ─── 고정 ─────────────────────────────────────────────────────
export type AnchorOutcome = 'ANCHORED' | 'PROMOTED' | 'ALREADY' | 'EMPTY' | 'OPEN_DAY' | 'REFUSED'

export async function anchorDay(day: number, now = new Date()): Promise<{ outcome: AnchorOutcome; anchor?: LedgerAnchor }> {
  if (!isValidDayKey(day)) throw new Error(`날짜 형식 오류: ${day}`)
  // 아직 끝나지 않은 날은 고정하지 않는다 — 그날 체결이 더 생기면 루트가 달라진다.
  if (kstDayRange(day).end.getTime() > now.getTime()) return { outcome: 'OPEN_DAY' }

  const existing = await LedgerAnchor.findOne({ where: { anchor_date: day } })
  if (existing) {
    // 체인 고정을 켜기 전(LOCAL)이나 전송 실패(FAILED)로 DB 에만 남은 날을 체인으로 올린다.
    // 올리기 전에 지금 장부가 고정 당시와 같은지 확인한다 — 그 사이 바뀐 장부를 체인에 올리면
    // 변조된 상태가 진본으로 굳는다. 다르면 올리지 않고 불일치로 기록한다.
    if (!isLedgerOnChain() || existing.status === 'SUBMITTED') return { outcome: 'ALREADY', anchor: existing }
    const now = computeLedger(await loadDayOrders(day))
    if (!now.root || now.root.toLowerCase() !== existing.merkle_root.toLowerCase()) {
      await verifyDay(day)
      return { outcome: 'REFUSED', anchor: existing }
    }
    const submitted = await submitToChain(existing, day)
    return { outcome: submitted ? 'PROMOTED' : 'ALREADY', anchor: existing }
  }

  const { entries, root } = computeLedger(await loadDayOrders(day))
  if (!root) return { outcome: 'EMPTY' }

  let anchor: LedgerAnchor
  try {
    anchor = await LedgerAnchor.create({
      anchor_date: day,
      merkle_root: root,
      leaf_count: entries.length,
      leaves: JSON.stringify(entries),
      status: 'LOCAL',
    })
  } catch (err) {
    // 다른 인스턴스가 같은 날을 먼저 고정했다
    if (err instanceof UniqueConstraintError) {
      return { outcome: 'ALREADY', anchor: (await LedgerAnchor.findOne({ where: { anchor_date: day } })) ?? undefined }
    }
    throw err
  }

  if (isLedgerOnChain()) await submitToChain(anchor, day)
  return { outcome: 'ANCHORED', anchor }
}

// 실패해도 DB 고정은 남기고 FAILED 로 표시한다. 다음 일일 작업이 장부 무변경을 확인한 뒤 다시 올린다.
async function submitToChain(anchor: LedgerAnchor, day: number): Promise<boolean> {
  try {
    const hash = await contract.anchorLedgerOnChain(day, anchor.merkle_root as Hex, anchor.leaf_count)
    await anchor.update({ status: 'SUBMITTED', tx_hash: hash })
    return true
  } catch (err: any) {
    console.error(`[Ledger] ${day} 체인 고정 실패:`, err?.shortMessage ?? err?.message ?? err)
    await anchor.update({ status: 'FAILED' })
    return false
  }
}

// ─── 검증 ─────────────────────────────────────────────────────
export interface LedgerVerification {
  day: number
  status: 'NOT_ANCHORED' | 'MATCH' | 'MISMATCH'
  trustSource?: 'CHAIN' | 'DB'
  trustedRoot?: Hex
  recomputedRoot?: Hex | null
  anchorRowTampered?: boolean
  storedListAuthentic?: boolean
  changed: number[]
  missing: number[]
  inserted: number[]
}

export async function verifyDay(day: number, opts: { record?: boolean } = {}): Promise<LedgerVerification> {
  if (!isValidDayKey(day)) throw new Error(`날짜 형식 오류: ${day}`)
  const empty = { changed: [], missing: [], inserted: [] }
  const anchor = await LedgerAnchor.findOne({ where: { anchor_date: day } })
  if (!anchor) return { day, status: 'NOT_ANCHORED', ...empty }

  const storedRoot = anchor.merkle_root as Hex
  let trustedRoot = storedRoot
  let trustSource: 'CHAIN' | 'DB' = 'DB'
  if (isLedgerOnChain() && anchor.status === 'SUBMITTED') {
    const chainRoot = await contract.getLedgerRootOnChain(day)
    if (BigInt(chainRoot) !== BigInt(0)) {
      trustedRoot = chainRoot
      trustSource = 'CHAIN'
    }
  }

  // 고정 행 자체가 고쳐졌는가(체인 기준일 때만 드러난다)
  const anchorRowTampered = storedRoot.toLowerCase() !== trustedRoot.toLowerCase()

  let storedEntries: LedgerEntry[] = []
  let storedListAuthentic = false
  try {
    storedEntries = parseEntries(anchor.leaves)
    storedListAuthentic =
      storedEntries.length === anchor.leaf_count &&
      storedEntries.length > 0 &&
      merkleRoot(storedEntries.map((e) => e[1])).toLowerCase() === trustedRoot.toLowerCase()
  } catch {
    storedListAuthentic = false
  }

  const current = computeLedger(await loadDayOrders(day))
  const rootMatches = current.root !== null && current.root.toLowerCase() === trustedRoot.toLowerCase()

  // 진본이 증명된 잎 목록이 있으면 바뀐 주문을 특정한다. 목록까지 고쳐졌다면 불일치 사실만 남는다.
  const changed: number[] = []
  const missing: number[] = []
  const inserted: number[] = []
  if (storedListAuthentic) {
    const before = new Map(storedEntries.map(([id, leaf]) => [id, leaf.toLowerCase()]))
    const after = new Map(current.entries.map(([id, leaf]) => [id, leaf.toLowerCase()]))
    for (const [id, leaf] of before) {
      if (!after.has(id)) missing.push(id)
      else if (after.get(id) !== leaf) changed.push(id)
    }
    for (const id of after.keys()) if (!before.has(id)) inserted.push(id)
  }

  const status: LedgerVerification['status'] =
    rootMatches && !anchorRowTampered && storedListAuthentic ? 'MATCH' : 'MISMATCH'
  const result: LedgerVerification = {
    day, status, trustSource, trustedRoot, recomputedRoot: current.root,
    anchorRowTampered, storedListAuthentic, changed, missing, inserted,
  }

  if (opts.record !== false) {
    await anchor.update({ last_verify_result: status, verified_at: new Date() }).catch(() => undefined)
    if (status === 'MISMATCH') {
      const parts = [
        `[체결 장부 ${day}] ${trustSource === 'CHAIN' ? '체인' : 'DB'} 고정 루트와 현재 주문 기록 불일치`,
        changed.length ? `변경 주문 ${changed.join(', ')}` : '',
        missing.length ? `삭제된 주문 ${missing.join(', ')}` : '',
        inserted.length ? `끼워 넣은 주문 ${inserted.join(', ')}` : '',
        anchorRowTampered ? '고정 기록 행 자체 변경' : '',
        !storedListAuthentic ? '잎 목록 진본 확인 불가(변경 주문 특정 불가)' : '',
      ].filter(Boolean)
      await recordLedgerTampering(parts.join(' / '))
    }
  }
  return result
}

// ─── 사용자 포함 증명 ─────────────────────────────────────────
export interface OrderProof {
  day: number
  orderId: number
  // 컨트랙트 verifyOrderInclusion(day, order, proof) 에 그대로 넣을 수 있는 값(정수는 문자열)
  order: Record<string, string | number>
  leaf: Hex
  proof: Hex[]
  root: Hex
  currentRecordMatches: boolean
  anchorStatus: string
  txHash: string | null
  contract: string | null
}

// 사용자가 자기 체결 주문이 그날 고정된 장부에 들어 있음을 서버를 믿지 않고 확인할 수 있게 한다.
// 증명은 고정 당시 잎 목록에서 만든다(현재 기록이 바뀌었으면 currentRecordMatches 가 거짓).
export async function getOrderProof(userId: number, orderId: number): Promise<OrderProof> {
  const order = (await VirtualOrder.findOne({
    where: { id: orderId, user_id: userId },
    attributes: ['id', 'user_id', 'stock_id', 'side', 'order_type', 'quantity', 'price', 'total_amount', 'filled_at', 'status'],
    raw: true,
  })) as unknown as (LedgerOrder & { status: string }) | null
  if (!order) throw new Error('주문을 찾을 수 없습니다')
  if (order.status !== 'filled' || !order.filled_at) throw new Error('체결된 주문만 증명할 수 있습니다')

  const day = kstDayKey(new Date(order.filled_at))
  const anchor = await LedgerAnchor.findOne({ where: { anchor_date: day } })
  if (!anchor) throw new Error('아직 장부에 고정되지 않은 날짜입니다. 체결 다음 날 00:10 이후 확인할 수 있습니다')

  const entries = parseEntries(anchor.leaves)
  const index = entries.findIndex(([id]) => id === Number(order.id))
  if (index < 0) throw new Error('고정된 장부에 이 주문이 없습니다')

  const layers = buildMerkleLayers(entries.map((e) => e[1]))
  const fields = leafFields(order)
  return {
    day,
    orderId: Number(order.id),
    order: Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]),
    ),
    leaf: entries[index][1],
    proof: merkleProof(layers, index),
    root: anchor.merkle_root as Hex,
    currentRecordMatches: orderLeaf(order).toLowerCase() === entries[index][1].toLowerCase(),
    anchorStatus: anchor.status,
    txHash: anchor.tx_hash,
    contract: anchor.status === 'SUBMITTED' ? contract.MOCK_TRADE_ADDRESS : null,
  }
}

// ─── 일일 작업 ────────────────────────────────────────────────
// 어제를 고정하고, 최근 기간에 빠진 날(서버 중단 등)을 메운 뒤, 고정된 날들을 다시 검증한다.
export async function runDailyLedgerJob(now = new Date()): Promise<{
  anchored: number[]
  verified: { day: number; status: string }[]
}> {
  const anchored: number[] = []
  const verified: { day: number; status: string }[] = []
  for (let back = LEDGER_POLICY.LOOKBACK_DAYS; back >= 1; back--) {
    const day = kstDayKey(new Date(now.getTime() - back * DAY_MS))
    const r = await anchorDay(day, now)
    if (r.outcome === 'ANCHORED' || r.outcome === 'PROMOTED') anchored.push(day)
    if (r.outcome === 'ANCHORED' || r.outcome === 'PROMOTED' || r.outcome === 'ALREADY') {
      const v = await verifyDay(day)
      verified.push({ day, status: v.status })
    }
  }
  return { anchored, verified }
}
