import axios from 'axios'
import { QueryTypes } from 'sequelize'
import sequelize from '../../../../../../Downloads/2026_Graduate-Project-main - 복사본/2026_Graduate-Project-main - 복사본/server/src/config/database'
import { getKisAccessToken } from './KisAuth'

const APP_KEY = process.env.KIS_REAL_APP_KEY!
const APP_SECRET = process.env.KIS_REAL_APP_SECRET!
const BASE_URL = 'https://openapi.koreainvestment.com:9443'

// ─── 타입 ─────────────────────────────────────────────────────

interface Stock {
    id: number
    code: string
}

// ─── KIS API ──────────────────────────────────────────────────

export const fetchShortSelling = async (
    stockCode: string,
    startDate: string,
    endDate: string
): Promise<any[]> => {
    const token = await getKisAccessToken()
    console.log(`[ShortSelling] API 호출 - ${stockCode}`)

    const res = await axios.get(
        `${BASE_URL}/uapi/domestic-stock/v1/quotations/daily-short-sale`,
        {
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${token}`,
                appkey: APP_KEY,
                appsecret: APP_SECRET,
                tr_id: 'FHPST04830000',
            },
            params: {
                FID_COND_MRKT_DIV_CODE: 'J',
                FID_INPUT_ISCD: stockCode,
                FID_INPUT_DATE_1: startDate,
                FID_INPUT_DATE_2: endDate,
            },
        }
    )

    console.log(`[ShortSelling] API 완료 - ${stockCode}`)
    const output = res.data?.output
    if (!Array.isArray(output)) return []
    return output.filter((row: any) => row.stck_bsop_date)
}

// ─── DB ───────────────────────────────────────────────────────

export const getLastSavedDate = async (stockId: number): Promise<string | null> => {
    const rows = await sequelize.query<{ last_date: string | null }>(
        `SELECT DATE_FORMAT(MAX(trade_date), '%Y%m%d') AS last_date
         FROM short_selling WHERE stock_id = :stockId`,
        { replacements: { stockId }, type: QueryTypes.SELECT }
    )
    return rows[0]?.last_date ?? null  // 'YYYYMMDD' or null
}

export const upsertShortSelling = async (
    stockId: number,
    rows: any[]
): Promise<void> => {
    if (rows.length === 0) return

    const placeholders = rows.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')
    const flat = rows.flatMap((row) => [
        stockId,
        `${row.stck_bsop_date.slice(0, 4)}-${row.stck_bsop_date.slice(4, 6)}-${row.stck_bsop_date.slice(6, 8)}`,
        parseInt(row.smtn_slng_qty) || null,
        parseFloat(row.smtn_slng_amt) || null,
        parseInt(row.acml_vol) || null,
        parseFloat(row.acml_tr_pbmn) || null,
        parseFloat(row.slng_qty_rt) || null,
        parseFloat(row.slng_amt_rt) || null,
        parseInt(row.smtn_bs_qty) || null,
        parseFloat(row.smtn_bs_amt) || null,
        parseInt(row.lstg_stqt) || null,
        parseFloat(row.bs_qty_rt) || null,
    ])

    await sequelize.query(
        `INSERT INTO short_selling
         (stock_id, trade_date, short_volume, short_amount, total_volume, total_amount,
          short_volume_ratio, short_amount_ratio, short_balance_qty, short_balance_amount,
          listed_shares, short_balance_ratio)
         VALUES ${placeholders}
             ON DUPLICATE KEY UPDATE
                                  short_volume         = VALUES(short_volume),
                                  short_amount         = VALUES(short_amount),
                                  total_volume         = VALUES(total_volume),
                                  total_amount         = VALUES(total_amount),
                                  short_volume_ratio   = VALUES(short_volume_ratio),
                                  short_amount_ratio   = VALUES(short_amount_ratio),
                                  short_balance_qty    = VALUES(short_balance_qty),
                                  short_balance_amount = VALUES(short_balance_amount),
                                  listed_shares        = VALUES(listed_shares),
                                  short_balance_ratio  = VALUES(short_balance_ratio)`,
        { replacements: flat, type: QueryTypes.INSERT }
    )
}

export const getActiveStocks = async (): Promise<Stock[]> => {
    return sequelize.query<Stock>(
        `SELECT id, code FROM stocks WHERE is_active = 1 AND market IN ('KOSPI','KOSDAQ')`,
        { type: QueryTypes.SELECT }
    )
}

// ─── 날짜 유틸 ────────────────────────────────────────────────

export const toKisDate = (date: Date): string =>
    date.toISOString().slice(0, 10).replace(/-/g, '')

export const dayAfter = (dateStr: string): string => {
    const normalized = dateStr.length === 8
        ? `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`
        : dateStr
    const d = new Date(normalized)
    d.setDate(d.getDate() + 1)
    return toKisDate(d)
}

export const getToday = (): string => toKisDate(new Date())