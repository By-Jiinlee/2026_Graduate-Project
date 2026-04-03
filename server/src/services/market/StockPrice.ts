import axios from 'axios';
import { QueryTypes } from 'sequelize';
import sequelize from '../../config/database';

const APP_KEY = process.env.APP_KEY!;
const APP_SECRET = process.env.KIS_MOCK_APP_SECRET!;
const BASE_URL = 'https://openapi.koreainvestment.com:9443';

// ─── 토큰 관리 (메모리 캐싱) ──────────────────────────────
let cachedToken: string | null = null;
let lastTokenFetchTime: number = 0;

export const getAccessToken = async (): Promise<string> => {
    const now = Date.now();

    // 1분 이내 재요청 방지 (EGW00133 에러 대응)
    if (cachedToken && (now - lastTokenFetchTime < 60000)) {
        return cachedToken;
    }

    try {
        const res = await axios.post(`${BASE_URL}/oauth2/tokenP`, {
            grant_type: 'client_credentials',
            appkey: APP_KEY,
            appsecret: APP_SECRET,
        });

        cachedToken = res.data.access_token;
        lastTokenFetchTime = Date.now();
        console.log("[StockPrice] 새 접근 토큰 발급 완료");
        return cachedToken!;
    } catch (error: any) {
        if (error.response?.data?.error_code === 'EGW00133' && cachedToken) {
            return cachedToken;
        }
        throw error;
    }
};

// ─── 타입 및 API 호출 ────────────────────────────────────────

interface DailyPrice {
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    trading_value: number;
}

export const fetchDailyPrices = async (stockCode: string, startDate: string, endDate: string): Promise<DailyPrice[]> => {
    try {
        const token = await getAccessToken();
        const res = await axios.get(`${BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice`, {
            headers: {
                'content-type': 'application/json',
                'authorization': `Bearer ${token}`,
                'appkey': APP_KEY,
                'appsecret': APP_SECRET,
                'tr_id': 'FHKST03010100',
            },
            params: {
                FID_COND_MRKT_DIV_CODE: 'J',
                FID_INPUT_ISCD: stockCode,
                FID_INPUT_DATE_1: startDate,
                FID_INPUT_DATE_2: endDate,
                FID_PERIOD_DIV_CODE: 'D',
                FID_ORG_ADJ_PRC: '0',
            },
        });

        if (res.data?.rt_cd !== '0') return [];

        const output = res.data?.output2;
        if (!Array.isArray(output)) return [];

        return output
            .filter((row: any) => row.stck_bsop_date && Number(row.stck_clpr) > 0)
            .map((row: any) => ({
                date: row.stck_bsop_date,
                open: parseFloat(row.stck_oprc),
                high: parseFloat(row.stck_hgpr),
                low: parseFloat(row.stck_lwpr),
                close: parseFloat(row.stck_clpr),
                volume: parseInt(row.acml_vol, 10),
                trading_value: parseFloat(row.acml_tr_pbmn),
            }));
    } catch (error: any) {
        console.error(`[API Error] ${stockCode}:`, error.message);
        return [];
    }
};

// ─── DB 처리 및 유틸 ──────────────────────────────────────────

export const getLastSavedDate = async (stockId: number): Promise<string | null> => {
    const rows = await sequelize.query<{ last_date: string | null }>(
        `SELECT MAX(price_date) AS last_date FROM stock_prices WHERE stock_id = :stockId`,
        { replacements: { stockId }, type: QueryTypes.SELECT }
    );
    return rows[0]?.last_date ? rows[0].last_date.replace(/-/g, '') : null;
};

export const upsertStockPrices = async (stockId: number, prices: DailyPrice[]): Promise<void> => {
    if (prices.length === 0) return;
    const values = prices.map(p => {
        const d = p.date;
        return `(${stockId}, ${p.open}, ${p.high}, ${p.low}, ${p.close}, ${p.volume}, ${p.trading_value}, '${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}')`;
    }).join(',');

    await sequelize.query(
        `INSERT INTO stock_prices (stock_id, open, high, low, close, volume, trading_value, price_date)
         VALUES ${values} ON DUPLICATE KEY UPDATE open=VALUES(open), high=VALUES(high), low=VALUES(low), close=VALUES(close), volume=VALUES(volume), trading_value=VALUES(trading_value)`,
        { type: QueryTypes.INSERT }
    );
};

export const getActiveStocks = async () => {
    return sequelize.query<{id: number, code: string}>(
        `SELECT id, code FROM stocks WHERE is_active = 1 AND market IN ('KOSPI','KOSDAQ')`,
        { type: QueryTypes.SELECT }
    );
};

export const getToday = (): string => {
    const d = new Date();
    return d.getFullYear() + (d.getMonth() + 1).toString().padStart(2, '0') + d.getDate().toString().padStart(2, '0');
};