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

export const collectStockPrices = async () => {
    const today = getToday();

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


    collectStockPrices();
};