import { useEffect, useRef, useState, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { createChart, CandlestickSeries, AreaSeries } from 'lightweight-charts'
import type { IChartApi, ISeriesApi, UTCTimestamp, Time } from 'lightweight-charts'
import { io, Socket } from 'socket.io-client'
import axios from 'axios'
import OrderPanel from '../components/trade/OrderPanel'
import { formatStockName } from '../utils/formatStockName'

interface StockInfo {
    id: number
    name: string
    code: string
    market: string
    type: string
    price: number
    change: number
    changeRate: number
    volume: number
}

interface CandleBar {
    time: string
    open: number
    high: number
    low: number
    close: number
    volume: number
}

type ChartMode = 'line' | 'candle'
type LinePeriod = '1d' | '1w' | '3m' | '1y' | '3y' | '5y' | '10y'
type CandleType = 'minute' | 'day' | 'week' | 'month'

const LINE_PERIODS: { key: LinePeriod; label: string; days: number }[] = [
    { key: '1d',  label: '1일',   days: 0    },
    { key: '1w',  label: '1주',   days: 7    },
    { key: '3m',  label: '3개월', days: 90   },
    { key: '1y',  label: '1년',   days: 365  },
    { key: '3y',  label: '3년',   days: 1095 },
    { key: '5y',  label: '5년',   days: 1825 },
    { key: '10y', label: '10년',  days: 3650 },
]

const CANDLE_TYPES: { key: CandleType; label: string }[] = [
    { key: 'minute', label: '분봉' },
    { key: 'day',    label: '일봉' },
    { key: 'week',   label: '주봉' },
    { key: 'month',  label: '월봉' },
]

// "YYYY-MM-DD" → UTCTimestamp (자정 UTC)
const dateToTs = (d: string): UTCTimestamp =>
    Math.floor(new Date(d + 'T00:00:00Z').getTime() / 1000) as UTCTimestamp

// "YYYY-MM-DD HH:mm:ss" KST → UTCTimestamp
// DB에 KST로 저장돼 있으므로 'Z' 붙여서 UTC로 취급 → 차트에서 KST 시간 그대로 표시
const datetimeToTs = (d: string): UTCTimestamp => {
    const iso = d.includes('T') ? d : d.replace(' ', 'T')
    return Math.floor(new Date(iso + 'Z').getTime() / 1000) as UTCTimestamp
}

function aggregateWeekly(candles: CandleBar[]): CandleBar[] {
    const weeks: Record<string, CandleBar[]> = {}
    for (const c of candles) {
        const d = new Date(c.time)
        const day = d.getDay()
        const diff = day === 0 ? -6 : 1 - day
        const monday = new Date(d)
        monday.setDate(d.getDate() + diff)
        const key = monday.toISOString().slice(0, 10)
        if (!weeks[key]) weeks[key] = []
        weeks[key].push(c)
    }
    return Object.entries(weeks)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([time, bars]) => ({
            time,
            open:   Number(bars[0].open),
            high:   Math.max(...bars.map(b => Number(b.high))),
            low:    Math.min(...bars.map(b => Number(b.low))),
            close:  Number(bars[bars.length - 1].close),
            volume: bars.reduce((s, b) => s + Number(b.volume), 0),
        }))
}

function aggregateMonthly(candles: CandleBar[]): CandleBar[] {
    const months: Record<string, CandleBar[]> = {}
    for (const c of candles) {
        const key = c.time.slice(0, 7) + '-01'
        if (!months[key]) months[key] = []
        months[key].push(c)
    }
    return Object.entries(months)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([time, bars]) => ({
            time,
            open:   Number(bars[0].open),
            high:   Math.max(...bars.map(b => Number(b.high))),
            low:    Math.min(...bars.map(b => Number(b.low))),
            close:  Number(bars[bars.length - 1].close),
            volume: bars.reduce((s, b) => s + Number(b.volume), 0),
        }))
}

export default function StockDetail() {
    const { stockId } = useParams<{ stockId: string }>()
    const navigate = useNavigate()

    const chartContainerRef = useRef<HTMLDivElement>(null)
    const chartRef = useRef<IChartApi | null>(null)
    const seriesRef = useRef<ISeriesApi<any> | null>(null)
    const socketRef = useRef<Socket | null>(null)
    const chartModeRef = useRef<ChartMode>('line')
    const linePeriodRef = useRef<LinePeriod>('1y')

    const [info, setInfo] = useState<StockInfo | null>(null)
    const [allCandles, setAllCandles] = useState<CandleBar[]>([])
    const [minuteCandles, setMinuteCandles] = useState<CandleBar[]>([])
    const [minuteLoaded, setMinuteLoaded] = useState(false)
    const [minuteLoading, setMinuteLoading] = useState(false)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(false)
    const [livePrice, setLivePrice] = useState<{
        price: number; change: number; changeRate: number; volume: number
    } | null>(null)

    const [chartMode, setChartMode] = useState<ChartMode>('line')
    const [linePeriod, setLinePeriod] = useState<LinePeriod>('1y')
    const [candleType, setCandleType] = useState<CandleType>('day')

    // 초기 데이터 로드
    useEffect(() => {
        if (!stockId) return
        const load = async () => {
            try {
                const res = await axios.get(`http://localhost:3000/api/market/stock-prices/${stockId}/detail`)
                if (!res.data.info) { setError(true); return }
                setInfo(res.data.info)
                setAllCandles(res.data.candles ?? [])
                setLivePrice({
                    price:      Number(res.data.info.price),
                    change:     Number(res.data.info.change),
                    changeRate: Number(res.data.info.changeRate),
                    volume:     Number(res.data.info.volume),
                })
            } catch {
                setError(true)
            } finally {
                setLoading(false)
            }
        }
        load()
    }, [stockId])

    // 분봉 필요 시 로드
    const needsMinute = (chartMode === 'line' && linePeriod === '1d') || (chartMode === 'candle' && candleType === 'minute')
    useEffect(() => {
        if (!needsMinute || minuteLoaded || !stockId) return
        setMinuteLoading(true)
        axios.get(`http://localhost:3000/api/market/stock-prices/${stockId}/minute?interval=1`)
            .then(res => { setMinuteCandles(res.data.candles ?? []); setMinuteLoaded(true) })
            .catch(() => setMinuteLoaded(true))
            .finally(() => setMinuteLoading(false))
    }, [needsMinute, minuteLoaded, stockId])

    // 차트에 그릴 데이터 계산
    // 분봉: UTCTimestamp (시분 표시), 일봉/주봉/월봉/선차트: string date (business day 모드 → 바 간격 균등)
    const { chartItems, isMinute, isLine } = useMemo(() => {
        if (chartMode === 'line') {
            if (linePeriod === '1d') {
                return {
                    chartItems: minuteCandles.map(c => ({
                        time: datetimeToTs(c.time),      // UTCTimestamp
                        value: Number(c.close),
                    })),
                    isMinute: true,
                    isLine: true,
                }
            }
            const { days } = LINE_PERIODS.find(p => p.key === linePeriod)!
            const cutoff = new Date()
            cutoff.setDate(cutoff.getDate() - days)
            const cutoffStr = cutoff.toISOString().slice(0, 10)
            return {
                chartItems: allCandles
                    .filter(c => c.time >= cutoffStr)
                    .map(c => ({ time: c.time as Time, value: Number(c.close) })),  // string date
                isMinute: false,
                isLine: true,
            }
        }

        // 봉차트
        let bars: CandleBar[]
        let isMin = false
        if (candleType === 'minute') { bars = minuteCandles; isMin = true }
        else if (candleType === 'day')   bars = allCandles
        else if (candleType === 'week')  bars = aggregateWeekly(allCandles)
        else                             bars = aggregateMonthly(allCandles)

        if (isMin) {
            return {
                chartItems: bars.map(c => ({
                    time:  datetimeToTs(c.time),         // UTCTimestamp
                    open:  Number(c.open),
                    high:  Number(c.high),
                    low:   Number(c.low),
                    close: Number(c.close),
                })),
                isMinute: true,
                isLine: false,
            }
        }

        return {
            chartItems: bars.map(c => ({
                time:  c.time as Time,                   // string date → business day 모드
                open:  Number(c.open),
                high:  Number(c.high),
                low:   Number(c.low),
                close: Number(c.close),
            })),
            isMinute: false,
            isLine: false,
        }
    }, [chartMode, linePeriod, candleType, allCandles, minuteCandles])

    // 차트 생성/재생성
    useEffect(() => {
        const el = chartContainerRef.current
        if (!el || chartItems.length === 0) return

        chartRef.current?.remove()
        chartRef.current = null
        seriesRef.current = null

        const chart = createChart(el, {
            autoSize: true,   // ← flex 컨테이너 width 자동 추적, 수동 계산 불필요
            height: 380,
            layout: {
                background: { color: '#ffffff' },
                textColor: '#6b7280',
            },
            grid: {
                vertLines: { color: '#f3f4f6' },
                horzLines: { color: '#f3f4f6' },
            },
            timeScale: {
                borderColor: '#e5e7eb',
                timeVisible: isMinute,   // 분봉만 시간 표시, 나머지는 날짜만
                secondsVisible: false,
                rightOffset: 0,
                minBarSpacing: isMinute ? 1 : 2,
            },
            rightPriceScale: { borderColor: '#e5e7eb' },
        })

        if (isLine) {
            const series = chart.addSeries(AreaSeries, {
                lineColor: '#2ecc71',
                topColor: 'rgba(46,204,113,0.25)',
                bottomColor: 'rgba(46,204,113,0.02)',
                lineWidth: 2,
            })
            series.setData(chartItems as any)
            seriesRef.current = series
        } else {
            const series = chart.addSeries(CandlestickSeries, {
                upColor:         '#ef4444',
                downColor:       '#3b82f6',
                borderUpColor:   '#ef4444',
                borderDownColor: '#3b82f6',
                wickUpColor:     '#ef4444',
                wickDownColor:   '#3b82f6',
            })
            series.setData(chartItems as any)
            seriesRef.current = series
        }

        chartRef.current = chart

        // 차트 타입별 초기 줌 설정
        requestAnimationFrame(() => {
            const len = chartItems.length
            // 봉차트 일봉/주봉: 초기 줌 = 최근 N봉 (일 단위 라벨이 보이는 수준)
            // 그 외 (분봉·선차트·월봉): fitContent
            const initialBars: Record<string, number> = {
                day:    20,   // 일봉: 최근 20거래일 (~1개월) → 일 단위 라벨 세밀하게
                week:   12,   // 주봉: 최근 12주 (~3개월)    → 주 단위 라벨 세밀하게
                month:  24,   // 월봉: 최근 24개월 (~2년)    → 월 단위 라벨 세밀하게
                minute: 0,    // 분봉: 전체 fitContent
            }
            const n = !isLine ? (initialBars[candleType] ?? 0) : 0

            if (n > 0 && len > n) {
                // 봉차트 일봉/주봉/월봉: 최근 N봉만 표시
                chart.timeScale().setVisibleLogicalRange({ from: len - n, to: len - 1 })
            } else {
                // 선차트 / 분봉: 여백 없이 데이터 범위 딱 맞게
                chart.timeScale().setVisibleLogicalRange({ from: 0, to: len - 1 })
            }
        })

        setTimeout(() => {
            el.querySelectorAll('a').forEach(a => { a.style.display = 'none' })
        }, 100)

        return () => {
            chart.remove()
            chartRef.current = null
            seriesRef.current = null
        }
    }, [chartItems, isMinute, isLine, candleType])

    // 모드/기간/타입 refs 동기화 (소켓 콜백 stale closure 방지)
    useEffect(() => { chartModeRef.current = chartMode }, [chartMode])
    useEffect(() => { linePeriodRef.current = linePeriod }, [linePeriod])
    const candleTypeRef = useRef<CandleType>('day')
    useEffect(() => { candleTypeRef.current = candleType }, [candleType])

    // 실시간 소켓
    useEffect(() => {
        if (!info) return
        const socket = io('http://localhost:3000')
        socketRef.current = socket

        // 연결/재연결 시 구독 재등록
        socket.on('connect', () => socket.emit('subscribe:stock', info.code))
        if (socket.connected) socket.emit('subscribe:stock', info.code)

        socket.on('stock:price', (data: {
            code: string; price: number; change: number
            changeRate: number; open: number; high: number; low: number; volume: number
        }) => {
            if (data.code !== info.code) return
            setLivePrice({ price: data.price, change: data.change, changeRate: data.changeRate, volume: data.volume })

            if (!seriesRef.current) return
            const mode = chartModeRef.current
            const period = linePeriodRef.current

            // 분봉/1일: datetimeToTs와 동일하게 KST를 UTC처럼 취급
            const kstTs = Math.floor((Date.now() + 9 * 3600 * 1000) / 1000) as UTCTimestamp
            const todayStr = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10) as Time

            if (mode === 'line') {
                const time = period === '1d' ? kstTs : todayStr
                seriesRef.current.update({ time, value: data.price } as any)
            } else {
                const candleMode = candleTypeRef.current
                const time = candleMode === 'minute' ? kstTs : todayStr
                seriesRef.current.update({
                    time, open: data.open, high: data.high, low: data.low, close: data.price,
                } as any)
            }
        })

        return () => {
            socket.emit('unsubscribe:stock', info.code)
            socket.disconnect()
        }
    }, [info])

    if (loading) return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', color: '#9ca3af', fontSize: '14px' }}>
            로딩 중...
        </div>
    )
    if (error || !info) return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', color: '#9ca3af', fontSize: '14px' }}>
            데이터를 불러올 수 없습니다
        </div>
    )

    const current = livePrice!
    const isUp = current.change >= 0

    const tabBtnStyle = (active: boolean): React.CSSProperties => ({
        padding: '4px 12px',
        borderRadius: '6px',
        border: 'none',
        cursor: 'pointer',
        fontSize: '12px',
        fontWeight: '700',
        backgroundColor: active ? '#fff' : 'transparent',
        color: active ? '#0f172a' : '#94a3b8',
        boxShadow: active ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
        transition: 'all 0.15s',
    })

    return (
        <div style={{ backgroundColor: '#f8fafc', minHeight: '100vh' }}>
            {/* 헤더 */}
            <div style={{ backgroundColor: '#fff', borderBottom: '1px solid #f1f5f9' }}>
                <div style={{ maxWidth: '1280px', margin: '0 auto', padding: '20px 32px' }}>
                    <button
                        onClick={() => navigate(-1)}
                        style={{
                            display: 'inline-flex', alignItems: 'center', gap: '4px',
                            fontSize: '13px', color: '#9ca3af', background: 'none',
                            border: 'none', cursor: 'pointer', padding: '0',
                            marginBottom: '16px', fontWeight: '500',
                        }}
                        onMouseEnter={e => (e.currentTarget.style.color = '#374151')}
                        onMouseLeave={e => (e.currentTarget.style.color = '#9ca3af')}
                    >
                        ← 목록으로
                    </button>

                    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: '16px' }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '14px' }}>
                            <span style={{ fontSize: '22px', fontWeight: '900', color: isUp ? '#ef4444' : '#3b82f6', lineHeight: 1, flexShrink: 0, marginTop: '3px' }}>
                                {isUp ? '▲' : '▼'}
                            </span>
                            <div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '3px' }}>
                                    <h1 style={{ fontSize: '22px', fontWeight: '900', color: '#0f172a', margin: 0 }}>{formatStockName(info.name)}</h1>
                                    <span style={{ fontSize: '11px', fontWeight: '700', color: '#64748b', backgroundColor: '#f1f5f9', padding: '2px 8px', borderRadius: '999px' }}>
                                        {info.type ?? info.market}
                                    </span>
                                </div>
                                <span style={{ fontSize: '13px', color: '#94a3b8', fontWeight: '500' }}>{info.code}</span>
                            </div>
                        </div>

                        <div style={{ textAlign: 'right' }}>
                            <div style={{ fontSize: '32px', fontWeight: '900', color: '#0f172a', lineHeight: 1, marginBottom: '6px' }}>
                                ₩{current.price.toLocaleString()}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px' }}>
                                <span style={{ fontSize: '15px', fontWeight: '700', color: isUp ? '#ef4444' : '#3b82f6' }}>
                                    {isUp ? '▲' : '▼'} {Math.abs(current.change).toLocaleString()}
                                </span>
                                <span style={{ fontSize: '13px', fontWeight: '600', color: '#fff', backgroundColor: isUp ? '#ef4444' : '#3b82f6', padding: '2px 8px', borderRadius: '6px' }}>
                                    {isUp ? '+' : ''}{current.changeRate.toFixed(2)}%
                                </span>
                            </div>
                        </div>
                    </div>

                    <div style={{ display: 'flex', gap: '32px', marginTop: '16px', paddingTop: '16px', borderTop: '1px solid #f1f5f9' }}>
                        <div style={{ fontSize: '12px', color: '#94a3b8' }}>
                            거래량 <span style={{ fontWeight: '700', color: '#374151', marginLeft: '4px' }}>{current.volume.toLocaleString()}</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '12px', color: '#22C55E', fontWeight: '600' }}>
                            <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#22C55E', display: 'inline-block', animation: 'pulse-dot 1.8s ease-in-out infinite' }} />
                            실시간
                        </div>
                    </div>
                </div>
            </div>

            {/* 메인 콘텐츠 */}
            <div style={{ maxWidth: '1280px', margin: '0 auto', padding: '24px 32px', display: 'flex', gap: '24px', alignItems: 'flex-start' }}>
                {/* 차트 */}
                <div style={{ flex: 1, backgroundColor: '#fff', borderRadius: '20px', padding: '24px', border: '1px solid #f1f5f9', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
                    {/* 차트 모드 탭 */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                        <div style={{ display: 'flex', gap: '4px', backgroundColor: '#f1f5f9', borderRadius: '8px', padding: '3px' }}>
                            {(['line', 'candle'] as const).map(mode => (
                                <button
                                    key={mode}
                                    onClick={() => setChartMode(mode)}
                                    style={tabBtnStyle(chartMode === mode)}
                                >
                                    {mode === 'line' ? '선차트' : '봉차트'}
                                </button>
                            ))}
                        </div>

                        {/* 기간/타입 탭 */}
                        <div style={{ display: 'flex', gap: '4px', backgroundColor: '#f1f5f9', borderRadius: '8px', padding: '3px' }}>
                            {chartMode === 'line'
                                ? LINE_PERIODS.map(({ key, label }) => (
                                    <button key={key} onClick={() => setLinePeriod(key)} style={tabBtnStyle(linePeriod === key)}>
                                        {label}
                                    </button>
                                ))
                                : CANDLE_TYPES.map(({ key, label }) => (
                                    <button key={key} onClick={() => setCandleType(key)} style={tabBtnStyle(candleType === key)}>
                                        {label}
                                    </button>
                                ))
                            }
                        </div>
                    </div>

                    {minuteLoading && (
                        <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: '13px', padding: '60px 0' }}>로딩 중...</div>
                    )}
                    <div ref={chartContainerRef} style={{ width: '100%' }} />
                </div>

                {/* 주문 패널 */}
                <div style={{ width: '300px', flexShrink: 0 }}>
                    <OrderPanel
                        stockId={info.id}
                        stockCode={info.code}
                        stockName={formatStockName(info.name)}
                        currentPrice={current.price}
                    />
                </div>
            </div>
        </div>
    )
}
