import cron from 'node-cron'
import {
    calculate52Week,
    upsert52Week,
    getLastSavedDate,
    getCollectStartDate,
    getMissingDatesPerStock,
    getToday,
    dayAfter,
} from '../../services/market/Stock52Week'

// ─── 수집 로직 ────────────────────────────────────────────────

export const collectStock52Week = async (): Promise<void> => {
    console.log('[Stock52Week] 수집 시작')

    const today = getToday()
    const lastDate = await getLastSavedDate()

    // ① lastDate 이후 신규 날짜 수집
    // 예: lastDate = 2026-04-09 → cursor = 2026-04-10부터 오늘까지
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

        cursor = dayAfter(cursor)
    }

    // ② 처음 수집일부터 현재까지 종목별 구멍 탐지 및 보완
    // getCollectStartDate() = MIN(trade_date) → 테이블에서 가장 오래된 날짜
    // 예: MIN = 2026-03-31 → 2026-03-31 이후 전체 범위 탐지
    // → 3월 31일, 4월 1일, 4월 7일 구멍 모두 발견 가능
    const since = await getCollectStartDate()

    if (!since) {
        console.log('[Stock52Week] 수집 완료')
        return
    }

    console.log(`[Stock52Week] 종목별 누락 날짜 탐지 중... (${since} 이후)`)
    const missingMap = await getMissingDatesPerStock(since)

    if (missingMap.size === 0) {
        console.log('[Stock52Week] 누락 없음')
    } else {
        // calculate52Week는 날짜 하나로 전종목을 처리하므로
        // 날짜 기준으로 묶어서 중복 없이 처리
        const dateSet = new Set<string>()
        for (const dates of missingMap.values()) {
            dates.forEach((d) => dateSet.add(d))
        }
        const missingDates = [...dateSet].sort()

        console.log(`[Stock52Week] 누락 날짜 ${missingDates.length}개 보완 시작`)

        for (const date of missingDates) {
            try {
                const rows = await calculate52Week(date)

                if (rows.length > 0) {
                    await upsert52Week(rows)
                    console.log(`[Stock52Week] 누락 보완 ${date} 완료 (${rows.length}건)`)
                }
            } catch (err) {
                console.error(`[Stock52Week] 누락 보완 ${date} 오류:`, err)
            }
        }
    }

    console.log('[Stock52Week] 수집 완료')
}

// ─── 스케줄러 등록 ────────────────────────────────────────────

export const startStock52WeekScheduler = (): void => {
    // 평일 16:10 (장 마감 후)
    cron.schedule(
        '10 16 * * 1-5',
        () => {
            collectStock52Week().catch((err) =>
                console.error('[Stock52Week] 스케줄러 오류:', err)
            )
        },
        { timezone: 'Asia/Seoul' }
    )

    console.log('[Stock52Week] 스케줄러 등록 완료 (평일 16:10 KST)')

    // 서버 시작 시 누락 데이터 즉시 수집
    collectStock52Week().catch((err) =>
        console.error('[Stock52Week] 초기 수집 오류:', err)
    )
}
