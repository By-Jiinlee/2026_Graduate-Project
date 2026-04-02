import cron from 'node-cron';
import {
    getActiveStocks,
    getLastSavedDate,
    fetchDailyPrices,
    upsertStockPrices,
    getToday
} from '../../services/market/StockPrice';

export const collectStockPrices = async () => {
    console.log("[StockPrice] 일봉 데이터 수집을 시작합니다.");
    const stocks = await getActiveStocks();
    const today = getToday();

    for (const stock of stocks) {
        try {
            const lastDate = await getLastSavedDate(stock.id) || '20260101';

            if (lastDate >= today) continue;

            const prices = await fetchDailyPrices(stock.code, lastDate, today);

            if (prices.length > 0) {
                await upsertStockPrices(stock.id, prices);
                console.log(`[Success] ${stock.code}: ${prices.length}건 업데이트`);
            }

            // 한투 초당 호출 제한 방지 (0.2초 대기)
            await new Promise(resolve => setTimeout(resolve, 200));

        } catch (error: any) {
            console.error(`[Error] ${stock.code} 처리 중 오류:`, error.message);
        }
    }
    console.log("[StockPrice] 모든 수집 작업 완료.");
};

export const startStockPriceScheduler = () => {
    // 평일(월-금) 오후 4시 실행
    cron.schedule('0 16 * * 1-5', async () => {
        await collectStockPrices();
    }, {
        timezone: "Asia/Seoul"
    });

    console.log("[StockPrice] 스케줄러 등록 완료 (평일 16:00 KST)");

    // 필요 시 서버 구동 즉시 실행 테스트를 원하면 아래 주석 해제
    // collectStockPrices();
};