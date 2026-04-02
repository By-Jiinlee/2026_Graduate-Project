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

export const fetchForeignAndInstitutional = async (
    stockCode: string,
    startDate: string,
): Promise<any[]> => {
    const token = await getKisAccessToken()
    console.log(`[ForeignAndInstitutional] API 호출 - ${stockCode}`)

    const res = await axios.get(
        `${BASE_URL}/uapi/domestic-stock/v1/quotations/investor-trade-by-stock-daily`,
        {
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${token}`,
                appkey: APP_KEY,
                appsecret: APP_SECRET,
                tr_id: 'FHPTJ04160001',
            },
            params: {
                FID_COND_MRKT_DIV_CODE: 'J',
                FID_INPUT_ISCD: stockCode,
                FID_INPUT_DATE_1: getToday(),
                FID_ORG_ADJ_PRC: '',
                FID_ETC_CLS_CODE: '1',
            },
        }
    )
    console.log(`[ForeignAndInstitutional] API 완료 - ${stockCode}`)

    const output = res.data?.output2
    if (!Array.isArray(output)) return []

    // startDate 이후 데이터만 필터링
    return output.filter((row: any) =>
        row.stck_bsop_date && row.stck_bsop_date >= startDate
    )
}

// ─── DB ───────────────────────────────────────────────────────

export const getLastSavedDate = async (stockId: number): Promise<string | null> => {
    const rows = await sequelize.query<{ last_date: string | null }>(
        `SELECT DATE_FORMAT(MAX(trade_date), '%Y%m%d') AS last_date 
     FROM foreign_and_institutional WHERE stock_id = :stockId`,
        { replacements: { stockId }, type: QueryTypes.SELECT }
    )
    return rows[0]?.last_date ?? null  // 'YYYYMMDD' or null
}

export const upsertForeignAndInstitutional = async (
    stockId: number,
    rows: any[]
): Promise<void> => {
    if (rows.length === 0) return

    const placeholders = rows.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?)').join(',')
    const flat = rows.flatMap((row) => [
        stockId,
        `${row.stck_bsop_date.slice(0, 4)}-${row.stck_bsop_date.slice(4, 6)}-${row.stck_bsop_date.slice(6, 8)}`,
        parseInt(row.orgn_ntby_qty) || null,
        parseFloat(row.orgn_ntby_tr_pbmn) || null,
        parseInt(row.frgn_ntby_qty) || null,
        parseFloat(row.frgn_ntby_tr_pbmn) || null,
        parseInt(row.prsn_ntby_qty) || null,
        parseFloat(row.prsn_ntby_tr_pbmn) || null,
        parseInt(row.scrt_ntby_qty) || null,
        parseFloat(row.scrt_ntby_tr_pbmn) || null,
        parseInt(row.pe_fund_ntby_vol) || null,
        parseFloat(row.pe_fund_ntby_tr_pbmn) || null,
    ])

    await sequelize.query(
        `INSERT INTO foreign_and_institutional
       (stock_id, trade_date, inst_net_buy_qty, inst_net_buy_amount,
        frgn_net_buy_qty, frgn_net_buy_amount, prsn_net_buy_qty, prsn_net_buy_amount,
        fint_net_buy_qty, fint_net_buy_amount, pension_net_buy_qty, pension_net_buy_amount)
     VALUES ${placeholders}
     ON DUPLICATE KEY UPDATE
       inst_net_buy_qty       = VALUES(inst_net_buy_qty),
       inst_net_buy_amount    = VALUES(inst_net_buy_amount),
       frgn_net_buy_qty       = VALUES(frgn_net_buy_qty),
       frgn_net_buy_amount    = VALUES(frgn_net_buy_amount),
       prsn_net_buy_qty       = VALUES(prsn_net_buy_qty),
       prsn_net_buy_amount    = VALUES(prsn_net_buy_amount),
       fint_net_buy_qty       = VALUES(fint_net_buy_qty),
       fint_net_buy_amount    = VALUES(fint_net_buy_amount),
       pension_net_buy_qty    = VALUES(pension_net_buy_qty),
       pension_net_buy_amount = VALUES(pension_net_buy_amount)`,
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