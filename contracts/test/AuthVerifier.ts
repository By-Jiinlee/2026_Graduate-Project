/**
 * [보안 검증] 온체인 인증 컨트랙트 (AuthVerifier · MockTrade)
 *
 * 서버의 지갑 서명 인증은 이 컨트랙트의 서명자 복원·논스 대조·권한 제어에 기댄다.
 * 그 전제가 실제로 성립하는지, 그리고 수정 전 배포본(AuthVerifierV1)이 어떤 공격에
 * 열려 있었는지를 로컬 체인에서 같은 시나리오로 나란히 재현한다.
 *
 *   1) 서명 검증 — 위조·타 지갑·미등록·도메인(체인/컨트랙트) 불일치·용도 교차 제출
 *   2) 재사용 — 소비된 서명 재제출, 등록 해제 후 재등록 시 과거 서명(★ V1 대조군)
 *   3) 가변 서명 — 높은 s 값의 두 번째 서명(★ V1 대조군)
 *   4) 권한 — 소유자 외 호출, 2단계 소유권 이전
 *   5) 블록 포함 전 창 — 체인 단독으로는 막을 수 없음을 실측(서버 소비 기록의 근거)
 *   6) MockTrade — 지급 1회 제한, 권한, 감사 이벤트
 *
 * 실행: cd contracts && npx hardhat test nodejs test/AuthVerifier.ts
 *       (전체 실행은 템플릿 Counter.ts 가 없는 Counter 컨트랙트를 참조해 실패한다)
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { network } from "hardhat";
import { encodePacked, getAddress, keccak256, parseSignature, serializeSignature, type Hex } from "viem";

// secp256k1 곡선 위수
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

// control: 수정본이 아니라 대조군(V1 배포본) 또는 체인 단독 동작을 재현한 행 — 탐지율 집계에서 뺀다.
type Row = { group: string; name: string; attack: boolean; blocked: boolean; expectBlocked: boolean; control: boolean };
const rows: Row[] = [];
const record = (
  group: string, name: string, attack: boolean, blocked: boolean,
  expectBlocked = attack, control = false,
) => {
  rows.push({ group, name, attack, blocked, expectBlocked, control });
  assert.equal(blocked, expectBlocked, `${group} · ${name}: 차단=${blocked}, 기대=${expectBlocked}`);
};

// 호출이 되돌려지면 true
const reverts = async (p: Promise<unknown>): Promise<boolean> => {
  try {
    await p;
    return false;
  } catch {
    return true;
  }
};

describe("AuthVerifier / MockTrade", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const testClient = await viem.getTestClient();
  const [owner, alice, mallory, newOwner] = await viem.getWalletClients();
  const chainId = BigInt(await publicClient.getChainId());

  const authMsg = (contract: Hex, wallet: Hex, nonce: bigint, cid = chainId) =>
    keccak256(encodePacked(["uint256", "address", "address", "uint256"], [cid, contract, wallet, nonce]));
  const tradeMsg = (contract: Hex, wallet: Hex, nonce: bigint, amount: bigint, code: string) =>
    keccak256(
      encodePacked(
        ["uint256", "address", "address", "uint256", "uint256", "string"],
        [chainId, contract, wallet, nonce, amount, code],
      ),
    );
  const sign = (who: typeof alice, hash: Hex) => who.signMessage({ account: who.account, message: { raw: hash } });

  // 같은 메시지에 대한 두 번째 유효 서명(s → N - s, v 반전)
  const malleate = (sig: Hex): Hex => {
    const p = parseSignature(sig);
    const s = N - BigInt(p.s);
    return serializeSignature({
      r: p.r,
      s: `0x${s.toString(16).padStart(64, "0")}`,
      yParity: p.yParity === 0 ? 1 : 0,
    });
  };

  const deployBoth = async () => {
    const v2 = await viem.deployContract("AuthVerifier");
    const v1 = await viem.deployContract("AuthVerifierV1");
    for (const c of [v1, v2]) await c.write.registerWalletFor([alice.account.address]);
    return { v1, v2 };
  };

  it("1) 서명 검증 — 정상 통과와 위조 거부", async function () {
    const { v2 } = await deployBoth();
    const a = alice.account.address;

    const good = await sign(alice, authMsg(v2.address, a, 0n));
    record("서명 검증", "정상 서명(등록 지갑·현재 논스)", false, await reverts(v2.write.verifySignature([a, 0n, good])));
    assert.equal(await v2.read.getAuthNonce([a]), 1n);

    const byMallory = await sign(mallory, authMsg(v2.address, a, 1n));
    record("서명 검증", "다른 지갑이 대신 서명", true, await reverts(v2.write.verifySignature([a, 1n, byMallory])));

    const forMallory = await sign(mallory, authMsg(v2.address, mallory.account.address, 0n));
    record("서명 검증", "미등록 지갑의 자기 서명", true,
      await reverts(v2.write.verifySignature([mallory.account.address, 0n, forMallory])));

    const otherChain = await sign(alice, authMsg(v2.address, a, 1n, chainId + 1n));
    record("서명 검증", "다른 체인 ID 로 만든 서명", true, await reverts(v2.write.verifySignature([a, 1n, otherChain])));

    const other = await viem.deployContract("AuthVerifier");
    const otherContract = await sign(alice, authMsg(other.address, a, 1n));
    record("서명 검증", "다른 컨트랙트 배포본용 서명", true, await reverts(v2.write.verifySignature([a, 1n, otherContract])));

    const wrongNonce = await sign(alice, authMsg(v2.address, a, 5n));
    record("서명 검증", "미래 논스로 만든 서명", true, await reverts(v2.write.verifySignature([a, 5n, wrongNonce])));

    const garbage = ("0x" + "11".repeat(65)) as Hex;
    record("서명 검증", "임의 65바이트", true, await reverts(v2.write.verifySignature([a, 1n, garbage])));
    record("서명 검증", "길이 64바이트", true, await reverts(v2.write.verifySignature([a, 1n, ("0x" + "22".repeat(64)) as Hex])));
  });

  it("1') 용도 교차 — 인증 서명과 거래 서명은 서로 대체되지 않는다", async function () {
    const { v2 } = await deployBoth();
    const a = alice.account.address;
    const authSig = await sign(alice, authMsg(v2.address, a, 0n));
    record("용도 교차", "인증 서명을 거래 검증에 제출", true,
      await reverts(v2.write.verifyTradeSignature([a, 0n, 1_000_000n, "005930|buy|market|10|0", authSig])));

    const tradeSig = await sign(alice, tradeMsg(v2.address, a, 0n, 1_000_000n, "005930|buy|market|10|0"));
    record("용도 교차", "거래 서명을 로그인 검증에 제출", true, await reverts(v2.write.verifySignature([a, 0n, tradeSig])));

    record("거래 서명", "정상 거래 서명", false,
      await reverts(v2.write.verifyTradeSignature([a, 0n, 1_000_000n, "005930|buy|market|10|0", tradeSig])));

    const s1 = await sign(alice, tradeMsg(v2.address, a, 1n, 1_000_000n, "005930|buy|market|10|0"));
    record("거래 서명", "금액만 바꿔 제출(10배)", true,
      await reverts(v2.write.verifyTradeSignature([a, 1n, 10_000_000n, "005930|buy|market|10|0", s1])));
    record("거래 서명", "수량만 바꿔 제출(서술자)", true,
      await reverts(v2.write.verifyTradeSignature([a, 1n, 1_000_000n, "005930|buy|market|100|0", s1])));
    record("거래 서명", "매수→매도로 바꿔 제출", true,
      await reverts(v2.write.verifyTradeSignature([a, 1n, 1_000_000n, "005930|sell|market|10|0", s1])));
    record("거래 서명", "종목만 바꿔 제출", true,
      await reverts(v2.write.verifyTradeSignature([a, 1n, 1_000_000n, "000660|buy|market|10|0", s1])));
  });

  it("2) 재사용 — 소비된 서명, 등록 해제 후 재등록", async function () {
    const { v1, v2 } = await deployBoth();
    const a = alice.account.address;

    for (const [label, c] of [["V1", v1], ["V2", v2]] as const) {
      const sig = await sign(alice, authMsg(c.address, a, 0n));
      await c.write.verifySignature([a, 0n, sig]);
      record("재사용", `${label} 소비된 서명 재제출`, true, await reverts(c.write.verifySignature([a, 0n, sig])), true, label === "V1");

      // 탈퇴(등록 해제) 후 같은 지갑 재등록 → 과거 논스 0 의 서명이 다시 통하는가
      await c.write.unregisterWallet([a]);
      await c.write.registerWalletFor([a]);
      const blocked = await reverts(c.write.verifySignature([a, 0n, sig]));
      // V1 은 논스를 0 으로 되돌려 과거 서명이 다시 통과한다(대조군). V2 는 막혀야 한다.
      record("재사용", `${label} 등록 해제·재등록 후 과거 서명`, true, blocked, label === "V2", label === "V1");
    }
  });

  it("3) 가변 서명 — 높은 s 값", async function () {
    const { v1, v2 } = await deployBoth();
    const a = alice.account.address;
    for (const [label, c] of [["V1", v1], ["V2", v2]] as const) {
      const sig = await sign(alice, authMsg(c.address, a, 0n));
      const twin = malleate(sig);
      assert.notEqual(twin, sig);
      const blocked = await reverts(c.write.verifySignature([a, 0n, twin]));
      record("가변 서명", `${label} 같은 메시지의 높은-s 서명`, true, blocked, label === "V2", label === "V1");
    }
  });

  it("4) 권한 — 소유자 외 호출과 2단계 소유권 이전", async function () {
    const v2 = await viem.deployContract("AuthVerifier");
    const trade = await viem.deployContract("MockTrade");
    const asMallory = { account: mallory.account };
    const a = alice.account.address;

    record("권한", "타인이 지갑 등록", true, await reverts(v2.write.registerWalletFor([a], asMallory)));
    await v2.write.registerWalletFor([a]);
    record("권한", "타인이 지갑 등록 해제", true, await reverts(v2.write.unregisterWallet([a], asMallory)));
    const sig = await sign(alice, authMsg(v2.address, a, 0n));
    record("권한", "타인이 서명 검증 호출(논스 소비)", true, await reverts(v2.write.verifySignature([a, 0n, sig], asMallory)));
    record("권한", "타인이 초기 자금 기록", true, await reverts(trade.write.recordSeed([a, 10_000_000n], asMallory)));
    record("권한", "타인이 거래 감사 기록 위조", true,
      await reverts(trade.write.logTrade([a, "005930", "buy", 1n, 0n], asMallory)));

    await v2.write.transferOwnership([newOwner.account.address]);
    record("권한", "지명되지 않은 주소의 소유권 수락", true, await reverts(v2.write.acceptOwnership(asMallory)));
    assert.equal((await v2.read.owner()).toLowerCase(), owner.account.address.toLowerCase());
    record("권한", "지명된 주소의 소유권 수락", false,
      await reverts(v2.write.acceptOwnership({ account: newOwner.account })));
    assert.equal((await v2.read.owner()).toLowerCase(), newOwner.account.address.toLowerCase());
    record("권한", "이전 소유자의 등록 시도(이전 후)", true,
      await reverts(v2.write.registerWalletFor([mallory.account.address])));
  });

  it("5) 블록 포함 전 창 — 체인만으로는 같은 서명의 이중 통과를 막지 못한다", async function () {
    const { v2 } = await deployBoth();
    const a = alice.account.address;
    const sig = await sign(alice, authMsg(v2.address, a, 0n));

    await testClient.setAutomine(false);
    try {
      await v2.write.verifySignature([a, 0n, sig]); // 전송만 됨(블록 미포함)
      // 서버가 쓰는 사전 실행(eth_call)은 최신 블록 기준이라 아직 논스 0 을 본다.
      const simulatePasses = !(await reverts(
        publicClient.simulateContract({
          address: v2.address, abi: v2.abi, functionName: "verifySignature",
          args: [a, 0n, sig], account: owner.account,
        }),
      ));
      // 체인 단독 방어 = 막지 못함 → 서버의 논스 소비 기록(wallet_nonce_uses)이 필요한 근거
      record("포함 전 창", "블록 포함 전 같은 서명 사전 실행(체인 단독)", true, !simulatePasses, false, true);
    } finally {
      await testClient.mine({ blocks: 1 });
      await testClient.setAutomine(true);
    }
    record("포함 전 창", "블록 포함 후 같은 서명 재제출", true, await reverts(v2.write.verifySignature([a, 0n, sig])));
  });

  it("6) MockTrade — 지급 1회 제한과 감사 이벤트", async function () {
    const trade = await viem.deployContract("MockTrade");
    const a = alice.account.address;
    record("MockTrade", "최초 초기 자금 기록", false, await reverts(trade.write.recordSeed([a, 10_000_000n])));
    record("MockTrade", "같은 지갑 초기 자금 재기록", true, await reverts(trade.write.recordSeed([a, 10_000_000n])));
    record("MockTrade", "영 주소 초기 자금 기록", true,
      await reverts(trade.write.recordSeed(["0x0000000000000000000000000000000000000000", 1n])));
    await viem.assertions.emitWithArgs(
      trade.write.logTrade([a, "005930|buy|market|10|0", "buy", 1_000_000n, 0n]),
      trade,
      "TradeLogged",
      [getAddress(a), "005930|buy|market|10|0", "buy", 1_000_000n, 0n, (await publicClient.getBlock()).timestamp + 1n],
    );
    assert.equal(await trade.read.getTradeLogCount(), 1n);
    assert.equal(await trade.read.getSeedCount(), 1n);
  });

  after(() => {
    const attacks = rows.filter((r) => r.attack);
    const blocked = attacks.filter((r) => r.blocked).length;
    const normals = rows.filter((r) => !r.attack);
    const falseBlocks = normals.filter((r) => r.blocked).length;
    const mismatch = rows.filter((r) => r.blocked !== r.expectBlocked).length;
    const v2Attacks = attacks.filter((r) => !r.control);
    const v2Blocked = v2Attacks.filter((r) => r.blocked).length;

    console.log("\n[보안 테스트] 온체인 인증 컨트랙트 (AuthVerifier · MockTrade)");
    console.log(
      `총 시도: ${rows.length}회 | 공격: ${attacks.length}회 | 차단: ${blocked}회 | ` +
        `수정본 탐지율: ${((v2Blocked / v2Attacks.length) * 100).toFixed(0)}% (${v2Blocked}/${v2Attacks.length})`,
    );
    console.log(`  정상 호출 오차단: ${falseBlocks}/${normals.length}`);
    for (const g of [...new Set(rows.map((r) => r.group))]) {
      const rs = rows.filter((r) => r.group === g);
      console.log(`  - ${g.padEnd(8)}: ${rs.map((r) => `${r.name} → ${r.blocked ? "차단" : "통과"}`).join(" / ")}`);
    }
    console.log("  대조군(V1, 현재 Sepolia 배포본): 재등록 후 과거 서명·높은-s 서명이 통과 → 수정본은 둘 다 차단");
    console.log("  체인 단독: 블록 포함 전 같은 서명이 사전 실행을 통과 → 서버 논스 소비 기록으로 보완");
    console.log(`검증 항목: ${rows.length - mismatch}건 통과 / ${mismatch}건 실패`);
    console.log(`판정: ${mismatch === 0 ? "PASS" : "FAIL"}`);
  });
});
