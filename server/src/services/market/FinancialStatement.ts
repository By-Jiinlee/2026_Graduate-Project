import axios from 'axios'
import AdmZip from 'adm-zip'
import { XMLParser } from 'fast-xml-parser'
import { QueryTypes } from 'sequelize'
import sequelize from '../../config/database'

const DART_API_KEY = process.env.DART_API_KEY!
const DART_BASE_URL = 'https://opendart.fss.or.kr/api'

// ─── 타입 ─────────────────────────────────────────────────────

interface CorpInfo {
    corp_code: string
    stock_code: string
    corp_name: string
}

interface DartFinancialItem {
    stock_code: string
    corp_name: string
    sj_div: string
    bsns_year: string
    reprt_code: string
    account_id: string
    account_nm: string
    thstrm_amount: string
    frmtrm_amount: string
    bfefrmtrm_amount: string
}

// ─── DART corp_code 매핑 ──────────────────────────────────────

export const syncCorpCodes = async (): Promise<void> => {
    console.log('[FinancialStatement] corp_code 동기화 시작')

    const res = await axios.get(`${DART_BASE_URL}/corpCode.xml`, {
        params: { crtfc_key: DART_API_KEY },
        responseType: 'arraybuffer',
    })

    const zip = new AdmZip(Buffer.from(res.data))
    const xmlEntry = zip.getEntry('CORPCODE.xml')
    if (!xmlEntry) throw new Error('CORPCODE.xml not found in ZIP')

    const xmlContent = xmlEntry.getData().toString('utf-8')
    const parser = new XMLParser()
    const parsed = parser.parse(xmlContent)

    const corps: CorpInfo[] = parsed?.result?.list ?? []
    const listed = corps.filter((c) => c.stock_code && String(c.stock_code).trim() !== '')

    for (const corp of listed) {
        await sequelize.query(
            `UPDATE stocks SET corp_code = :corp_code WHERE code = :stock_code`,
            {
                replacements: {
                    corp_code: String(corp.corp_code).trim(),
                    stock_code: String(corp.stock_code).trim(),
                },
                type: QueryTypes.UPDATE,
            }
        )
    }

    console.log(`[FinancialStatement] corp_code 동기화 완료 (${listed.length}개)`)
}

// ─── DART 재무제표 수집 ───────────────────────────────────────

const IMPORTANT_ITEMS = new Set([
    'ifrs_Assets', 'ifrs-full_Assets',
    'ifrs_Liabilities', 'ifrs-full_Liabilities',
    'ifrs_CurrentAssets', 'ifrs-full_CurrentAssets',
    'ifrs_CurrentLiabilities', 'ifrs-full_CurrentLiabilities',
    'ifrs_Equity', 'ifrs-full_Equity',
    'ifrs_NoncurrentAssets', 'ifrs-full_NoncurrentAssets',
    'ifrs_Inventories', 'ifrs-full_Inventories',
    'dart_OperatingIncomeLoss',
    'ifrs_FinanceCosts', 'ifrs-full_FinanceCosts',
    'ifrs_Revenue', 'ifrs-full_Revenue',
    'ifrs_GrossProfit', 'ifrs-full_GrossProfit',
    'ifrs_ProfitLoss', 'ifrs-full_ProfitLoss',
    'ifrs_ProfitLossBeforeTax', 'ifrs-full_ProfitLossBeforeTax',
    'ifrs_CostOfSales', 'ifrs-full_CostOfSales',
    'ifrs_CashFlowsFromUsedInOperatingActivities', 'ifrs-full_CashFlowsFromUsedInOperatingActivities',
    'ifrs_CashFlowsFromUsedInInvestingActivities', 'ifrs-full_CashFlowsFromUsedInInvestingActivities',
    'ifrs_CashFlowsFromUsedInFinancingActivities', 'ifrs-full_CashFlowsFromUsedInFinancingActivities',
])

const parseAmount = (value: string): string | null => {
    if (!value || value.trim() === '' || value.trim() === '-') return null
    return value.replace(/,/g, '').trim()
}

const toStatementType = (sj_div: string): 'BS' | 'IS' | 'CF' | null => {
    if (sj_div === 'BS') return 'BS'
    if (sj_div === 'IS') return 'IS'
    if (sj_div === 'CFS') return 'CF'
    return null
}

export const fetchFinancialStatements = async (
    corpCodes: string[],
    year: string,
    reprtCode: string = '11011'
): Promise<DartFinancialItem[]> => {
    const res = await axios.get(`${DART_BASE_URL}/fnlttMultiAcnt.json`, {
        params: {
            crtfc_key: DART_API_KEY,
            corp_code: corpCodes.join(','),
            bsns_year: year,
            reprt_code: reprtCode,
            fs_div: 'CFS',
        },
    })

    if (res.data?.status !== '000') return []

    return res.data?.list ?? []
}

export const upsertFinancialStatements = async (
    items: DartFinancialItem[]
): Promise<void> => {
    const filtered = items.filter(
        (item) =>
            IMPORTANT_ITEMS.has(item.account_id) &&
            !item.account_id.includes('Abstract') &&
            toStatementType(item.sj_div) !== null
    )

    if (filtered.length === 0) return

    const placeholders = filtered.map(() => '(?,?,?,?,?,?,?,?,?)').join(',')
    const flat = filtered.flatMap((item) => [
        item.stock_code,
        item.corp_name,
        toStatementType(item.sj_div),
        `${item.bsns_year}-12-31`,
        item.account_id,
        item.account_nm,
        parseAmount(item.thstrm_amount),
        parseAmount(item.frmtrm_amount),
        parseAmount(item.bfefrmtrm_amount),
    ])

    await sequelize.query(
        `INSERT INTO financial_statements
         (stock_code, company_name, statement_type, fiscal_year_end,
          item_code, item_name, current_period, prior_period, prior_prior_period)
         VALUES ${placeholders}
             ON DUPLICATE KEY UPDATE
                                  company_name       = VALUES(company_name),
                                  item_name          = VALUES(item_name),
                                  current_period     = VALUES(current_period),
                                  prior_period       = VALUES(prior_period),
                                  prior_prior_period = VALUES(prior_prior_period)`,
        { replacements: flat, type: QueryTypes.INSERT }
    )
}

export const getActiveCorpCodes = async (): Promise<
    { corp_code: string; stock_code: string }[]
> => {
    return sequelize.query<{ corp_code: string; stock_code: string }>(
        `SELECT corp_code, code AS stock_code FROM stocks
         WHERE is_active = 1 AND market IN ('KOSPI','KOSDAQ') AND corp_code IS NOT NULL`,
        { type: QueryTypes.SELECT }
    )
}