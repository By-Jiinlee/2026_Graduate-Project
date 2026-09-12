import cron from 'node-cron';
import {
    getActiveStocks,
    fetchDailyPrices,
    upsertStockPrices,
    getToday,
    isTodayComplete,
    getAllLastDates,
} from '../../services/market/StockPrice';
import { kisUnsupported, markUnsupported } from '../../utils/kisUnsupported'
import { runInitialCollect } from '../../utils/initialCollect'

/**
 * @param force  주말·완료 여부 체크를 건너뛴다. 크론은 평일 장 마감 후에만 돌아야 하지만,
 *               수동 실행(CLI)은 "지금 받겠다"는 명시적 의도이므로 주말에도 밀린 구간을
 *               따라잡을 수 있어야 한다. KIS 기간별시세는 요일과 무관하게 응답한다.
 */
export const collectStockPrices = async (opts: { force?: boolean } = {}) => {
    const today = getToday();

    if (!opts.force) {
        // ① 주말이면 즉시 종료
        const dow = new Date().getDay()
        if (dow === 0 || dow === 6) {
            console.log('[StockPrice] 주말 - 수집 스킵');
            return;
        }

        // ② 오늘 데이터 전종목 완료 여부 빠른 체크
        if (await isTodayComplete(today)) {
            console.log(`[StockPrice] 오늘(${today}) 데이터 이미 완료 - 수집 스킵`);
            return;
        }
    }

    console.log('[StockPrice] 일봉 데이터 수집을 시작합니다.');

    // ③ 전종목 마지막 저장일 한번에 조회 (N+1 해소)
    const [stocks, lastDateMap] = await Promise.all([
        getActiveStocks(),
        getAllLastDates(),
    ]);

    let updated = 0;
    let skipped = 0;

    for (const stock of stocks) {
        if (kisUnsupported.has(stock.code)) { skipped++; continue; }

        const lastDate = lastDateMap.get(stock.id) ?? '20160101';
        if (lastDate >= today) { skipped++; continue; }

        try {
            const prices = await fetchDailyPrices(stock.code, lastDate, today);

            if (prices.length > 0) {
                await upsertStockPrices(stock.id, prices);
                console.log(`[Success] ${stock.code}: ${prices.length}건 업데이트`);
                updated++;
            }

            await new Promise(resolve => setTimeout(resolve, 200));

        } catch (error: any) {
            const status = error.response?.status
            if (status === 403 || status === 500) {
                console.warn(`[StockPrice] ${stock.code}: 미지원 종목 (${status}) - 이후 수집에서 제외`);
                markUnsupported(stock.code);
            } else {
                console.error(`[Error] ${stock.code} 처리 중 오류:`, error.message);
            }
        }
    }

    console.log(`[StockPrice] 수집 완료 — 업데이트 ${updated}건 / 스킵 ${skipped}건 / 미지원 ${kisUnsupported.size}건`);
};

export const startStockPriceScheduler = () => {
    // 평일(월-금) 오후 4시 실행
    cron.schedule('0 16 * * 1-5', async () => {
        await collectStockPrices();
    }, {
        timezone: "Asia/Seoul"
    });

    console.log("[StockPrice] 스케줄러 등록 완료 (평일 16:00 KST)");

    runInitialCollect('StockPrice', async () => { await collectStockPrices() });
};

// ─── CLI (서버와 분리해 단독 실행) ────────────────────────────
// 주말·장외에도 밀린 구간을 따라잡을 수 있게 force 로 돈다.
// 종목별 마지막 저장일 ~ 오늘을 범위로 요청하므로 꼬리 구멍은 자동으로 메워진다.
// (KIS 응답이 100건 제한이라 5개월 이상 밀리면 잘린다 — 그 전에 돌릴 것)
//   cd server && npx ts-node src/schedulers/market/StockPrice.ts
if (require.main === module) {
    collectStockPrices({ force: true })
        .then(async () => {
            const sequelize = (await import('../../config/database')).default
            await sequelize.close()
            process.exit(0)
        })
        .catch((err) => {
            console.error('[StockPrice] 실행 실패:', err?.message ?? err)
            process.exit(1)
        })
}
