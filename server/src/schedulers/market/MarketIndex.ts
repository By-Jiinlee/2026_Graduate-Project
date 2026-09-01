import cron from 'node-cron'
import {
    fetchIndexData,
    upsertMarketIndex,
    getLastSavedDate,
    dayAfter,
    getToday,
    INDEX_MAP,
} from '../../services/market/MarketIndex'
import { runInitialCollect } from '../../utils/initialCollect'

// ─── 수집 로직 ────────────────────────────────────────────────

export const collectMarketIndices = async (): Promise<void> => {
    console.log('[MarketIndex] 수집 시작')

    const today = getToday()

    for (const index of INDEX_MAP) {
        try {
            const lastDate = await getLastSavedDate(index.dbSymbol)

            const startDate = lastDate
                ? dayAfter(lastDate)
                : '2015-04-06'  // 없으면 2015년부터

            if (startDate > today) continue

            console.log(`[MarketIndex] ${index.dbSymbol} 수집 중 (${startDate} ~ ${today})`)

            const rows = await fetchIndexData(index.yahooSymbol, startDate, today)
            await upsertMarketIndex(index.dbSymbol, index.name, rows)

            console.log(`[MarketIndex] ${index.dbSymbol} 완료 (${rows.length}건)`)

            await new Promise((r) => setTimeout(r, 500))
        } catch (err) {
            console.error(`[MarketIndex] 오류 - ${index.dbSymbol}:`, err)
        }
    }

    console.log('[MarketIndex] 수집 완료')
}

// ─── 스케줄러 등록 ────────────────────────────────────────────

export const startMarketIndexScheduler = (): void => {
    // 평일 18:00 (미국 장 마감 다음날 아침 기준)
    cron.schedule(
        '0 18 * * 1-5',
        () => {
            collectMarketIndices().catch((err) =>
                console.error('[MarketIndex] 스케줄러 오류:', err)
            )
        },
        { timezone: 'Asia/Seoul' }
    )

    console.log('[MarketIndex] 스케줄러 등록 완료 (평일 18:00 KST)')

    runInitialCollect('MarketIndex', collectMarketIndices)
}
// ─── CLI (서버와 분리해 단독 실행) ────────────────────────────
// 백필은 서버 라이프사이클에 묶지 않는다 — 재시작으로 중간에 끊기면 구간이 비고,
// 그 구멍은 MAX(trade_date) 기준으로 이어받는 수집기가 다시 메우지 못한다.
//   cd server && npx ts-node src/schedulers/market/MarketIndex.ts
if (require.main === module) {
    collectMarketIndices()
        .then(async () => {
            const sequelize = (await import('../../config/database')).default
            await sequelize.close()
            process.exit(0)
        })
        .catch(async (err) => {
            console.error('[MarketIndex] 실행 실패:', err?.message ?? err)
            process.exit(1)
        })
}
