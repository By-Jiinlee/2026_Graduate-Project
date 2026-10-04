// 함수별 가스 사용량 측정 (로컬 체인).
// 서버가 대납하는 비용의 크기를 단위(gas)로 제시하기 위함이다. 가스 가격은 네트워크 상황에 따라
// 바뀌므로 금액이 아니라 사용량만 기록한다.
//
// 실행: cd contracts && npx hardhat run scripts/measure-gas.ts
import { network } from "hardhat";
import { encodePacked, keccak256, type Hex } from "viem";

const { viem } = await network.connect();
const publicClient = await viem.getPublicClient();
const [, alice] = await viem.getWalletClients();
const chainId = BigInt(await publicClient.getChainId());
const a = alice.account.address;

const gasOf = async (hash: Hex) => (await publicClient.waitForTransactionReceipt({ hash })).gasUsed;
const deployGas = async (name: string) => {
  const { contract, deploymentTransaction } = await viem.sendDeploymentTransaction(name as any);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: deploymentTransaction.hash });
  return { contract: contract as any, gas: receipt.gasUsed };
};

const auth = await deployGas("AuthVerifier");
const trade = await deployGas("MockTrade");
const v = auth.contract;
const m = trade.contract;

const rows: [string, bigint][] = [
  ["AuthVerifier 배포", auth.gas],
  ["MockTrade 배포", trade.gas],
];

rows.push(["registerWalletFor (가입)", await gasOf(await v.write.registerWalletFor([a]))]);

const authHash = keccak256(encodePacked(["uint256", "address", "address", "uint256"], [chainId, v.address, a, 0n]));
const authSig = await alice.signMessage({ account: alice.account, message: { raw: authHash } });
rows.push(["verifySignature (첫 로그인, 논스 0→1)", await gasOf(await v.write.verifySignature([a, 0n, authSig]))]);
// 두 번째부터는 논스 슬롯이 이미 0 이 아니어서 저장 비용이 낮다 — 평상시 로그인 비용
const authHash2 = keccak256(encodePacked(["uint256", "address", "address", "uint256"], [chainId, v.address, a, 1n]));
const authSig2 = await alice.signMessage({ account: alice.account, message: { raw: authHash2 } });
rows.push(["verifySignature (이후 로그인, 논스 1→2)", await gasOf(await v.write.verifySignature([a, 1n, authSig2]))]);

const desc = "005930|buy|market|10|0";
const tradeHash = keccak256(
  encodePacked(["uint256", "address", "address", "uint256", "uint256", "string"], [chainId, v.address, a, 0n, 700_000n, desc]),
);
const tradeSig = await alice.signMessage({ account: alice.account, message: { raw: tradeHash } });
rows.push(["verifyTradeSignature (고액 주문)", await gasOf(await v.write.verifyTradeSignature([a, 0n, 700_000n, desc, tradeSig]))]);

rows.push(["recordSeed (계좌 개설)", await gasOf(await m.write.recordSeed([a, 10_000_000n]))]);
rows.push(["logTrade (감사 기록)", await gasOf(await m.write.logTrade([a, desc, "buy", 700_000n, 0n]))]);
rows.push(["anchorLedger (일별 장부 고정, 건수 무관)", await gasOf(await m.write.anchorLedger([20261001, `0x${"ab".repeat(32)}`, 500]))]);
rows.push(["unregisterWallet (탈퇴)", await gasOf(await v.write.unregisterWallet([a]))]);

console.log("\n[가스 측정] AuthVerifier · MockTrade (로컬 EDR, solc 0.8.28, 최적화 미적용 기본 프로파일)");
for (const [name, gas] of rows) console.log(`  ${name.padEnd(32)} ${gas.toLocaleString()} gas`);
