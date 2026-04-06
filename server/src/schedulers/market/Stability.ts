import cron from 'node-cron'
import {
    calcStability,
    getActiveStocks,
    getLastSavedDate,
    getToday,
    dayAfter,
} from '../../services/market/Stability'

// ─── 수집 로직 ────────────────────────────────────────────────

export const collectStability = async (): Promise<void> => {
    console.log('[Stability] 안정성 계산 시작')

    const stocks = await getActiveStocks()
    const today = getToday()
    const lastDate = await getLastSavedDate()

    let cursor = lastDate
        ? dayAfter(lastDate)   // ← 마지막 저장일 다음날부터
        : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)  // ← 처음엔 한달 전부터

    while (cursor <= today) {
        console.log(`[Stability] ${cursor} 계산 중...`)

        for (const stock of stocks) {
            try {
                await calcStability(stock.id, stock.code, cursor)
            } catch (err) {
                console.error(`[Stability] 오류 - ${stock.code} / ${cursor}:`, err)
            }
        }

        console.log(`[Stability] ${cursor} 완료`)
        cursor = dayAfter(cursor)
    }

    console.log('[Stability] 안정성 계산 완료')
}

// ─── 스케줄러 등록 ────────────────────────────────────────────

export const startStabilityScheduler = (): void => {
    // 평일 19:00 (모든 데이터 수집 완료 후)
    cron.schedule(
        '0 19 * * 1-5',
        () => {
            collectStability().catch((err) =>
                console.error('[Stability] 스케줄러 오류:', err)
            )
        },
        { timezone: 'Asia/Seoul' }
    )

    console.log('[Stability] 스케줄러 등록 완료 (평일 19:00 KST)')

    collectStability().catch((err) =>
        console.error('[Stability] 초기 수집 오류:', err)
    )
}