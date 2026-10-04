/**
 * 체결 장부 교차 검증용 픽스처 생성기 (DB·체인 불필요)
 *
 * contracts/test/MockTradeLedger.ts 가 실행 시 이 스크립트를 호출해 표준 출력의 JSON 을 받는다.
 * 장부·루트·증명·위변조 주문을 서버의 실제 머클 코드(ledgerMerkle.ts)로 만들고, 컨트랙트는 그것을
 * 검증만 한다 — 테스트 쪽에 트리를 다시 구현하지 않아야 "두 구현이 일치한다"는 증명이 된다.
 * (서버 패키지는 CommonJS 라 Hardhat 의 ESM 테스트가 직접 가져오면 require 순환 오류가 난다.)
 *
 * 실행: cd server && npx ts-node src/test/security/ledgerFixtures.ts
 */
import {
  buildMerkleLayers,
  computeLedger,
  leafFields,
  merkleProof,
  type LedgerOrder,
} from '../../services/web3/ledgerMerkle'

// 결정적 가짜 장부 — 같은 입력이면 항상 같은 루트
const makeOrders = (n: number, day: string, startId: number): LedgerOrder[] =>
  Array.from({ length: n }, (_, i) => ({
    id: startId + i,
    user_id: 30 + (i % 7),
    stock_id: 100 + (i % 11),
    side: i % 3 === 0 ? 'sell' : 'buy',
    order_type: i % 4 === 0 ? 'limit' : 'market',
    quantity: 1 + (i % 13),
    price: `${70000 + i * 50}.00`,
    total_amount: `${(70000 + i * 50) * (1 + (i % 13))}.00`,
    filled_at: `${day}T0${i % 9}:1${i % 6}:00.000Z`,
  }))

const ser = (o: LedgerOrder) =>
  Object.fromEntries(Object.entries(leafFields(o)).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]))

const ledger = (orders: LedgerOrder[]) => {
  const { entries, root } = computeLedger(orders)
  const layers = buildMerkleLayers(entries.map((e) => e[1]))
  const proofOf = (o: LedgerOrder) => merkleProof(layers, entries.findIndex(([id]) => id === Number(o.id)))
  return { entries, root: root!, layers, proofOf }
}

// 1) 교차 검증 — 홀수·짝수·1건·2건
const cross = ([[20261001, 37], [20261002, 64], [20261003, 1], [20261004, 2]] as const).map(([day, n]) => {
  const orders = makeOrders(n, `2026-10-0${day % 10}`, day * 1000)
  const l = ledger(orders)
  return { day, count: n, root: l.root, items: orders.map((o) => ({ order: ser(o), proof: l.proofOf(o) })) }
})

// 2) 위·변조 — 원본 장부의 증명을 바꾼 주문에 그대로 쓴다
const tDay = 20261005
const tOrders = makeOrders(37, '2026-10-05', 5000)
const t = ledger(tOrders)
const target = tOrders[17]
const proof = t.proofOf(target)
const shift = (o: LedgerOrder, ms: number) => new Date(new Date(o.filled_at).getTime() + ms).toISOString()
const internalNode = t.layers[1][0]
const tamper = {
  day: tDay,
  count: tOrders.length,
  root: t.root,
  original: { order: ser(target), proof },
  cases: [
    { name: '체결가 1원 변경', order: ser({ ...target, price: `${Number(target.price) + 1}.00` }), proof },
    { name: '수량 변경', order: ser({ ...target, quantity: Number(target.quantity) + 1 }), proof },
    { name: '매수↔매도 변경', order: ser({ ...target, side: target.side === 'buy' ? 'sell' : 'buy' }), proof },
    { name: '소유자(user_id) 변경', order: ser({ ...target, user_id: 999 }), proof },
    { name: '체결 시각 1초 변경', order: ser({ ...target, filled_at: shift(target, 1000) }), proof },
    { name: '증명 마지막 원소 제거', order: ser(target), proof: proof.slice(0, -1) },
    { name: '장부에 없는 주문 끼워 넣기(남의 증명 재사용)', order: ser({ ...target, id: 9_999_999 }), proof },
    {
      // 컨트랙트가 주문 내용으로 잎을 계산하므로, 내부 노드 해시를 어디에 넣어도 그 노드가 되지 않는다
      name: '내부 노드 해시를 주문 번호 자리에 넣어 제출',
      order: { ...ser(target), orderId: BigInt(internalNode).toString() },
      proof: merkleProof(t.layers.slice(1), 0),
    },
  ],
}

// 3) 고정 규칙·비용용 루트
const rootA = ledger(makeOrders(3, '2026-10-07', 7000)).root
const rootB = ledger(makeOrders(3, '2026-10-07', 7100)).root
const root500 = ledger(makeOrders(500, '2026-10-11', 11000)).root

process.stdout.write(JSON.stringify({ cross, tamper, rootA, rootB, root500 }))
