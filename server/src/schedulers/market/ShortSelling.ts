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
import { runInitialCollect } from '../../utils/initialCollect'

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

    runInitialCollect('ShortSelling', collectShortSelling)
}
// ─── CLI (서버와 분리해 단독 실행) ────────────────────────────
// 이 수집기는 FID_INPUT_DATE_1/2 로 기간을 제대로 넘기므로 백필이 그대로 된다.
//   cd server && npx ts-node src/schedulers/market/ShortSelling.ts
if (require.main === module) {
    collectShortSelling()
        .then(async () => {
            const sequelize = (await import('../../config/database')).default
            await sequelize.close()
            process.exit(0)
        })
        .catch((err) => {
            console.error('[ShortSelling] 실행 실패:', err?.message ?? err)
            process.exit(1)
        })
}
