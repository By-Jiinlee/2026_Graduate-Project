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
}

// ─── KIS API ──────────────────────────────────────────────────

/**
 * KIS 가 rt_cd !== '0' 으로 돌려준 응답. 예전에는 이걸 빈 배열로 삼켜서
 * "정상 동작 중이지만 아무것도 안 들어오는" 상태를 만들었다(아래 TIME LIMIT 참고).
 */
export class KisApiError extends Error {
    constructor(
        readonly rtCd: string,
        readonly msgCd: string,
        readonly msg: string,
    ) {
        super(`KIS 오류 rt_cd=${rtCd} ${msgCd} ${msg}`)
    }
    /** 초당 거래건수 초과 — 대기 후 재시도하면 된다 */
    get isRateLimit(): boolean {
        return this.msgCd === 'EGW00201'
    }
    /**
     * 이 TR 은 당일치를 장 마감(15:40) 이후에만 준다. 그 전에 기준일을 '오늘'로 주면
     * rt_cd=2 "TIME LIMIT 00:00 ~ 15:40" 이 오고 데이터가 한 건도 없다.
     */
    get isTimeLimit(): boolean {
        return this.rtCd === '2' && /TIME LIMIT/i.test(this.msg)
    }
}

/**
 * 투자자별 매매동향 조회.
 *
 * 이 API 는 기준일(baseDate)로부터 과거 30거래일을 한 묶음으로 돌려준다. 예전 구현은
 * baseDate 자리에 항상 getToday() 를 넣고 응답을 startDate 로 걸러내기만 해서,
 * 30거래일보다 오래된 구간은 애초에 응답에 없어 영구히 메울 수 없었다.
 * 기준일을 과거로 넘기면 그 시점의 30거래일이 정상적으로 내려온다(확인 완료).
 *
 * @param baseDate 조회 기준일 'YYYYMMDD' — 이 날짜로부터 과거 30거래일이 온다
 * @param minDate  이 날짜 이전 행은 버린다(선택)
 */
export const fetchForeignAndInstitutional = async (
    stockCode: string,
    baseDate: string,
    minDate?: string,
): Promise<any[]> => {
    const token = await getKisAccessToken()

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
                FID_INPUT_DATE_1: baseDate,
                FID_ORG_ADJ_PRC: '',
                FID_ETC_CLS_CODE: '1',
            },
        }
    )

    // 실패를 빈 배열로 삼키지 않는다 — 호출자가 재시도·중단을 판단해야 한다
    const rtCd = String(res.data?.rt_cd ?? '')
    if (rtCd !== '0') {
        throw new KisApiError(rtCd, String(res.data?.msg_cd ?? ''), String(res.data?.msg1 ?? '').trim())
    }

    const output = res.data?.output2
    if (!Array.isArray(output)) return []

    return output.filter((row: any) =>
        row.stck_bsop_date && (!minDate || row.stck_bsop_date >= minDate)
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

/**
 * 전종목 마지막 저장일을 한 번에 조회한다(N+1 해소).
 * 예전에는 루프 안에서 종목마다 getLastSavedDate 를 불러 3,590회 왕복했다 —
 * DB 가 프록시 너머에 있어 그 왕복이 수집 시간의 상당 부분을 먹었다.
 */
export const getAllLastDates = async (): Promise<Map<number, string>> => {
    const rows = await sequelize.query<{ stock_id: number; last_date: string }>(
        `SELECT stock_id, DATE_FORMAT(MAX(trade_date), '%Y%m%d') AS last_date
           FROM foreign_and_institutional GROUP BY stock_id`,
        { type: QueryTypes.SELECT }
    )
    return new Map(rows.map((r) => [Number(r.stock_id), r.last_date]))
}

/** 거래일 캘린더 — stock_prices 를 기준으로 삼는다. 'YYYYMMDD' 오름차순 */
export const getTradingDays = async (from: string, to: string): Promise<string[]> => {
    const rows = await sequelize.query<{ d: string }>(
        `SELECT DISTINCT DATE_FORMAT(price_date, '%Y%m%d') AS d FROM stock_prices
          WHERE price_date BETWEEN :from AND :to ORDER BY d`,
        {
            replacements: {
                from: `${from.slice(0, 4)}-${from.slice(4, 6)}-${from.slice(6, 8)}`,
                to: `${to.slice(0, 4)}-${to.slice(4, 6)}-${to.slice(6, 8)}`,
            },
            type: QueryTypes.SELECT,
        }
    )
    return rows.map((r) => r.d)
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