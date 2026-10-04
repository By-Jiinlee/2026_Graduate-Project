import cron from 'node-cron'
import { anchorDay, computeLedger, isLedgerOnChain, loadDayOrders, runDailyLedgerJob, verifyDay } from '../../services/web3/ledgerAnchorService'

// ─────────────────────────────────────────────────────────────
// 모의투자 체결 장부 일별 고정 스케줄러
//
// 매일 00:10 KST 에 전날까지의 장부를 고정하고 최근 7일을 다시 검증한다. 00:00 이 아니라
// 00:10 인 이유는 자정 직전에 체결된 주문의 커밋이 끝날 시간을 두기 위해서다.
// 체인 전송은 LEDGER_ANCHOR_ON_CHAIN=true 일 때만 한다 — 현재 Sepolia 배포본 MockTrade 에는
// anchorLedger 가 없어, 재배포 전까지는 루트를 DB 에만 남긴다.
// ─────────────────────────────────────────────────────────────

const runJob = async (): Promise<void> => {
  const r = await runDailyLedgerJob()
  const bad = r.verified.filter((v) => v.status === 'MISMATCH')
  console.log(
    `[Ledger] 고정 ${r.anchored.length}일(${r.anchored.join(', ') || '-'}) · 검증 ${r.verified.length}일` +
      (bad.length ? ` · ⚠️ 불일치 ${bad.map((b) => b.day).join(', ')}` : ' · 전부 일치') +
      ` · 체인 고정 ${isLedgerOnChain() ? '사용' : '미사용(DB 만)'}`,
  )
}

export const startLedgerAnchorScheduler = (): void => {
  cron.schedule(
    '10 0 * * *',
    () => {
      runJob().catch((err) => console.error('[Ledger] 스케줄러 오류:', err))
    },
    { timezone: 'Asia/Seoul' },
  )
  console.log('[Ledger] 체결 장부 고정 스케줄러 등록 완료 (매일 00:10 KST)')
}

// ─── CLI ──────────────────────────────────────────────────────
//   npx ts-node src/schedulers/trade/ledgerAnchorScheduler.ts            → 일일 작업 1회
//   npx ts-node src/schedulers/trade/ledgerAnchorScheduler.ts --day=20261001     → 그날 고정
//   npx ts-node src/schedulers/trade/ledgerAnchorScheduler.ts --verify=20261001  → 그날 검증
//   npx ts-node src/schedulers/trade/ledgerAnchorScheduler.ts --dry=20261001     → 계산만(DB 쓰기 없음)
if (require.main === module) {
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1]
  const main = async () => {
    const day = arg('day')
    const verify = arg('verify')
    const dry = arg('dry')
    if (dry) {
      const { entries, root } = computeLedger(await loadDayOrders(Number(dry)))
      console.log({ day: Number(dry), count: entries.length, root })
    } else if (day) console.log(await anchorDay(Number(day)).then((r) => ({ outcome: r.outcome, root: r.anchor?.merkle_root, count: r.anchor?.leaf_count })))
    else if (verify) console.log(await verifyDay(Number(verify)))
    else await runJob()
  }
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
}
