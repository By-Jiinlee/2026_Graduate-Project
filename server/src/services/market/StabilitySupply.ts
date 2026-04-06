import { QueryTypes } from 'sequelize'
import sequelize from '../../config/database'

// ─── 수급 데이터 조회 ─────────────────────────────────────────

interface SupplyData {
    frgn_net_buy_qty: number | null   // 외국인 순매수량 합계 (20일)
    inst_net_buy_qty: number | null   // 기관 순매수량 합계 (20일)
    short_volume_ratio: number | null // 평균 공매도 비율 (20일)
}

const getSupplyData = async (stockId: number, calcDate: string): Promise<SupplyData> => {
    // 외국인/기관 최근 20일 순매수 합계
    const fiRows = await sequelize.query<{
        frgn_net_buy_qty: number | null
        inst_net_buy_qty: number | null
    }>(
        `SELECT
       SUM(frgn_net_buy_qty) AS frgn_net_buy_qty,
       SUM(inst_net_buy_qty) AS inst_net_buy_qty
     FROM foreign_and_institutional
     WHERE stock_id = :stockId
       AND trade_date <= :calcDate
       AND trade_date >= DATE_SUB(:calcDate, INTERVAL 20 DAY)`,
        { replacements: { stockId, calcDate }, type: QueryTypes.SELECT }
    )

    // 공매도 최근 20일 평균 비율
    const ssRows = await sequelize.query<{ short_volume_ratio: number | null }>(
        `SELECT AVG(short_volume_ratio) AS short_volume_ratio
     FROM short_selling
     WHERE stock_id = :stockId
       AND trade_date <= :calcDate
       AND trade_date >= DATE_SUB(:calcDate, INTERVAL 20 DAY)`,
        { replacements: { stockId, calcDate }, type: QueryTypes.SELECT }
    )

    return {
        frgn_net_buy_qty: fiRows[0]?.frgn_net_buy_qty ?? null,
        inst_net_buy_qty: fiRows[0]?.inst_net_buy_qty ?? null,
        short_volume_ratio: ssRows[0]?.short_volume_ratio ?? null,
    }
}

// ─── 점수 계산 ────────────────────────────────────────────────

// 외국인 순매수 점수 (10점)
const calcForeignScore = (frgnNetBuyQty: number | null): number => {
    if (frgnNetBuyQty === null) return 0
    if (frgnNetBuyQty > 0) return 10
    if (frgnNetBuyQty === 0) return 5
    return 0
}

// 기관 순매수 점수 (10점)
const calcInstitutionScore = (instNetBuyQty: number | null): number => {
    if (instNetBuyQty === null) return 0
    if (instNetBuyQty > 0) return 10
    if (instNetBuyQty === 0) return 5
    return 0
}

// 공매도 비율 점수 (10점)
const calcShortSellingScore = (shortVolumeRatio: number | null): number => {
    if (shortVolumeRatio === null) return 0
    if (shortVolumeRatio < 1) return 10
    if (shortVolumeRatio <= 3) return 5
    return 0
}

// ─── 수급 안정성 총점 계산 ────────────────────────────────────

export interface SupplyScoreResult {
    foreign_score: number
    institution_score: number
    short_selling_score: number
    supply_score: number  // 총점 (30점 만점)
}

export const calcSupplyScore = async (
    stockId: number,
    calcDate: string
): Promise<SupplyScoreResult> => {
    const data = await getSupplyData(stockId, calcDate)

    const foreign_score       = calcForeignScore(data.frgn_net_buy_qty)
    const institution_score   = calcInstitutionScore(data.inst_net_buy_qty)
    const short_selling_score = calcShortSellingScore(data.short_volume_ratio)

    const supply_score = foreign_score + institution_score + short_selling_score

    return {
        foreign_score,
        institution_score,
        short_selling_score,
        supply_score,
    }
}