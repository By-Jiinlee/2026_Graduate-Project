import { QueryTypes } from 'sequelize'
import sequelize from '../../config/database'

// ─── 재무 데이터 조회 ─────────────────────────────────────────

interface FinancialData {
    stock_code: string
    current_assets: number | null      // 유동자산
    current_liabilities: number | null // 유동부채
    total_liabilities: number | null   // 부채총계
    total_equity: number | null        // 자본총계
    revenue: number | null             // 매출액
    operating_income: number | null    // 영업이익
    net_income: number | null          // 당기순이익
    operating_cash_flow: number | null // 영업활동 현금흐름
}

const getItemValue = async (
    stockCode: string,
    statementType: string,
    itemCodes: string[],
    fiscalYearEnd: string
): Promise<number | null> => {
    const placeholders = itemCodes.map(() => '?').join(',')
    const rows = await sequelize.query<{ value: number | null }>(
        `SELECT current_period AS value
         FROM financial_statements
         WHERE stock_code = ?
           AND statement_type = ?
           AND item_code IN (${placeholders})
           AND fiscal_year_end = ?
           AND current_period IS NOT NULL
         ORDER BY id DESC LIMIT 1`,
        {
            replacements: [stockCode, statementType, ...itemCodes, fiscalYearEnd],
            type: QueryTypes.SELECT,
        }
    )
    return rows[0]?.value ?? null
}

export const getFinancialData = async (
    stockCode: string,
    fiscalYearEnd: string
): Promise<FinancialData> => {
    const [
        current_assets,
        current_liabilities,
        total_liabilities,
        total_equity,
        revenue,
        operating_income,
        net_income,
        operating_cash_flow,
    ] = await Promise.all([
        getItemValue(stockCode, 'BS', ['ifrs_CurrentAssets', 'ifrs-full_CurrentAssets'], fiscalYearEnd),
        getItemValue(stockCode, 'BS', ['ifrs_CurrentLiabilities', 'ifrs-full_CurrentLiabilities'], fiscalYearEnd),
        getItemValue(stockCode, 'BS', ['ifrs_Liabilities', 'ifrs-full_Liabilities'], fiscalYearEnd),
        getItemValue(stockCode, 'BS', ['ifrs_Equity', 'ifrs-full_Equity'], fiscalYearEnd),
        getItemValue(stockCode, 'IS', ['ifrs_Revenue', 'ifrs-full_Revenue', 'ifrs-full_GrossProfit'], fiscalYearEnd),
        getItemValue(stockCode, 'IS', ['dart_OperatingIncomeLoss'], fiscalYearEnd),
        getItemValue(stockCode, 'IS', ['ifrs_ProfitLoss', 'ifrs-full_ProfitLoss'], fiscalYearEnd),
        getItemValue(stockCode, 'CF', ['ifrs_CashFlowsFromUsedInOperatingActivities'], fiscalYearEnd),
    ])

    return {
        stock_code: stockCode,
        current_assets,
        current_liabilities,
        total_liabilities,
        total_equity,
        revenue,
        operating_income,
        net_income,
        operating_cash_flow,
    }
}

// ─── 점수 계산 ────────────────────────────────────────────────

// 부채비율 점수 (8점)
const calcDebtRatioScore = (liabilities: number | null, equity: number | null): number => {
    if (!liabilities || !equity || equity === 0) return 0
    const ratio = (liabilities / equity) * 100
    if (ratio <= 100) return 8
    if (ratio <= 200) return 4
    return 0
}

// 유동비율 점수 (8점)
const calcCurrentRatioScore = (currentAssets: number | null, currentLiabilities: number | null): number => {
    if (!currentAssets || !currentLiabilities || currentLiabilities === 0) return 0
    const ratio = (currentAssets / currentLiabilities) * 100
    if (ratio >= 200) return 8
    if (ratio >= 100) return 4
    return 0
}

// ROE 점수 (5점)
const calcROEScore = (netIncome: number | null, equity: number | null): number => {
    if (!netIncome || !equity || equity === 0) return 0
    const roe = (netIncome / equity) * 100
    if (roe >= 15) return 5
    if (roe >= 5) return 3
    return 0
}

// 영업이익률 점수 (5점)
const calcOperatingMarginScore = (operatingIncome: number | null, revenue: number | null): number => {
    if (!operatingIncome || !revenue || revenue === 0) return 0
    const margin = (operatingIncome / revenue) * 100
    if (margin >= 15) return 5
    if (margin >= 5) return 3
    return 0
}

// 영업활동 현금흐름 점수 (4점)
const calcCashFlowScore = (operatingCashFlow: number | null): number => {
    if (operatingCashFlow === null) return 0
    if (operatingCashFlow > 0) return 4
    if (operatingCashFlow === 0) return 2
    return 0
}

// ─── 재무 안정성 총점 계산 ────────────────────────────────────

export interface FinancialScoreResult {
    stock_code: string
    debt_ratio_score: number
    current_ratio_score: number
    roe_score: number
    operating_margin_score: number
    cash_flow_score: number
    financial_score: number  // 총점 (30점 만점)
}

export const calcFinancialScore = async (
    stockCode: string,
    fiscalYearEnd: string
): Promise<FinancialScoreResult> => {
    const data = await getFinancialData(stockCode, fiscalYearEnd)

    const debt_ratio_score      = calcDebtRatioScore(data.total_liabilities, data.total_equity)
    const current_ratio_score   = calcCurrentRatioScore(data.current_assets, data.current_liabilities)
    const roe_score             = calcROEScore(data.net_income, data.total_equity)
    const operating_margin_score = calcOperatingMarginScore(data.operating_income, data.revenue)
    const cash_flow_score       = calcCashFlowScore(data.operating_cash_flow)

    const financial_score = debt_ratio_score + current_ratio_score + roe_score + operating_margin_score + cash_flow_score

    return {
        stock_code: stockCode,
        debt_ratio_score,
        current_ratio_score,
        roe_score,
        operating_margin_score,
        cash_flow_score,
        financial_score,
    }
}

// ─── 최근 결산일 조회 ─────────────────────────────────────────

export const getLatestFiscalYearEnd = async (stockCode: string): Promise<string | null> => {
    const rows = await sequelize.query<{ fiscal_year_end: string | null }>(
        `SELECT MAX(fiscal_year_end) AS fiscal_year_end
     FROM financial_statements
     WHERE stock_code = :stockCode`,
        { replacements: { stockCode }, type: QueryTypes.SELECT }
    )
    return rows[0]?.fiscal_year_end ?? null
}