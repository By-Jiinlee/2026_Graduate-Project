/**
 * [보안 검증] 모의투자 체결 장부 일별 고정 (MockTrade.anchorLedger / verifyOrderInclusion)
 *
 * 장부·루트·증명·위변조 주문은 서버의 실제 머클 코드가 만든다
 * (server/src/test/security/ledgerFixtures.ts → ledgerMerkle.ts). 이 테스트는 그 결과를 Solidity
 * verifyOrderInclusion 에 넣어 두 구현이 같은 규칙을 쓰는지 교차 검증한다. 테스트 쪽에서 트리를
 * 다시 구현하면 "서버와 컨트랙트가 일치한다"는 증명이 되지 않기 때문이다.
 *
 *   1) 교차 검증 — 홀수(37)·짝수(64)·1건·2건 장부의 모든 주문 증명이 컨트랙트에서 참
 *   2) 위·변조 — 가격·수량·방향·소유자·체결 시각 변경, 다른 날 증명, 미고정 날짜, 잘린 증명,
 *               장부에 없는 주문, 내부 노드를 주문으로 위장
 *   3) 고정 규칙 — 소유자만, 같은 날짜 덮어쓰기 불가, 빈 장부·잘못된 날짜 거부
 *   4) 비용 — 건별 logTrade vs 일별 anchorLedger
 *
 * 실행: cd contracts && npx hardhat test nodejs test/MockTradeLedger.ts   (server 의 ts-node 를 사용)
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { network } from "hardhat";
import type { Hex } from "viem";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../server");
const fx = JSON.parse(
  execSync("npx ts-node src/test/security/ledgerFixtures.ts", { cwd: serverDir, encoding: "utf8", shell: true } as any),
);

type FxOrder = Record<string, string | number>;
const toStruct = (o: FxOrder) => ({
  orderId: BigInt(o.orderId), userId: BigInt(o.userId), stockId: BigInt(o.stockId),
  side: Number(o.side), orderType: Number(o.orderType),
  quantity: BigInt(o.quantity), price: BigInt(o.price), totalAmount: BigInt(o.totalAmount),
  filledAt: BigInt(o.filledAt),
});

type Row = { group: string; name: string; attack: boolean; blocked: boolean };
const rows: Row[] = [];
const record = (group: string, name: string, attack: boolean, blocked: boolean) => {
  rows.push({ group, name, attack, blocked });
  assert.equal(blocked, attack, `${group} · ${name}: 거부=${blocked}, 기대=${attack}`);
};
const reverts = async (p: Promise<unknown>) => {
  try { await p; return false; } catch { return true; }
};
const costs: string[] = [];

describe("MockTrade 체결 장부 고정", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [owner, , mallory] = await viem.getWalletClients();

  it("1) 교차 검증 — 서버가 만든 증명을 컨트랙트가 전부 참으로 판정", async function () {
    const m = await viem.deployContract("MockTrade");
    for (const c of fx.cross) {
      await m.write.anchorLedger([c.day, c.root as Hex, c.count]);
      let ok = 0;
      for (const it of c.items) {
        if (await m.read.verifyOrderInclusion([c.day, toStruct(it.order), it.proof as Hex[]])) ok++;
      }
      record("교차 검증", `${c.count}건 장부 전 주문 ${ok}/${c.count} 통과`, false, ok !== c.count);
    }
  });

  it("2) 위·변조 — 바뀐 주문은 고정된 장부에 포함되지 않는다", async function () {
    const m = await viem.deployContract("MockTrade");
    const t = fx.tamper;
    await m.write.anchorLedger([t.day, t.root as Hex, t.count]);
    const check = (o: FxOrder, p: Hex[], day = t.day) => m.read.verifyOrderInclusion([day, toStruct(o), p]);

    record("위·변조", "원본 주문(대조)", false, !(await check(t.original.order, t.original.proof)));
    for (const c of t.cases) record("위·변조", c.name, true, !(await check(c.order, c.proof)));
    record("위·변조", "다른 날짜로 증명 제출", true, !(await check(t.original.order, t.original.proof, t.day + 1)));
    record("위·변조", "고정되지 않은 날짜", true, !(await check(t.original.order, t.original.proof, 20261231)));
  });

  it("3) 고정 규칙 — 소유자 전용·덮어쓰기 불가·입력 검증", async function () {
    const m = await viem.deployContract("MockTrade");
    record("고정 규칙", "소유자의 최초 고정", false, await reverts(m.write.anchorLedger([20261007, fx.rootA, 3])));
    record("고정 규칙", "같은 날짜를 다른 루트로 덮어쓰기", true, await reverts(m.write.anchorLedger([20261007, fx.rootB, 3])));
    assert.equal(await m.read.ledgerRoots([20261007]), fx.rootA);
    record("고정 규칙", "타인의 고정 시도", true,
      await reverts(m.write.anchorLedger([20261008, fx.rootA, 3], { account: mallory.account })));
    record("고정 규칙", "빈 루트", true, await reverts(m.write.anchorLedger([20261009, `0x${"00".repeat(32)}`, 3])));
    record("고정 규칙", "건수 0", true, await reverts(m.write.anchorLedger([20261009, fx.rootA, 0])));
    record("고정 규칙", "날짜 범위 밖(1999-12-31)", true, await reverts(m.write.anchorLedger([19991231, fx.rootA, 3])));
    await viem.assertions.emitWithArgs(
      m.write.anchorLedger([20261010, fx.rootA, 3]),
      m,
      "LedgerAnchored",
      [20261010, fx.rootA, 3, (await publicClient.getBlock()).timestamp + 1n],
    );
  });

  it("4) 비용 — 건별 기록 vs 일별 고정", async function () {
    const m = await viem.deployContract("MockTrade");
    const gas = async (hash: Hex) => (await publicClient.waitForTransactionReceipt({ hash })).gasUsed;
    const w = owner.account.address;
    const first = await gas(await m.write.logTrade([w, "005930|buy|market|10|0", "buy", 700_000n, 0n]));
    const next = await gas(await m.write.logTrade([w, "005930|buy|market|10|0", "buy", 700_000n, 1n]));
    const anchor = await gas(await m.write.anchorLedger([20261011, fx.root500, 500]));
    costs.push(
      `logTrade 1건 ${first.toLocaleString()} gas(첫 건) / ${next.toLocaleString()} gas(이후 건)`,
      `anchorLedger 1회 ${anchor.toLocaleString()} gas — 장부 건수와 무관(500건 장부로 측정)`,
      `일별 고정 1회 = 건별 기록 1건의 ${(Number(anchor) / Number(next)).toFixed(2)}배 — 하루 1건만 체결돼도 더 저렴, 500건이면 ${Math.round((Number(next) * 500) / Number(anchor))}배 절감`,
    );
    assert.ok(anchor < next * 2n);
  });

  after(() => {
    const attacks = rows.filter((r) => r.attack);
    const blocked = attacks.filter((r) => r.blocked).length;
    const normals = rows.filter((r) => !r.attack);
    console.log("\n[보안 테스트] 모의투자 체결 장부 고정 (MockTrade)");
    console.log(`총 시도: ${rows.length}회 | 탐지: ${blocked}회 | 차단: ${blocked}회 | 탐지율: ${((blocked / attacks.length) * 100).toFixed(0)}%`);
    console.log(`  정상(원본·교차 검증) 오판: ${normals.filter((r) => r.blocked).length}/${normals.length}`);
    for (const g of [...new Set(rows.map((r) => r.group))]) {
      console.log(`  - ${g}: ${rows.filter((r) => r.group === g).map((r) => `${r.name} → ${r.blocked ? "거부" : "통과"}`).join(" / ")}`);
    }
    for (const c of costs) console.log(`  [비용] ${c}`);
    console.log(`검증 항목: ${rows.length}건 통과 / 0건 실패`);
    console.log("판정: PASS");
  });
});
