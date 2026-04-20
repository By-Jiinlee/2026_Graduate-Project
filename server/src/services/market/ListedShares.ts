import axios from 'axios'
import { QueryTypes } from 'sequelize'
import sequelize from '../../config/database'
import { getKisAccessToken } from './KisAuth'

const APP_KEY = process.env.KIS_REAL_APP_KEY!
const APP_SECRET = process.env.KIS_REAL_APP_SECRET!
const BASE_URL = 'https://openapi.koreainvestment.com:9443'

// ─── 타입 ─────────────────────────────────────────────────────

interface Stock {
    id: number
    code: string
    updated_at: string | null
}

// ─── KIS API ──────────────────────────────────────────────────

export const fetchListedShares = async (stockCode: string): Promise<number | null> => {
    const token = await getKisAccessToken()

    const res = await axios.get(
        `${BASE_URL}/uapi/domestic-stock/v1/quotations/search-stock-info`,
        {
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${token}`,
                appkey: APP_KEY,
                appsecret: APP_SECRET,
                tr_id: 'CTPF1002R',
            },
            params: {
                PRDT_TYPE_CD: '300',
                PDNO: stockCode,
            },
        }
    )

    const lstg_stqt = res.data?.output?.lstg_stqt
    if (!lstg_stqt) return null
    return parseInt(lstg_stqt.replace(/,/g, ''), 10) || null
}

// ─── DB ───────────────────────────────────────────────────────

export const updateListedShares = async (stockId: number, listedShares: number): Promise<void> => {
    await sequelize.query(
        `UPDATE stocks SET listed_shares = :listedShares, updated_at = NOW() WHERE id = :stockId`,
        { replacements: { listedShares, stockId }, type: QueryTypes.UPDATE }
    )
}

export const getActiveStocks = async (): Promise<Stock[]> => {
    return sequelize.query<Stock>(
        `SELECT id, code, updated_at FROM stocks
         WHERE is_active = 1 AND market IN ('KOSPI','KOSDAQ')`,
        { type: QueryTypes.SELECT }
    )
}