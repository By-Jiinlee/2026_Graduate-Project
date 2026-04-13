import cron from 'node-cron'
import {
    fetchDayCandles,
    upsertMinuteCandles,
    getActiveStocks,
    getToday,
    dayAfter,
    getAllLastMinuteDates,
} from '../../services/market/MinuteCandle'
import { kisUnsupported, markUnsupported } from '../../utils/kisUnsupported'

// ─── 주말 여부 확인 ───────────────────────────────────────────

const isWeekend = (dateStr: string): boolean => {
    const d = new Date(`${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`)
    return d.getDay() === 0 || d.getDay() === 6
}

// ─── 수집 로직 ────────────────────────────────────────────────

export const collectMinuteCandles = async (): Promise<void> => {
    const today = getToday()

    // ① 주말이면 즉시 종료
    const dow = new Date().getDay()
    if (dow === 0 || dow === 6) {
        console.log('[MinuteCandle] 주말 - 수집 스킵')
        return
    }

    console.log('[MinuteCandle] 수집 시작')

    // ② 전종목 마지막 분봉 날짜 한번에 조회
    console.log('[MinuteCandle] 전종목 마지막 분봉 날짜 조회 중...')
    const [stocks, lastDateMap] = await Promise.all([
        getActiveStocks(),
        getAllLastMinuteDates(),
    ])
    console.log(`[MinuteCandle] 활성 종목 ${stocks.length}개 / 기존 분봉 보유 종목 ${lastDateMap.size}개`)

    // ③ 전종목이 오늘까지 있으면 스킵 (DB 쿼리 없이 메모리에서 판단)
    const alreadyDone = stocks.every((s) => {
        if (kisUnsupported.has(s.code)) return true
        const lastDate = lastDateMap.get(s.id)
        return lastDate !== undefined && lastDate >= today
    })

    if (alreadyDone) {
        console.log(`[MinuteCandle] 오늘(${today}) 분봉 전종목 완료 - 수집 스킵`)
        return
    }

    let updated = 0
    let skipped = 0
    let stockIdx = 0

    for (const stock of stocks) {
        stockIdx++

        if (kisUnsupported.has(stock.code)) {
            skipped++
            continue
        }

        const lastDate = lastDateMap.get(stock.id) ?? null
        let cursor = lastDate ? dayAfter(lastDate) : today

        // 이미 오늘까지 있으면 스킵
        if (cursor > today) {
            skipped++
            continue
        }

        // 100종목마다 진행 상황 로그
        if (stockIdx % 100 === 0) {
            console.log(`[MinuteCandle] 진행 중 ${stockIdx}/${stocks.length} — 완료 ${updated}건 / 스킵 ${skipped}건 / 미지원 ${kisUnsupported.size}종목`)
        }

        try {
            while (cursor <= today) {
                if (!isWeekend(cursor)) {
                    const rows = await fetchDayCandles(stock.code, cursor)

                    if (rows.length > 0) {
                        await upsertMinuteCandles(stock.id, cursor, rows)
                        console.log(`[MinuteCandle] ${stock.code} [${cursor}] 완료 (${rows.length}건)`)
                        updated++
                    } else {
                        console.log(`[MinuteCandle] ${stock.code} [${cursor}] 데이터 없음`)
                    }

                    await new Promise((r) => setTimeout(r, 500))
                }

                cursor = dayAfter(cursor)
            }
        } catch (err: any) {
            if (err.response?.status === 403 || err.response?.status === 500) {
                console.warn(`[MinuteCandle] ${stock.code}: KIS API 미지원 종목 (${err.response.status}) - 이후 수집에서 제외`)
                markUnsupported(stock.code)
            } else {
                console.error(`[MinuteCandle] 오류 - ${stock.code}:`, err.message ?? err)
            }
        }
    }

    console.log(`[MinuteCandle] 수집 완료 — 업데이트 ${updated}건 / 스킵 ${skipped}건 / 미지원 ${kisUnsupported.size}종목`)
}

// ─── 스케줄러 등록 ────────────────────────────────────────────

export const startMinuteCandleScheduler = (): void => {
    // 장 마감 후 당일 분봉 수집
    cron.schedule(
        '30 17 * * 1-5',
        () => collectMinuteCandles().catch(err => console.error('[MinuteCandle] 스케줄러 오류:', err)),
        { timezone: 'Asia/Seoul' }
    )

    // 장 시작 직후 전날 누락분 보완
    cron.schedule(
        '5 9 * * 1-5',
        () => collectMinuteCandles().catch(err => console.error('[MinuteCandle] 오전 수집 오류:', err)),
        { timezone: 'Asia/Seoul' }
    )

    console.log('[MinuteCandle] 스케줄러 등록 완료 (평일 09:05, 17:30 KST)')

    collectMinuteCandles().catch((err) =>
        console.error('[MinuteCandle] 초기 수집 오류:', err)
    )
}