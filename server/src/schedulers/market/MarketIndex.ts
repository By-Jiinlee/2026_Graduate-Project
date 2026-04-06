import cron from 'node-cron'
import {
    fetchIndexData,
    upsertMarketIndex,
    getLastSavedDate,
    dayAfter,
    getToday,
    INDEX_MAP,
} from '../../services/market/MarketIndex'

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

    collectMarketIndices().catch((err) =>
        console.error('[MarketIndex] 초기 수집 오류:', err)
    )
}