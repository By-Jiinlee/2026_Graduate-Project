import cron from 'node-cron'
import {
    fetchCommodityData,
    upsertCommodityPrices,
    getLastSavedDate,
    dayAfter,
    getToday,
    COMMODITY_MAP,
} from '../../services/market/Commodity'
import { runInitialCollect } from '../../utils/initialCollect'

// ─────────────────────────────────────────────────────────────
// 원자재 시세 수집 (WTI / GOLD / COPPER / NATGAS)
//
// 출처는 MarketIndex 와 같은 Yahoo Finance 차트 API 다(키 불필요). KIS 를 쓰지 않으므로
// 일봉·분봉 수집과 API 한도를 다투지 않는다.
//
// 적재 대상 commodity_prices 는 AI 쪽 build_commodity_feature.py 의 원천이다.
// commodity 값(WTI/GOLD/COPPER/NATGAS)이 피처 접두어(wti_/gold_/...)를 결정하므로
// 문자열을 바꾸면 안 된다.
//
// 서버를 띄우지 않고 백필만 하려면:
//   cd server && npx ts-node src/schedulers/market/Commodity.ts
// ─────────────────────────────────────────────────────────────

export const collectCommodityPrices = async (): Promise<void> => {
    console.log('[Commodity] 수집 시작')

    const today = getToday()

    for (const item of COMMODITY_MAP) {
        try {
            const lastDate = await getLastSavedDate(item.dbName)

            const startDate = lastDate
                ? dayAfter(lastDate)
                : '2021-01-01'  // 없으면 기존 적재 구간 시작점부터

            if (startDate > today) {
                console.log(`[Commodity] ${item.dbName} 최신 상태 - 스킵`)
                continue
            }

            console.log(`[Commodity] ${item.dbName} 수집 중 (${startDate} ~ ${today})`)

            const rows = await fetchCommodityData(item.yahooSymbol, startDate, today)

            // 당일 봉은 장중이라 OHLC·거래량이 확정되지 않았다. 적재해 두면 나중에
            // 값이 바뀌는데 유니크 키가 같아 조용히 덮어써지므로, 확정된 날만 넣는다.
            const settled = rows.filter((row) => row.date < today)
            await upsertCommodityPrices(item.dbName, settled)

            const skipped = rows.length - settled.length
            console.log(
                `[Commodity] ${item.dbName} 완료 (${settled.length}건` +
                `${skipped > 0 ? `, 당일 미확정 ${skipped}건 제외` : ''})`
            )

            await new Promise((r) => setTimeout(r, 500))
        } catch (err: any) {
            console.error(`[Commodity] 오류 - ${item.dbName}:`, err?.message ?? err)
        }
    }

    console.log('[Commodity] 수집 완료')
}

// ─── 스케줄러 등록 ────────────────────────────────────────────

export const startCommodityScheduler = (): void => {
    // 평일 18:00 (미국 선물 전일 종가 확정 이후) — MarketIndex 와 같은 시각
    cron.schedule(
        '0 18 * * 1-5',
        () => {
            collectCommodityPrices().catch((err) =>
                console.error('[Commodity] 스케줄러 오류:', err)
            )
        },
        { timezone: 'Asia/Seoul' }
    )

    console.log('[Commodity] 스케줄러 등록 완료 (평일 18:00 KST)')

    runInitialCollect('Commodity', collectCommodityPrices)
}

// ─── CLI (서버와 분리해 단독 실행) ────────────────────────────
// 백필은 서버 라이프사이클에 묶지 않는다 — 재시작으로 중간에 끊기면
// 구간이 비고, 그 구멍은 MAX(date) 기준 수집기가 다시 메우지 못한다.
if (require.main === module) {
    collectCommodityPrices()
        .then(async () => {
            const sequelize = (await import('../../config/database')).default
            await sequelize.close()
            process.exit(0)
        })
        .catch(async (err) => {
            console.error('[Commodity] 실행 실패:', err?.message ?? err)
            process.exit(1)
        })
}
