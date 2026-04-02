import cron from 'node-cron'
import {
    fetchForeignAndInstitutional,
    upsertForeignAndInstitutional,
    getActiveStocks,
    getLastSavedDate,
    dayAfter,
    getToday,
    toKisDate,
} from '../../services/market/ForeignAndInstitutional'

// ─── 수집 로직 ────────────────────────────────────────────────

export const collectForeignAndInstitutional = async (): Promise<void> => {
    console.log('[ForeignAndInstitutional] 수집 시작')

    const stocks = await getActiveStocks()
    const today = getToday()

    for (const stock of stocks) {
        try {
            console.log(`[ForeignAndInstitutional] 처리 중 - ${stock.code}`)
            const lastDate = await getLastSavedDate(stock.id)
            console.log(`[ForeignAndInstitutional] lastDate: ${lastDate}`)

            const startDate = lastDate
                ? dayAfter(lastDate)
                : toKisDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))

            console.log(`[ForeignAndInstitutional] startDate: ${startDate}`)

            if (startDate > today) continue

            const rows = await fetchForeignAndInstitutional(stock.code, startDate)

            if (rows.length > 0) {
                await upsertForeignAndInstitutional(stock.id, rows)
                console.log(`[ForeignAndInstitutional] ${stock.code} 완료 (${rows.length}건)`)
            }

            await new Promise((r) => setTimeout(r, 200))
        } catch (err) {
            console.error(`[ForeignAndInstitutional] 오류 - ${stock.code}:`, err)
        }
    }

    console.log('[ForeignAndInstitutional] 수집 완료')
}

// ─── 스케줄러 등록 ────────────────────────────────────────────

export const startForeignAndInstitutionalScheduler = (): void => {
    cron.schedule(
        '30 16 * * 1-5',
        () => {
            collectForeignAndInstitutional().catch((err) =>
                console.error('[ForeignAndInstitutional] 스케줄러 오류:', err)
            )
        },
        { timezone: 'Asia/Seoul' }
    )

    console.log('[ForeignAndInstitutional] 스케줄러 등록 완료 (평일 16:30 KST)')

    collectForeignAndInstitutional().catch((err) =>
        console.error('[ForeignAndInstitutional] 초기 수집 오류:', err)
    )
}