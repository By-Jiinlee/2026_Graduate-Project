/**
 * [보안 검증] 모의투자 체결 장부 일별 고정 — 서버 측 (ledgerAnchorService)
 *
 * 위협: DB 쓰기 권한을 얻은 공격자(T4)나 내부자가 이미 체결된 모의투자 주문을 사후에 고친다
 * (수익률 순위 조작, 손실 거래 삭제, 가공 체결 삽입). 체인에 고정한 일별 루트와 현재 주문 기록으로
 * 다시 계산한 루트를 비교해 이를 탐지하고, 진본이 증명된 잎 목록으로 어느 주문이 바뀌었는지 특정한다.
 *
 *   1) 위·변조 탐지·특정 — 가격·수량·방향·소유자·체결 시각·삭제·끼워 넣기·체결 취소 위장·
 *      다른 날로 이동·복수 동시 변경
 *   2) 신뢰 기준 대조 — 고정 기록 행까지 함께 고친 경우: DB 기준(재배포 전)은 못 잡고 체인 기준은 잡는다
 *   3) 정상 운영 — 무변경, 미체결·취소 주문 변경, 다음 날 체결, 재고정 시도, 진행 중인 날
 *   4) 포함 증명 — 본인 주문 증명, 타인 주문 조회 거부, 변경된 주문의 현재 기록 불일치 표시
 *
 * 실제 코드(anchorDay·verifyDay·getOrderProof·runDailyLedgerJob)를 호출하고 virtual_orders·
 * ledger_anchors·anomaly_logs 와 체인 조회만 메모리로 바꾼다. 공유 DB·Sepolia 에 아무것도 쓰지 않는다.
 *
 * 실행: cd server && npx ts-node src/test/security/ledgerAnchor.test.ts
 */
import { Op, UniqueConstraintError } from 'sequelize'
import sequelize from '../../config/database'
import AnomalyLog from '../../models/auth/AnomalyLog'
import User from '../../models/user/User'
import VirtualOrder from '../../models/trade/VirtualOrder'
import LedgerAnchor from '../../models/trade/LedgerAnchor'
import {
  anchorDay,
  getOrderProof,
  kstDayKey,
  kstDayRange,
  runDailyLedgerJob,
  verifyDay,
  verifyMerkleProof,
  type LedgerOrder,
} from '../../services/web3/ledgerAnchorService'

/* eslint-disable @typescript-eslint/no-var-requires */
const CS: any = require('../../services/web3/contractService')
const EMAIL: any = require('../../services/auth/emailService')

// ── 메모리 저장소 ──────────────────────────────────────────────
type OrderRow = LedgerOrder & { status: string }
let orders: OrderRow[] = []
const anchors: any[] = []
const anomalies: { anomaly_type: string; detail: string }[] = []
const chainRoots = new Map<number, string>()

const inRange = (v: any, cond: any) => {
  const t = new Date(v).getTime()
  return t >= new Date(cond[Op.gte]).getTime() && t < new Date(cond[Op.lt]).getTime()
}
;(VirtualOrder as any).findAll = async ({ where }: any) =>
  orders
    .filter((o) => o.status === where.status && o.filled_at && inRange(o.filled_at, where.filled_at))
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((o) => ({ ...o }))
;(VirtualOrder as any).findOne = async ({ where }: any) => {
  const o = orders.find((r) => Number(r.id) === Number(where.id) && Number(r.user_id) === Number(where.user_id))
  return o ? { ...o } : null
}
const L = LedgerAnchor as any
L.findOne = async ({ where }: any) => anchors.find((a) => a.anchor_date === where.anchor_date) ?? null
L.create = async (v: any) => {
  if (anchors.some((a) => a.anchor_date === v.anchor_date)) throw new UniqueConstraintError({ message: 'dup' })
  const row: any = { tx_hash: null, last_verify_result: null, verified_at: null, created_at: new Date(), ...v }
  row.update = async (u: any) => Object.assign(row, u)
  anchors.push(row)
  return row
}
;(AnomalyLog as any).create = async (v: any) => { anomalies.push({ anomaly_type: v.anomaly_type, detail: v.detail }); return v }
;(User as any).findOne = async () => null
EMAIL.sendAnomalyAlertEmail = async () => undefined
CS.anchorLedgerOnChain = async (day: number, root: string) => {
  if (chainRoots.has(day)) throw new Error('Already anchored')
  chainRoots.set(day, root)
  return `0x${'ab'.repeat(32)}`
}
CS.getLedgerRootOnChain = async (day: number) => chainRoots.get(day) ?? `0x${'00'.repeat(32)}`

// ── 시나리오 장부 ──────────────────────────────────────────────
const DAY = 20260930
const NEXT = 20261001
const NOW = new Date(kstDayRange(NEXT).start.getTime() + 10 * 60_000) // 10/1 00:10 KST
const at = (day: number, min: number) => new Date(kstDayRange(day).start.getTime() + min * 60_000).toISOString()

function seed(): void {
  orders = []
  let id = 50_000
  for (let i = 0; i < 120; i++) {
    orders.push({
      id: ++id, user_id: 30 + (i % 9), stock_id: 200 + (i % 17),
      side: i % 3 === 0 ? 'sell' : 'buy', order_type: i % 5 === 0 ? 'limit' : 'market',
      quantity: 1 + (i % 10), price: `${50_000 + i * 100}.00`, total_amount: `${(50_000 + i * 100) * (1 + (i % 10))}.00`,
      filled_at: at(DAY, 9 * 60 + i * 3), status: 'filled',
    })
  }
  // 같은 날의 미체결·취소 주문 — 장부 대상이 아니다
  orders.push({ id: ++id, user_id: 31, stock_id: 201, side: 'buy', order_type: 'limit', quantity: 3, price: '49000.00', total_amount: '147000.00', filled_at: null as any, status: 'pending' })
  orders.push({ id: ++id, user_id: 32, stock_id: 202, side: 'sell', order_type: 'limit', quantity: 2, price: '51000.00', total_amount: '102000.00', filled_at: null as any, status: 'cancelled' })
}
const byId = (id: number) => orders.find((o) => Number(o.id) === id)!
const ID = (k: number) => 50_000 + k

async function freshAnchor(onChain: boolean): Promise<void> {
  anchors.length = 0
  chainRoots.clear()
  seed()
  process.env.LEDGER_ANCHOR_ON_CHAIN = onChain ? 'true' : 'false'
  const r = await anchorDay(DAY, NOW)
  if (r.outcome !== 'ANCHORED') throw new Error(`고정 실패: ${r.outcome}`)
}

// ── 집계 ───────────────────────────────────────────────────────
type Kind = 'attack' | 'normal' | 'control'
interface Row { group: string; name: string; kind: Kind; detected: boolean; located: string; ok: boolean }
const rows: Row[] = []
function record(group: string, name: string, kind: Kind, detected: boolean, located = '', locatedOk = true): void {
  const ok = (kind === 'attack' ? detected : !detected) && locatedOk
  rows.push({ group, name, kind, detected, located, ok })
}
const same = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === [...b].sort((p, q) => p - q)[i])

async function tamperCase(name: string, mutate: () => void, expect: { changed?: number[]; missing?: number[]; inserted?: number[] }) {
  await freshAnchor(true)
  const before = anomalies.length
  mutate()
  const v = await verifyDay(DAY)
  const logged = anomalies.slice(before).some((a) => a.anomaly_type === 'LEDGER_TAMPERING')
  const locOk = same(v.changed, expect.changed ?? []) && same(v.missing, expect.missing ?? []) && same(v.inserted, expect.inserted ?? [])
  const loc = [v.changed.length ? `변경 ${v.changed.join(',')}` : '', v.missing.length ? `삭제 ${v.missing.join(',')}` : '', v.inserted.length ? `삽입 ${v.inserted.join(',')}` : ''].filter(Boolean).join(' · ')
  record('위·변조 탐지', name, 'attack', v.status === 'MISMATCH' && logged, loc, locOk)
}

async function main() {
  console.log('\n[보안 테스트] 모의투자 체결 장부 고정 (서버)')

  // ═════ 1) 위·변조 탐지와 특정 (체인 기준) ═════════════════════
  await tamperCase('체결가 1원 인상', () => { byId(ID(10)).price = `${Number(byId(ID(10)).price) + 1}.00` }, { changed: [ID(10)] })
  await tamperCase('수량 변경(손실 축소)', () => { byId(ID(20)).quantity = 1 }, { changed: [ID(20)] })
  await tamperCase('매수↔매도 뒤집기', () => { const o = byId(ID(30)); o.side = o.side === 'buy' ? 'sell' : 'buy' }, { changed: [ID(30)] })
  await tamperCase('소유자 변경(남의 수익 가로채기)', () => { byId(ID(40)).user_id = 999 }, { changed: [ID(40)] })
  await tamperCase('체결 시각 1초 변경', () => { const o = byId(ID(50)); o.filled_at = new Date(new Date(o.filled_at).getTime() + 1000).toISOString() }, { changed: [ID(50)] })
  await tamperCase('손실 주문 삭제', () => { orders = orders.filter((o) => Number(o.id) !== ID(60)) }, { missing: [ID(60)] })
  await tamperCase('체결을 취소로 위장', () => { byId(ID(70)).status = 'cancelled' }, { missing: [ID(70)] })
  await tamperCase('체결 주문을 다음 날로 이동', () => { byId(ID(80)).filled_at = at(NEXT, 5) }, { missing: [ID(80)] })
  await tamperCase('가공 체결 끼워 넣기', () => {
    orders.push({ ...byId(ID(1)), id: 99_999, user_id: 35, filled_at: at(DAY, 600) })
  }, { inserted: [99_999] })
  await tamperCase('미체결 주문을 체결로 위장', () => {
    const p = orders.find((o) => o.status === 'pending')!
    p.status = 'filled'
    p.filled_at = at(DAY, 700)
  }, { inserted: [ID(121)] })
  await tamperCase('복수 동시 변경(가격·삭제·삽입)', () => {
    byId(ID(5)).price = '1.00'
    orders = orders.filter((o) => Number(o.id) !== ID(6))
    orders.push({ ...byId(ID(7)), id: 88_888, filled_at: at(DAY, 800) })
  }, { changed: [ID(5)], missing: [ID(6)], inserted: [88_888] })

  // ═════ 2) 신뢰 기준 대조 — 고정 기록 행까지 함께 고친 공격 ═════
  // 공격자가 주문을 고친 뒤 ledger_anchors 행의 루트·잎 목록도 고친 값으로 다시 계산해 덮어쓴다.
  const rewriteAnchorRow = async () => {
    const { computeLedger, loadDayOrders } = require('../../services/web3/ledgerAnchorService')
    const { entries, root } = computeLedger(await loadDayOrders(DAY))
    Object.assign(anchors[0], { merkle_root: root, leaves: JSON.stringify(entries), leaf_count: entries.length })
  }
  {
    await freshAnchor(false)
    byId(ID(90)).price = '1.00'
    await rewriteAnchorRow()
    const v = await verifyDay(DAY)
    record('신뢰 기준', '대조군: DB 기준 고정 — 주문·고정 행 동시 변경', 'control', v.status === 'MISMATCH', `신뢰 기준 ${v.trustSource}`)
  }
  {
    await freshAnchor(true)
    byId(ID(90)).price = '1.00'
    await rewriteAnchorRow()
    const v = await verifyDay(DAY)
    record('신뢰 기준', '체인 기준 고정 — 주문·고정 행 동시 변경', 'attack',
      v.status === 'MISMATCH' && v.anchorRowTampered === true, `신뢰 기준 ${v.trustSource} · 고정 행 변경 ${v.anchorRowTampered} · 특정 불가(목록도 변조)`)
  }
  {
    await freshAnchor(true)
    anchors[0].merkle_root = `0x${'11'.repeat(32)}`
    const v = await verifyDay(DAY)
    record('신뢰 기준', '고정 행의 루트만 변경(주문은 그대로)', 'attack', v.status === 'MISMATCH' && v.anchorRowTampered === true, `고정 행 변경 ${v.anchorRowTampered}`)
  }

  // ═════ 3) 정상 운영 — 오탐이 없어야 한다 ═══════════════════════
  const G3 = '정상 운영'
  {
    await freshAnchor(true)
    record(G3, '무변경 재검증', 'normal', (await verifyDay(DAY)).status !== 'MATCH')
    const p = orders.find((o) => o.status === 'pending')!
    p.quantity = 7
    p.status = 'cancelled' // 사용자의 미체결 취소
    record(G3, '미체결 주문 취소·수정(장부 대상 아님)', 'normal', (await verifyDay(DAY)).status !== 'MATCH')
    orders.push({ ...byId(ID(3)), id: 77_777, filled_at: at(NEXT, 30) })
    record(G3, '다음 날 체결 추가', 'normal', (await verifyDay(DAY)).status !== 'MATCH')
    record(G3, '같은 날 재고정 시도 → 기존 유지', 'normal', (await anchorDay(DAY, NOW)).outcome !== 'ALREADY')
    record(G3, '진행 중인 날은 고정하지 않음', 'normal', (await anchorDay(NEXT, NOW)).outcome !== 'OPEN_DAY')
    record(G3, '체인 전송 시 상태 SUBMITTED·루트 일치', 'normal',
      !(anchors[0].status === 'SUBMITTED' && chainRoots.get(DAY) === anchors[0].merkle_root))
    const quiet = anomalies.length
    await verifyDay(DAY)
    record(G3, '정상 검증은 이상 로그를 남기지 않음', 'normal', anomalies.length !== quiet)
  }
  {
    // 일일 작업 — 7일 중 빈 날은 건너뛰고, 장부가 있는 날만 고정·검증
    anchors.length = 0
    chainRoots.clear()
    seed()
    const r = await runDailyLedgerJob(NOW)
    record(G3, '일일 작업: 장부 있는 날만 고정·검증', 'normal',
      !(r.anchored.length === 1 && r.anchored[0] === DAY && r.verified.every((v) => v.status === 'MATCH')))
    record(G3, 'KST 날짜 경계(00:00 직전 체결은 전날)', 'normal',
      kstDayKey(new Date(kstDayRange(NEXT).start.getTime() - 1)) !== DAY)
  }

  {
    // 재배포 전 DB 에만 고정(LOCAL)한 날을, 체인 고정을 켠 뒤 올린다
    await freshAnchor(false)
    process.env.LEDGER_ANCHOR_ON_CHAIN = 'true'
    const r = await anchorDay(DAY, NOW)
    record(G3, 'DB 고정(LOCAL)을 체인 고정으로 승격(장부 무변경)', 'normal',
      !(r.outcome === 'PROMOTED' && chainRoots.get(DAY) === anchors[0].merkle_root && anchors[0].status === 'SUBMITTED'))
  }
  {
    // 승격 전에 장부가 바뀌었다면 바뀐 상태를 진본으로 굳히지 않는다
    await freshAnchor(false)
    byId(ID(11)).quantity = 99
    process.env.LEDGER_ANCHOR_ON_CHAIN = 'true'
    const before = anomalies.length
    const r = await anchorDay(DAY, NOW)
    record('위·변조 탐지', '승격 직전 변조 — 체인 고정 거부·기록', 'attack',
      r.outcome === 'REFUSED' && !chainRoots.has(DAY) && anomalies.slice(before).some((a) => a.anomaly_type === 'LEDGER_TAMPERING'),
      '승격 거부')
  }

  // ═════ 4) 포함 증명 ═══════════════════════════════════════════
  const G4 = '포함 증명'
  {
    await freshAnchor(true)
    const own = byId(ID(15))
    const proof = await getOrderProof(Number(own.user_id), ID(15))
    record(G4, '본인 체결 주문 증명이 고정 루트로 검증됨', 'normal',
      !(verifyMerkleProof(proof.leaf, proof.proof, proof.root) && proof.root === chainRoots.get(DAY) && proof.currentRecordMatches))
    let otherBlocked = false
    try { await getOrderProof(Number(own.user_id) + 1, ID(15)) } catch { otherBlocked = true }
    record(G4, '타인 주문 번호로 증명 요청', 'attack', otherBlocked)
    own.price = '2.00'
    const after = await getOrderProof(Number(own.user_id), ID(15))
    record(G4, '변경된 주문은 현재 기록 불일치로 표시', 'attack', after.currentRecordMatches === false)
    let pendingBlocked = false
    try { await getOrderProof(31, ID(121)) } catch { pendingBlocked = true }
    record(G4, '미체결 주문 증명 요청', 'attack', pendingBlocked)
  }

  // ── 출력 ─────────────────────────────────────────────────────
  const attacks = rows.filter((r) => r.kind === 'attack')
  const normals = rows.filter((r) => r.kind === 'normal')
  const controls = rows.filter((r) => r.kind === 'control')
  const detected = attacks.filter((r) => r.detected).length
  const tamperRows = rows.filter((r) => r.group === '위·변조 탐지')
  const located = tamperRows.filter((r) => r.ok).length
  const failed = rows.filter((r) => !r.ok)
  console.log(`총 시도: ${attacks.length + normals.length}회 | 탐지: ${detected}회 | 차단: ${detected}회 | 탐지율: ${((detected / attacks.length) * 100).toFixed(0)}%`)
  console.log(`  위·변조 주문 정확 특정: ${located}/${tamperRows.length} · 정상 운영 오탐: ${normals.filter((r) => r.detected).length}/${normals.length}`)
  console.log(`  대조군(DB 기준 고정) 일관된 재작성 미탐: ${controls.filter((r) => !r.detected).length}/${controls.length}`)
  for (const g of [...new Set(rows.map((r) => r.group))]) {
    console.log(`  - ${g}`)
    for (const r of rows.filter((x) => x.group === g)) {
      const tag = r.kind === 'attack' ? '공격' : r.kind === 'normal' ? '정상' : '대조'
      console.log(`      ${r.ok ? '✔' : '✘'} [${tag}] ${r.name} → ${r.detected ? '탐지' : '통과'}${r.located ? `  (${r.located})` : ''}`)
    }
  }
  console.log(`검증 항목: ${rows.length - failed.length}건 통과 / ${failed.length}건 실패`)
  console.log(`판정: ${failed.length === 0 ? 'PASS' : 'FAIL'}`)
  await sequelize.close().catch(() => undefined)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch(async (err) => {
  console.error('검증 실행 오류:', err)
  await sequelize.close().catch(() => undefined)
  process.exit(1)
})
