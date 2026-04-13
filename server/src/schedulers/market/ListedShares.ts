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
    const today = new Date().toISOString().slice(0, 10)  // 'YYYY-MM-DD'

    let updated = 0
    let skipped = 0

    for (const stock of stocks) {
        // 오늘 이미 업데이트된 종목은 스킵
        // updated_at이 Date 객체로 올 수도 있어서 new Date()로 변환
        if (stock.updated_at && new Date(stock.updated_at).toISOString().slice(0, 10) === today) {
            skipped++
            continue
        }

        let retries = 0

        while (retries < 3) {
            try {
                console.log(`[ListedShares] 처리 중 - ${stock.code}`)
                const listedShares = await fetchListedShares(stock.code)

                if (listedShares) {
                    await updateListedShares(stock.id, listedShares)
                    console.log(`[ListedShares] ${stock.code} 저장 완료: ${listedShares}`)
                    updated++
                }

                await new Promise((r) => setTimeout(r, 500))
                break  // 성공하면 while 탈출

            } catch (err: any) {
                // rate limit 에러면 대기 후 재시도
                if (err.response?.data?.message === 'EGW00201' || err.response?.status === 500) {
                    retries++
                    console.warn(`[ListedShares] Rate limit - ${stock.code} ${retries}회 재시도 대기 중...`)
                    await new Promise((r) => setTimeout(r, 3000 * retries))  // 3초, 6초, 9초
                } else {
                    console.error(`[ListedShares] 오류 - ${stock.code}:`, err.message ?? err)
                    break
                }
            }
        }

        if (retries >= 3) {
            console.error(`[ListedShares] ${stock.code} 최대 재시도 초과 - 스킵`)
        }
    }

    console.log(`[ListedShares] 수집 완료 — 업데이트 ${updated}건 / 스킵 ${skipped}건`)
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