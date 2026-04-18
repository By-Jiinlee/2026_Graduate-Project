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
    indicator: string
    statCode: string
    itemCode1: string
    cycle: 'D' | 'M' | 'Q'
}

// ─── 지표 설정 ────────────────────────────────────────────────

export const DAILY_INDICATORS: IndicatorConfig[] = [
    { indicator: 'base_rate',   statCode: '722Y001', itemCode1: '0101000',   cycle: 'D' },
    { indicator: 'treasury_3y', statCode: '817Y002', itemCode1: '010200000', cycle: 'D' },
    { indicator: 'usd_krw',     statCode: '731Y001', itemCode1: '0000001',   cycle: 'D' },
    { indicator: 'jpy_krw',     statCode: '731Y001', itemCode1: '0000002',   cycle: 'D' },
    { indicator: 'kospi',       statCode: '802Y001', itemCode1: '0001000',   cycle: 'D' },
    { indicator: 'kosdaq',      statCode: '802Y001', itemCode1: '0089000',   cycle: 'D' },
]

export const MONTHLY_INDICATORS: IndicatorConfig[] = [
    { indicator: 'cpi',                  statCode: '901Y009', itemCode1: '0',      cycle: 'M' },
    { indicator: 'm2',                   statCode: '161Y008', itemCode1: 'BBGA00', cycle: 'M' },
    { indicator: 'current_account',      statCode: '301Y013', itemCode1: '000000', cycle: 'M' },
    { indicator: 'unemployment_rate',    statCode: '901Y027', itemCode1: 'I61BC',  cycle: 'M' },
    { indicator: 'industrial_production',statCode: '901Y033', itemCode1: 'A00',    cycle: 'M' },
]

export const QUARTERLY_INDICATORS: IndicatorConfig[] = [
    { indicator: 'gdp', statCode: '200Y106', itemCode1: '1400', cycle: 'Q' },
]

// ─── DB 마지막 저장일 조회 ────────────────────────────────────

export const getLastPeriod = async (indicator: string): Promise<string | null> => {
    const rows = await sequelize.query<{ last_period: string | null }>(
        `SELECT MAX(time_period) AS last_period FROM ecos_indicators WHERE indicator = :indicator`,
        { replacements: { indicator }, type: QueryTypes.SELECT }
    )
    return rows[0]?.last_period ?? null
}

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
        '100000',
        config.statCode,
        config.cycle,
        startPeriod,
        endPeriod,
        config.itemCode1,
    ].join('/')

    const res = await axios.get(url)

    if (res.data?.RESULT?.CODE === 'INFO-200') {
        console.warn(`[EcosIndicator] ${config.indicator} 데이터 없음: ${startPeriod} ~ ${endPeriod}`)
        return []
    }

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

// 마지막 저장일 기준으로 시작일 계산
export const getStartPeriod = (lastPeriod: string | null, cycle: 'D' | 'M' | 'Q'): string => {
    const now = new Date()

    if (!lastPeriod) {
        // 처음 수집: 10년치
        const start = new Date(now)
        start.setFullYear(start.getFullYear() - 10)

        if (cycle === 'D') {
            return `${start.getFullYear()}${String(start.getMonth() + 1).padStart(2, '0')}${String(start.getDate()).padStart(2, '0')}`
        }
        if (cycle === 'M') {
            return `${start.getFullYear()}${String(start.getMonth() + 1).padStart(2, '0')}`
        }
        return `${start.getFullYear()}Q1`
    }

    // 마지막 저장일 다음날부터
    if (cycle === 'D') {
        const d = new Date(`${lastPeriod.slice(0, 4)}-${lastPeriod.slice(4, 6)}-${lastPeriod.slice(6, 8)}`)
        d.setDate(d.getDate() + 1)
        return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
    }
    if (cycle === 'M') {
        const d = new Date(`${lastPeriod.slice(0, 4)}-${lastPeriod.slice(4, 6)}-01`)
        d.setMonth(d.getMonth() + 1)
        return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`
    }
    // Q
    const year = parseInt(lastPeriod.slice(0, 4))
    const quarter = parseInt(lastPeriod.slice(5))
    if (quarter === 4) return `${year + 1}Q1`
    return `${year}Q${quarter + 1}`
}

export const getEndPeriod = (cycle: 'D' | 'M' | 'Q'): string => {
    const now = new Date()
    if (cycle === 'D') {
        return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
    }
    if (cycle === 'M') {
        return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
    }
    return `${now.getFullYear()}Q${Math.ceil((now.getMonth() + 1) / 3)}`
}