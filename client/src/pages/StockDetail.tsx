import { useEffect, useRef, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { createChart, CandlestickSeries } from 'lightweight-charts'
import type { IChartApi, ISeriesApi, CandlestickData, Time } from 'lightweight-charts'
import { io, Socket } from 'socket.io-client'
import axios from 'axios'

interface StockInfo {
    id: number
    name: string
    code: string
    market: string
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

export default function StockDetail() {
    const { stockId } = useParams<{ stockId: string }>()
    const navigate = useNavigate()

    const chartContainerRef = useRef<HTMLDivElement>(null)
    const chartRef = useRef<IChartApi | null>(null)
    const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
    const socketRef = useRef<Socket | null>(null)

    const [info, setInfo] = useState<StockInfo | null>(null)
    const [candles, setCandles] = useState<CandleBar[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(false)
    const [livePrice, setLivePrice] = useState<{
        price: number; change: number; changeRate: number; volume: number
    } | null>(null)

    // ─── 1단계: 데이터 로드 ──────────────────────────────────

    useEffect(() => {
        if (!stockId) return
        const load = async () => {
            try {
                const res = await axios.get(`http://localhost:3000/api/market/stock-prices/${stockId}/detail`)
                console.log('[StockDetail] API 응답:', res.data)
                if (!res.data.info) { setError(true); return }
                setInfo(res.data.info)
                setCandles(res.data.candles ?? [])
                setLivePrice({
                    price: Number(res.data.info.price),
                    change: Number(res.data.info.change),
                    changeRate: Number(res.data.info.changeRate),
                    volume: Number(res.data.info.volume),
                })
            } catch (e) {
                console.error('[StockDetail] 로드 실패:', e)
                setError(true)
            } finally {
                setLoading(false)
            }
        }
        load()
    }, [stockId])

    // ─── 2단계: 차트 초기화 (데이터 로드 + DOM 준비 후) ─────

    const initChart = useCallback((el: HTMLDivElement) => {
        if (!el || candles.length === 0 || chartRef.current) return

        const chart = createChart(el, {
            width: el.clientWidth,
            height: 400,
            layout: {
                background: { color: '#ffffff' },
                textColor: '#374151',
            },
            grid: {
                vertLines: { color: '#f3f4f6' },
                horzLines: { color: '#f3f4f6' },
            },
            timeScale: { borderColor: '#e5e7eb', timeVisible: true },
            rightPriceScale: { borderColor: '#e5e7eb' },
        })

        const series = chart.addSeries(CandlestickSeries, {
            upColor: '#ef4444',
            downColor: '#3b82f6',
            borderUpColor: '#ef4444',
            borderDownColor: '#3b82f6',
            wickUpColor: '#ef4444',
            wickDownColor: '#3b82f6',
        })

        series.setData(candles.map(c => ({
            time: c.time as Time,
            open: Number(c.open),
            high: Number(c.high),
            low: Number(c.low),
            close: Number(c.close),
        })))

        chart.timeScale().fitContent()
        chartRef.current = chart
        seriesRef.current = series

        // TradingView 로고 제거
        setTimeout(() => {
            el.querySelectorAll('a').forEach(a => { a.style.display = 'none' })
        }, 100)

        const handleResize = () => chart.applyOptions({ width: el.clientWidth })
        window.addEventListener('resize', handleResize)
        return () => window.removeEventListener('resize', handleResize)
    }, [candles])

    useEffect(() => {
        const el = chartContainerRef.current
        if (!el || candles.length === 0) return
        const cleanup = initChart(el)
        return () => {
            cleanup?.()
            chartRef.current?.remove()
            chartRef.current = null
            seriesRef.current = null
        }
    }, [candles, initChart])

    // ─── 3단계: 실시간 구독 ──────────────────────────────────

    useEffect(() => {
        if (!info) return
        const socket = io('http://localhost:3000')
        socketRef.current = socket
        socket.emit('subscribe:stock', info.code)

        socket.on('stock:price', (data: {
            code: string; price: number; change: number
            changeRate: number; open: number; high: number; low: number; volume: number
        }) => {
            if (data.code !== info.code) return
            setLivePrice({ price: data.price, change: data.change, changeRate: data.changeRate, volume: data.volume })
            const today = new Date().toISOString().slice(0, 10) as Time
            seriesRef.current?.update({
                time: today, open: data.open, high: data.high, low: data.low, close: data.price,
            } as CandlestickData)
        })

        return () => {
            socket.emit('unsubscribe:stock', info.code)
            socket.disconnect()
        }
    }, [info])

    // ─── 렌더 ────────────────────────────────────────────────

    if (loading) return <div className="flex justify-center items-center h-screen text-gray-400">로딩 중...</div>
    if (error || !info) return <div className="flex justify-center items-center h-screen text-gray-400">데이터를 불러올 수 없습니다.</div>

    const current = livePrice!
    const isUp = current.change >= 0

    return (
        <div className="bg-gray-50 min-h-screen font-sans">
            {/* 상단 헤더 */}
            <div className="bg-white border-b border-gray-100 px-8 py-6">
                <button onClick={() => navigate(-1)} className="text-sm text-gray-400 hover:text-gray-600 mb-4 flex items-center gap-1 transition-colors">
                    ← 목록으로
                </button>
                <div className="flex items-start justify-between">
                    <div>
                        <div className="flex items-center gap-2 mb-1">
                            <h1 className="text-2xl font-black text-gray-900">{info.name}</h1>
                            <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full font-medium">{info.market}</span>
                        </div>
                        <span className="text-sm text-gray-400">{info.code}</span>
                    </div>
                    <div className="text-right">
                        <div className="text-3xl font-black text-gray-900 mb-1">
                            ₩{current.price.toLocaleString()}
                        </div>
                        <div className={`text-base font-bold ${isUp ? 'text-red-500' : 'text-blue-500'}`}>
                            {isUp ? '▲' : '▼'} {Math.abs(current.change).toLocaleString()}
                            &nbsp;<span className="text-sm">({isUp ? '+' : ''}{current.changeRate.toFixed(2)}%)</span>
                        </div>
                        <div className="text-xs text-gray-400 mt-1">
                            거래량 {current.volume.toLocaleString()} &nbsp;·&nbsp;
                            <span className="text-green-500 font-semibold">● 실시간</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* 차트 */}
            <div className="p-8">
                <div className="bg-white rounded-3xl p-6 shadow-sm border border-gray-100">
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-sm font-bold text-gray-500 uppercase tracking-widest">일봉 차트 (최근 90일)</h2>
                    </div>
                    <div ref={chartContainerRef} />
                </div>
            </div>
        </div>
    )
}
