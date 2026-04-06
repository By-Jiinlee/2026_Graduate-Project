import cron from 'node-cron'
import {
    fetchShortSelling,
    upsertShortSelling,
    getActiveStocks,
    getLastSavedDate,
    dayAfter,
    getToday,
    toKisDate,
} from '../../services/market/ShortSelling'

// ─── 수집 로직 ────────────────────────────────────────────────

export const collectShortSelling = async (): Promise<void> => {
    console.log('[ShortSelling] 수집 시작')

    const stocks = await getActiveStocks()
    const today = getToday()

    for (const stock of stocks) {
        try {
            console.log(`[ShortSelling] 처리 중 - ${stock.code}`)

            const lastDate = await getLastSavedDate(stock.id)
            console.log(`[ShortSelling] lastDate: ${lastDate}`)

            const startDate = lastDate
                ? dayAfter(lastDate)
                : toKisDate(new Date(Date.now() - 365 * 24 * 60 * 60 * 1000))

            console.log(`[ShortSelling] startDate: ${startDate}`)

            if (startDate > today) continue

            const rows = await fetchShortSelling(stock.code, startDate, today)
            console.log(`[ShortSelling] 응답 - ${stock.code}: ${rows.length}건`)

            if (rows.length > 0) {
                await upsertShortSelling(stock.id, rows)
                console.log(`[ShortSelling] ${stock.code} 완료 (${rows.length}건)`)
            }

            await new Promise((r) => setTimeout(r, 500))
        } catch (err) {
            console.error(`[ShortSelling] 오류 - ${stock.code}:`, err)
        }
    }

    console.log('[ShortSelling] 수집 완료')
}

// ─── 스케줄러 등록 ────────────────────────────────────────────

export const startShortSellingScheduler = (): void => {
    cron.schedule(
        '0 17 * * 1-5',
        () => {
            collectShortSelling().catch((err) =>
                console.error('[ShortSelling] 스케줄러 오류:', err)
            )
        },
        { timezone: 'Asia/Seoul' }
    )

    console.log('[ShortSelling] 스케줄러 등록 완료 (평일 17:00 KST)')

    collectShortSelling().catch((err) =>
        console.error('[ShortSelling] 초기 수집 오류:', err)
    )
}