import cron from 'node-cron'
import {
    fetchListedShares,
    updateListedShares,
    getActiveStocks,
} from '../../services/market/ListedShares'

// ─── 수집 로직 ────────────────────────────────────────────────

export const collectListedShares = async (): Promise<void> => {
    console.log('[ListedShares] 수집 시작')

    const stocks = await getActiveStocks()

    for (const stock of stocks) {
        try {
            console.log(`[ListedShares] 처리 중 - ${stock.code}`)
            const listedShares = await fetchListedShares(stock.code)
            console.log(`[ListedShares] ${stock.code}: ${listedShares}`)

            if (listedShares) {
                await updateListedShares(stock.id, listedShares)
                console.log(`[ListedShares] ${stock.code} 저장 완료: ${listedShares}`)
            }

            await new Promise((r) => setTimeout(r, 100))
        } catch (err) {
            console.error(`[ListedShares] 오류 - ${stock.code}:`, err)
        }
    }

    console.log('[ListedShares] 수집 완료')
}

// ─── 스케줄러 등록 ────────────────────────────────────────────

export const startListedSharesScheduler = (): void => {
    // 매주 월요일 오전 7:00 (장 시작 전)
    cron.schedule(
        '0 7 * * 1',
        () => {
            collectListedShares().catch((err) =>
                console.error('[ListedShares] 스케줄러 오류:', err)
            )
        },
        { timezone: 'Asia/Seoul' }
    )

    console.log('[ListedShares] 스케줄러 등록 완료 (매주 월요일 07:00 KST)')

    // 서버 시작 시 즉시 수집
    collectListedShares().catch((err) =>
        console.error('[ListedShares] 초기 수집 오류:', err)
    )
}