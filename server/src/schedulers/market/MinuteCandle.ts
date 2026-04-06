import cron from 'node-cron'
import {
    fetchDayCandles,
    upsertMinuteCandles,
    getActiveStocks,
    getLastSavedDate,
    getToday,
    dayAfter,
} from '../../services/market/MinuteCandle'

// ─── 주말 여부 확인 ───────────────────────────────────────────

const isWeekend = (dateStr: string): boolean => {
    const d = new Date(`${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`)
    return d.getDay() === 0 || d.getDay() === 6
}

// ─── 수집 로직 ────────────────────────────────────────────────

export const collectMinuteCandles = async (): Promise<void> => {
    console.log('[MinuteCandle] 수집 시작')

    const stocks = await getActiveStocks()
    const today = getToday()

    for (const stock of stocks) {
        try {
            const lastDate = await getLastSavedDate(stock.id)

            let cursor = lastDate ? dayAfter(lastDate) : today

            while (cursor <= today) {
                if (!isWeekend(cursor)) {
                    const rows = await fetchDayCandles(stock.code, cursor)

                    if (rows.length > 0) {
                        await upsertMinuteCandles(stock.id, cursor, rows)
                        console.log(`[MinuteCandle] ${stock.code} [${cursor}] 완료 (${rows.length}건)`)
                    }

                    await new Promise((r) => setTimeout(r, 500))
                }

                cursor = dayAfter(cursor)
            }
        } catch (err) {
            console.error(`[MinuteCandle] 오류 - ${stock.code}:`, err)
        }
    }

    console.log('[MinuteCandle] 수집 완료')
}

// ─── 스케줄러 등록 ────────────────────────────────────────────

export const startMinuteCandleScheduler = (): void => {
    cron.schedule(
        '30 17 * * 1-5',
        () => {
            collectMinuteCandles().catch((err) =>
                console.error('[MinuteCandle] 스케줄러 오류:', err)
            )
        },
        { timezone: 'Asia/Seoul' }
    )

    console.log('[MinuteCandle] 스케줄러 등록 완료 (평일 17:30 KST)')

    collectMinuteCandles().catch((err) =>
        console.error('[MinuteCandle] 초기 수집 오류:', err)
    )
}