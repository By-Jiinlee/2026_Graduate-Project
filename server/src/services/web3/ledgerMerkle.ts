import { concat, encodeAbiParameters, keccak256, type Hex } from 'viem'

// ─────────────────────────────────────────────────────────────
// 체결 장부 머클 계산 — 순수 함수만 둔다(DB·체인 의존 없음).
// 서버(ledgerAnchorService)와 컨트랙트 검증 테스트(contracts/test/MockTradeLedger.ts)가 같은 파일을
// 쓴다. 테스트가 트리를 따로 구현하면 "두 구현이 같다"는 증명이 되지 않기 때문이다.
//
// 잎 = keccak256(keccak256(abi.encode(주문 번호, 사용자, 종목, 방향, 유형, 수량, 가격, 금액, 체결 시각)))
//   - 이중 해시: 잎이 내부 노드(두 해시의 연결)와 같은 값이 될 수 없게 한다(2차 원상 공격 방지).
//   - 금액은 DECIMAL(15,2) 문자열을 정수(전 단위)로 바꿔 넣는다 — 부동소수 변환이 끼면 같은 장부가
//     실행 환경마다 다른 루트를 낼 수 있다.
// 내부 노드 = 두 자식을 값 순으로 정렬해 연결한 해시(정렬 쌍). 증명에 좌우 정보가 필요 없고,
// 컨트랙트 verifyOrderInclusion 이 같은 규칙으로 검증한다. 홀수 개 층의 마지막 노드는 복제하지 않고
// 그대로 올린다 — 복제하면 [a,b,c] 와 [a,b,c,c] 가 같은 루트를 갖는다.
// ─────────────────────────────────────────────────────────────

const KST_MS = 9 * 3_600_000
export const DAY_MS = 86_400_000

// ─── 날짜 ─────────────────────────────────────────────────────
export const kstDayKey = (d: Date): number => {
  const k = new Date(d.getTime() + KST_MS)
  return k.getUTCFullYear() * 10_000 + (k.getUTCMonth() + 1) * 100 + k.getUTCDate()
}

export const kstDayRange = (day: number): { start: Date; end: Date } => {
  const y = Math.floor(day / 10_000)
  const m = Math.floor(day / 100) % 100
  const d = day % 100
  const start = new Date(Date.UTC(y, m - 1, d) - KST_MS)
  return { start, end: new Date(start.getTime() + DAY_MS) }
}

export const isValidDayKey = (day: unknown): day is number =>
  Number.isSafeInteger(day) && (day as number) >= 20_000_101 && (day as number) <= 29_991_231 &&
  kstDayKey(kstDayRange(day as number).start) === day

// ─── 잎 ───────────────────────────────────────────────────────
export interface LedgerOrder {
  id: number | string
  user_id: number | string
  stock_id: number | string
  side: string
  order_type: string
  quantity: number | string
  price: number | string
  total_amount: number | string
  filled_at: Date | string
}

const toUnits = (v: number | string): bigint => {
  const s = typeof v === 'number' ? v.toFixed(2) : String(v).trim()
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s)
  if (!m) throw new Error(`장부 금액 형식 오류: ${s}`)
  return BigInt(m[1]) * BigInt(100) + BigInt((m[2] ?? '').padEnd(2, '0'))
}

const SIDE_CODE: Record<string, number> = { buy: 0, sell: 1 }
const TYPE_CODE: Record<string, number> = { market: 0, limit: 1 }

// 컨트랙트 MockTrade.LedgerOrder 와 같은 필드·순서·타입(정적 구조체는 abi.encode 시 필드를 이어 붙인 것과 같다).
export interface LedgerLeafFields {
  orderId: bigint
  userId: bigint
  stockId: bigint
  side: number
  orderType: number
  quantity: bigint
  price: bigint
  totalAmount: bigint
  filledAt: bigint
}

export const LEDGER_ORDER_ABI = {
  type: 'tuple',
  components: [
    { name: 'orderId', type: 'uint256' },
    { name: 'userId', type: 'uint256' },
    { name: 'stockId', type: 'uint256' },
    { name: 'side', type: 'uint8' },
    { name: 'orderType', type: 'uint8' },
    { name: 'quantity', type: 'uint256' },
    { name: 'price', type: 'uint256' },
    { name: 'totalAmount', type: 'uint256' },
    { name: 'filledAt', type: 'uint64' },
  ],
} as const

export const leafFields = (o: LedgerOrder): LedgerLeafFields => {
  const side = SIDE_CODE[o.side]
  const orderType = TYPE_CODE[o.order_type]
  if (side === undefined || orderType === undefined) throw new Error(`장부 주문 형식 오류: ${o.side}/${o.order_type}`)
  const filledMs = new Date(o.filled_at).getTime()
  if (!Number.isFinite(filledMs)) throw new Error(`장부 체결 시각 오류: 주문 ${o.id}`)
  return {
    orderId: BigInt(o.id),
    userId: BigInt(o.user_id),
    stockId: BigInt(o.stock_id),
    side,
    orderType,
    quantity: BigInt(o.quantity),
    price: toUnits(o.price),
    totalAmount: toUnits(o.total_amount),
    filledAt: BigInt(Math.floor(filledMs / 1000)),
  }
}

export const leafFromFields = (f: LedgerLeafFields): Hex =>
  keccak256(keccak256(encodeAbiParameters([LEDGER_ORDER_ABI], [f])))

export const orderLeaf = (o: LedgerOrder): Hex => leafFromFields(leafFields(o))

// ─── 머클 트리 ────────────────────────────────────────────────
const hashPair = (a: Hex, b: Hex): Hex =>
  BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]))

export const buildMerkleLayers = (leaves: readonly Hex[]): Hex[][] => {
  if (leaves.length === 0) throw new Error('빈 장부는 트리를 만들 수 없습니다')
  const layers: Hex[][] = [[...leaves]]
  while (layers[layers.length - 1].length > 1) {
    const cur = layers[layers.length - 1]
    const next: Hex[] = []
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? hashPair(cur[i], cur[i + 1]) : cur[i])
    layers.push(next)
  }
  return layers
}

export const merkleRoot = (leaves: readonly Hex[]): Hex => {
  const layers = buildMerkleLayers(leaves)
  return layers[layers.length - 1][0]
}

export const merkleProof = (layers: readonly Hex[][], index: number): Hex[] => {
  const proof: Hex[] = []
  let idx = index
  for (let l = 0; l < layers.length - 1; l++) {
    const sibling = idx ^ 1
    if (sibling < layers[l].length) proof.push(layers[l][sibling])
    idx = Math.floor(idx / 2)
  }
  return proof
}

export const verifyMerkleProof = (leaf: Hex, proof: readonly Hex[], root: Hex): boolean =>
  proof.reduce<Hex>((h, p) => hashPair(h, p), leaf).toLowerCase() === root.toLowerCase()

// ─── 장부 계산 ────────────────────────────────────────────────
export type LedgerEntry = [orderId: number, leaf: Hex]

export const computeLedger = (orders: readonly LedgerOrder[]): { entries: LedgerEntry[]; root: Hex | null } => {
  const entries = [...orders]
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((o): LedgerEntry => [Number(o.id), orderLeaf(o)])
  return { entries, root: entries.length > 0 ? merkleRoot(entries.map((e) => e[1])) : null }
}

