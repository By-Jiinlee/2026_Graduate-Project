import axios from 'axios'
import { QueryTypes } from 'sequelize'
import sequelize from '../../config/database'

const ECOS_API_KEY = process.env.ECOS_API_KEY!
const ECOS_BASE_URL = 'https://ecos.bok.or.kr/api/StatisticSearch'

// ─── 타입 ─────────────────────────────────────────────────────

interface EcosItem {
    indicator: string
    time_period: string
    cycle: 'D' | 'M' | 'Q'
    value: number | null
}

interface IndicatorConfig {
    indicator: string   // 저장할 지표명
    statCode: string    // ECOS 통계표 코드
    itemCode1: string   // ECOS 항목 코드
    cycle: 'D' | 'M' | 'Q'
}

// ─── 지표 설정 ────────────────────────────────────────────────

export const DAILY_INDICATORS: IndicatorConfig[] = [
    { indicator: 'usd_krw', statCode: '731Y001', itemCode1: '0000001', cycle: 'D' },
    { indicator: 'jpy_krw', statCode: '731Y001', itemCode1: '0000002', cycle: 'D' },
    { indicator: 'eur_krw', statCode: '731Y001', itemCode1: '0000003', cycle: 'D' },
    { indicator: 'cny_krw', statCode: '731Y001', itemCode1: '0000004', cycle: 'D' },
]

export const MONTHLY_INDICATORS: IndicatorConfig[] = [
    { indicator: 'base_rate',       statCode: '722Y001', itemCode1: '0101000', cycle: 'M' },
    { indicator: 'cpi',             statCode: '901Y009', itemCode1: '0',       cycle: 'M' },
    { indicator: 'unemployment',    statCode: '901Y027', itemCode1: '1',       cycle: 'M' },
    { indicator: 'm2',              statCode: '101Y002', itemCode1: 'BBHA00',  cycle: 'M' },
    { indicator: 'current_account', statCode: '301Y013', itemCode1: '10000',   cycle: 'M' },
]

export const QUARTERLY_INDICATORS: IndicatorConfig[] = [
    { indicator: 'gdp',        statCode: '200Y001', itemCode1: '10101', cycle: 'Q' },
    { indicator: 'gdp_growth', statCode: '200Y001', itemCode1: '10102', cycle: 'Q' },
]

// ─── ECOS API 호출 ────────────────────────────────────────────

export const fetchEcosData = async (
    config: IndicatorConfig,
    startPeriod: string,
    endPeriod: string
): Promise<EcosItem[]> => {
    const url = [
        ECOS_BASE_URL,
        ECOS_API_KEY,
        'json',
        'kr',
        '1',
        '1000',
        config.statCode,
        config.cycle,
        startPeriod,
        endPeriod,
        config.itemCode1,
    ].join('/')

    const res = await axios.get(url)
    const rows = res.data?.StatisticSearch?.row
    if (!Array.isArray(rows)) return []

    return rows.map((row: any) => ({
        indicator: config.indicator,
        time_period: row.TIME,
        cycle: config.cycle,
        value: row.DATA_VALUE ? parseFloat(row.DATA_VALUE) : null,
    }))
}

// ─── DB upsert ────────────────────────────────────────────────

export const upsertEcosIndicators = async (items: EcosItem[]): Promise<void> => {
    if (items.length === 0) return

    const placeholders = items.map(() => '(?,?,?,?)').join(',')
    const flat = items.flatMap((i) => [i.indicator, i.time_period, i.cycle, i.value])

    await sequelize.query(
        `INSERT INTO ecos_indicators (indicator, time_period, cycle, value)
     VALUES ${placeholders}
     ON DUPLICATE KEY UPDATE value = VALUES(value)`,
        { replacements: flat, type: QueryTypes.INSERT }
    )
}

// ─── 날짜 유틸 ────────────────────────────────────────────────

export const getDateRange = (cycle: 'D' | 'M' | 'Q', monthsBack: number = 3) => {
    const now = new Date()

    if (cycle === 'D') {
        const start = new Date(now)
        start.setMonth(start.getMonth() - monthsBack)
        const fmt = (d: Date) =>
            `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
        return { startPeriod: fmt(start), endPeriod: fmt(now) }
    }

    if (cycle === 'M') {
        const start = new Date(now)
        start.setMonth(start.getMonth() - monthsBack)
        const fmt = (d: Date) =>
            `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`
        return { startPeriod: fmt(start), endPeriod: fmt(now) }
    }

    // Q
    const startYear = now.getFullYear() - 2
    return { startPeriod: `${startYear}Q1`, endPeriod: `${now.getFullYear()}Q4` }
}