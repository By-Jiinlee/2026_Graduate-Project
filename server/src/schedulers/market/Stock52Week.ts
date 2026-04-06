import cron from 'node-cron'
import {
    calculate52Week,
    upsert52Week,
    getLastSavedDate,
    getToday,
    dayAfter,
} from '../../services/market/Stock52Week'

// ─── 수집 로직 ────────────────────────────────────────────────

export const collectStock52Week = async (): Promise<void> => {
    console.log('[Stock52Week] 수집 시작')

    const today = getToday()
    const lastDate = await getLastSavedDate()

    // 마지막 저장일 다음날부터 오늘까지 순서대로 계산
    let cursor = lastDate ? dayAfter(lastDate) : today

    while (cursor <= today) {
        try {
            const rows = await calculate52Week(cursor)

            if (rows.length > 0) {
                await upsert52Week(rows)
                console.log(`[Stock52Week] ${cursor} 완료 (${rows.length}건)`)
            }
        } catch (err) {
            console.error(`[Stock52Week] ${cursor} 오류:`, err)
        }

        // 다음 날로 이동
        cursor = dayAfter(cursor)
    }

    console.log('[Stock52Week] 수집 완료')
}

// ─── 스케줄러 등록 ────────────────────────────────────────────

export const startStock52WeekScheduler = (): void => {
    // 평일 16:30 (장 마감 후 1시간)
    cron.schedule(
        '10 16 * * 1-5',
        () => {
            collectStock52Week().catch((err) =>
                console.error('[Stock52Week] 스케줄러 오류:', err)
            )
        },
        { timezone: 'Asia/Seoul' }
    )

    console.log('[Stock52Week] 스케줄러 등록 완료 (평일 16:30 KST)')

    // 서버 시작 시 누락 데이터 즉시 수집
    collectStock52Week().catch((err) =>
        console.error('[Stock52Week] 초기 수집 오류:', err)
    )
}