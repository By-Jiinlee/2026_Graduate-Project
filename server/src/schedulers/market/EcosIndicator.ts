import cron from 'node-cron'
import {
    fetchEcosData,
    upsertEcosIndicators,
    getLastPeriod,
    getStartPeriod,
    getEndPeriod,
    DAILY_INDICATORS,
    MONTHLY_INDICATORS,
    QUARTERLY_INDICATORS,
} from '../../services/market/EcosIndicator'

// ─── 일별 수집 ────────────────────────────────────────────────

export const collectDailyIndicators = async (): Promise<void> => {
    console.log('[EcosIndicator] 일별 수집 시작')

    const endPeriod = getEndPeriod('D')

    for (const config of DAILY_INDICATORS) {
        try {
            const lastPeriod = await getLastPeriod(config.indicator)
            const startPeriod = getStartPeriod(lastPeriod, 'D')

            if (startPeriod > endPeriod) {
                console.log(`[EcosIndicator] ${config.indicator} 최신 상태`)
                continue
            }

            console.log(`[EcosIndicator] ${config.indicator} 수집 중 (${startPeriod} ~ ${endPeriod})`)
            const items = await fetchEcosData(config, startPeriod, endPeriod)

            if (items.length > 0) {
                await upsertEcosIndicators(items)
                console.log(`[EcosIndicator] ${config.indicator} ${items.length}건 저장`)
            } else {
                console.warn(`[EcosIndicator] ${config.indicator} 데이터 없음`)
            }
        } catch (err) {
            console.error(`[EcosIndicator] 일별 오류 - ${config.indicator}:`, err)
        }
    }
    console.log('[EcosIndicator] 일별 수집 완료')
}

// ─── 월별 수집 ────────────────────────────────────────────────

export const collectMonthlyIndicators = async (): Promise<void> => {
    console.log('[EcosIndicator] 월별 수집 시작')

    const endPeriod = getEndPeriod('M')

    for (const config of MONTHLY_INDICATORS) {
        try {
            const lastPeriod = await getLastPeriod(config.indicator)
            const startPeriod = getStartPeriod(lastPeriod, 'M')

            if (startPeriod > endPeriod) {
                console.log(`[EcosIndicator] ${config.indicator} 최신 상태`)
                continue
            }

            console.log(`[EcosIndicator] ${config.indicator} 수집 중 (${startPeriod} ~ ${endPeriod})`)
            const items = await fetchEcosData(config, startPeriod, endPeriod)

            if (items.length > 0) {
                await upsertEcosIndicators(items)
                console.log(`[EcosIndicator] ${config.indicator} ${items.length}건 저장`)
            } else {
                console.warn(`[EcosIndicator] ${config.indicator} 데이터 없음`)
            }
        } catch (err) {
            console.error(`[EcosIndicator] 월별 오류 - ${config.indicator}:`, err)
        }
    }
    console.log('[EcosIndicator] 월별 수집 완료')
}

// ─── 분기별 수집 ──────────────────────────────────────────────

export const collectQuarterlyIndicators = async (): Promise<void> => {
    console.log('[EcosIndicator] 분기별 수집 시작')

    const endPeriod = getEndPeriod('Q')

    for (const config of QUARTERLY_INDICATORS) {
        try {
            const lastPeriod = await getLastPeriod(config.indicator)
            const startPeriod = getStartPeriod(lastPeriod, 'Q')

            if (startPeriod > endPeriod) {
                console.log(`[EcosIndicator] ${config.indicator} 최신 상태`)
                continue
            }

            console.log(`[EcosIndicator] ${config.indicator} 수집 중 (${startPeriod} ~ ${endPeriod})`)
            const items = await fetchEcosData(config, startPeriod, endPeriod)

            if (items.length > 0) {
                await upsertEcosIndicators(items)
                console.log(`[EcosIndicator] ${config.indicator} ${items.length}건 저장`)
            } else {
                console.warn(`[EcosIndicator] ${config.indicator} 데이터 없음`)
            }
        } catch (err) {
            console.error(`[EcosIndicator] 분기별 오류 - ${config.indicator}:`, err)
        }
    }
    console.log('[EcosIndicator] 분기별 수집 완료')
}

// ─── 스케줄러 등록 ────────────────────────────────────────────

export const startEcosIndicatorScheduler = (): void => {
    // 일별: 평일 18:00
    cron.schedule('0 18 * * 1-5', () => {
        collectDailyIndicators().catch((err) =>
            console.error('[EcosIndicator] 일별 스케줄러 오류:', err)
        )
    }, { timezone: 'Asia/Seoul' })

    // 월별: 매월 2일 오전 6시
    cron.schedule('0 6 2 * *', () => {
        collectMonthlyIndicators().catch((err) =>
            console.error('[EcosIndicator] 월별 스케줄러 오류:', err)
        )
    }, { timezone: 'Asia/Seoul' })

    // 분기별: 1/4/7/10월 5일 오전 6시
    cron.schedule('0 6 5 1,4,7,10 *', () => {
        collectQuarterlyIndicators().catch((err) =>
            console.error('[EcosIndicator] 분기별 스케줄러 오류:', err)
        )
    }, { timezone: 'Asia/Seoul' })

    console.log('[EcosIndicator] 스케줄러 등록 완료 (일별/월별/분기별)')

    // 서버 시작 시 전체 초기 수집
    collectDailyIndicators().catch((err) =>
        console.error('[EcosIndicator] 초기 일별 수집 오류:', err)
    )
    collectMonthlyIndicators().catch((err) =>
        console.error('[EcosIndicator] 초기 월별 수집 오류:', err)
    )
    collectQuarterlyIndicators().catch((err) =>
        console.error('[EcosIndicator] 초기 분기별 수집 오류:', err)
    )
}