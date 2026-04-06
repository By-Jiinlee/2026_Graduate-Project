import { QueryTypes } from 'sequelize'
import sequelize from '../../config/database'
import { calcFinancialScore, getLatestFiscalYearEnd } from './StabilityFinancial'
import { calcSupplyScore } from './StabilitySupply'
import { calcTechnicalScore } from './StabilityTechnical'

// ─── 타입 ─────────────────────────────────────────────────────

interface Stock {
    id: number
    code: string
}

// ─── DB ───────────────────────────────────────────────────────

export const getActiveStocks = async (): Promise<Stock[]> => {
    return sequelize.query<Stock>(
        `SELECT id, code FROM stocks WHERE is_active = 1 AND market IN ('KOSPI','KOSDAQ')`,
        { type: QueryTypes.SELECT }
    )
}

export const getLastSavedDate = async (): Promise<string | null> => {
    const rows = await sequelize.query<{ last_date: string | null }>(
        `SELECT DATE_FORMAT(MAX(calc_date), '%Y-%m-%d') AS last_date FROM stock_stability`,
        { type: QueryTypes.SELECT }
    )
    return rows[0]?.last_date ?? null
}

export const upsertStability = async (
    stockId: number,
    calcDate: string,
    scores: {
        financial_score: number
        debt_ratio_score: number
        current_ratio_score: number
        roe_score: number
        operating_margin_score: number
        cash_flow_score: number
        supply_score: number
        foreign_score: number
        institution_score: number
        short_selling_score: number
        technical_score: number
        week52_score: number
        volume_score: number
        volatility_score: number
        vix_score: number
        total_score: number
    }
): Promise<void> => {
    await sequelize.query(
        `INSERT INTO stock_stability
       (stock_id, calc_date, financial_score, debt_ratio_score, current_ratio_score,
        roe_score, operating_margin_score, cash_flow_score, supply_score, foreign_score,
        institution_score, short_selling_score, technical_score, week52_score,
        volume_score, volatility_score, vix_score, total_score)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       financial_score        = VALUES(financial_score),
       debt_ratio_score       = VALUES(debt_ratio_score),
       current_ratio_score    = VALUES(current_ratio_score),
       roe_score              = VALUES(roe_score),
       operating_margin_score = VALUES(operating_margin_score),
       cash_flow_score        = VALUES(cash_flow_score),
       supply_score           = VALUES(supply_score),
       foreign_score          = VALUES(foreign_score),
       institution_score      = VALUES(institution_score),
       short_selling_score    = VALUES(short_selling_score),
       technical_score        = VALUES(technical_score),
       week52_score           = VALUES(week52_score),
       volume_score           = VALUES(volume_score),
       volatility_score       = VALUES(volatility_score),
       vix_score              = VALUES(vix_score),
       total_score            = VALUES(total_score)`,
        {
            replacements: [
                stockId, calcDate,
                scores.financial_score, scores.debt_ratio_score, scores.current_ratio_score,
                scores.roe_score, scores.operating_margin_score, scores.cash_flow_score,
                scores.supply_score, scores.foreign_score, scores.institution_score,
                scores.short_selling_score, scores.technical_score, scores.week52_score,
                scores.volume_score, scores.volatility_score, scores.vix_score,
                scores.total_score,
            ],
            type: QueryTypes.INSERT,
        }
    )
}

// ─── 안정성 계산 ──────────────────────────────────────────────

export const calcStability = async (stockId: number, stockCode: string, calcDate: string): Promise<void> => {
    // 재무 안정성 - 최근 결산일 기준
    const fiscalYearEnd = await getLatestFiscalYearEnd(stockCode)
    if (!fiscalYearEnd) return

    const [financial, supply, technical] = await Promise.all([
        calcFinancialScore(stockCode, fiscalYearEnd),
        calcSupplyScore(stockId, calcDate),
        calcTechnicalScore(stockId, stockCode, calcDate),
    ])

    const total_score = financial.financial_score + supply.supply_score + technical.technical_score

    await upsertStability(stockId, calcDate, {
        financial_score:        financial.financial_score,
        debt_ratio_score:       financial.debt_ratio_score,
        current_ratio_score:    financial.current_ratio_score,
        roe_score:              financial.roe_score,
        operating_margin_score: financial.operating_margin_score,
        cash_flow_score:        financial.cash_flow_score,
        supply_score:           supply.supply_score,
        foreign_score:          supply.foreign_score,
        institution_score:      supply.institution_score,
        short_selling_score:    supply.short_selling_score,
        technical_score:        technical.technical_score,
        week52_score:           technical.week52_score,
        volume_score:           technical.volume_score,
        volatility_score:       technical.volatility_score,
        vix_score:              technical.vix_score,
        total_score,
    })
}

// ─── 날짜 유틸 ────────────────────────────────────────────────

export const getToday = (): string =>
    new Date().toISOString().slice(0, 10)

export const dayAfter = (dateStr: string): string => {
    const d = new Date(dateStr)
    d.setDate(d.getDate() + 1)
    return d.toISOString().slice(0, 10)
}