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

    // --- [신규] 주문 패널용 상태 관리 ---
    const [tradeType, setTradeType] = useState<'buy' | 'sell'>('buy') // 매수 or 매도
    const [orderPrice, setOrderPrice] = useState<number>(0) // 주문 단가
    const [orderAmount, setOrderAmount] = useState<number>(0) // 주문 수량

    // ─── 1단계: 데이터 로드 ──────────────────────────────────

    useEffect(() => {
        if (!stockId) return
        const load = async () => {
            try {
                const res = await axios.get(`http://localhost:3000/api/market/stock-prices/${stockId}/detail`)
                if (!res.data.info) { setError(true); return }
                
                setInfo(res.data.info)
                setCandles(res.data.candles ?? [])
                setLivePrice({
                    price: Number(res.data.info.price),
                    change: Number(res.data.info.change),
                    changeRate: Number(res.data.info.changeRate),
                    volume: Number(res.data.info.volume),
                })
                // 데이터 로드 시 주문 단가를 현재가로 초기 세팅
                setOrderPrice(Number(res.data.info.price))
            } catch (e) {
                console.error('[StockDetail] 로드 실패:', e)
                setError(true)
            } finally {
                setLoading(false)
            }
        }
        load()
    }, [stockId])

    // ─── 2단계: 차트 초기화 ─────────────────────────────────

    const initChart = useCallback((el: HTMLDivElement) => {
        if (!el || candles.length === 0 || chartRef.current) return

        const chart = createChart(el, {
            width: el.clientWidth,
            height: 500, // 높이를 조금 늘려 시원하게 보이도록 수정
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

    // ─── [신규] 주문 제출 핸들러 ─────────────────────────────
    const handleTradeSubmit = () => {
        const isLoggedIn = localStorage.getItem('loginTime');
        if (!isLoggedIn) {
            alert('로그인 후 거래할 수 있습니다.');
            return;
        }

        if (orderAmount <= 0) {
            alert('주문 수량을 1주 이상 입력해주세요.');
            return;
        }

        const totalPrice = orderPrice * orderAmount;
        const tradeLabel = tradeType === 'buy' ? '매수' : '매도';

        // TODO (Backend): 주문 처리 API 연동
        // Method: POST /api/trade/order
        // Body: { stockCode: info.code, type: tradeType, price: orderPrice, amount: orderAmount }
        alert(`[API 연동 필요] 주문이 접수되었습니다!\n\n종목: ${info?.name}\n주문: ${tradeLabel}\n단가: ₩${orderPrice.toLocaleString()}\n수량: ${orderAmount}주\n총액: ₩${totalPrice.toLocaleString()}`);
        
        // 주문 후 수량 초기화
        setOrderAmount(0);
    }

    // ─── 렌더 ────────────────────────────────────────────────

    if (loading) return <div className="flex justify-center items-center h-screen text-gray-400">로딩 중...</div>
    if (error || !info) return <div className="flex justify-center items-center h-screen text-gray-400">데이터를 불러올 수 없습니다.</div>

    const current = livePrice!
    const isUp = current.change >= 0

    return (
        <div className="bg-gray-50 min-h-screen font-sans pb-20">
            {/* 상단 헤더 */}
            <div className="bg-white border-b border-gray-100 px-10 py-6">
                <button onClick={() => navigate(-1)} className="text-sm text-gray-400 hover:text-gray-600 mb-4 flex items-center gap-1 transition-colors">
                    ← 목록으로
                </button>
                <div className="flex items-start justify-between">
                    <div>
                        <div className="flex items-center gap-2 mb-1">
                            <h1 className="text-3xl font-black text-gray-900">{info.name}</h1>
                            <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full font-medium">{info.market}</span>
                        </div>
                        <span className="text-sm text-gray-400">{info.code}</span>
                    </div>
                    <div className="text-right">
                        <div className="text-4xl font-black text-gray-900 mb-1 tracking-tight">
                            ₩{current.price.toLocaleString()}
                        </div>
                        <div className={`text-lg font-bold ${isUp ? 'text-red-500' : 'text-blue-500'}`}>
                            {isUp ? '▲' : '▼'} {Math.abs(current.change).toLocaleString()}
                            &nbsp;<span className="text-sm font-semibold">({isUp ? '+' : ''}{current.changeRate.toFixed(2)}%)</span>
                        </div>
                        <div className="text-xs text-gray-400 mt-2">
                            거래량 {current.volume.toLocaleString()} &nbsp;·&nbsp;
                            <span className="text-[#22C55E] font-bold">● 실시간</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* 메인 콘텐츠 (좌측 차트 / 우측 주문창) */}
            <div className="p-8 max-w-[1600px] mx-auto flex flex-col lg:flex-row gap-8">
                
                {/* 좌측: 차트 영역 */}
                <div className="flex-1 bg-white rounded-[32px] p-8 shadow-sm border border-gray-100">
                    <div className="flex items-center justify-between mb-6">
                        <h2 className="text-sm font-bold text-gray-400 uppercase tracking-widest">일봉 차트 (최근 90일)</h2>
                    </div>
                    <div ref={chartContainerRef} className="w-full" />
                </div>

                {/* 우측: 주문 패널 */}
                <div className="w-full lg:w-[400px] shrink-0 bg-white rounded-[32px] shadow-sm border border-gray-100 flex flex-col overflow-hidden">
                    
                    {/* 매수/매도 탭 */}
                    <div className="flex w-full">
                        <button 
                            onClick={() => setTradeType('buy')}
                            className={`flex-1 py-5 font-black text-lg transition-colors ${tradeType === 'buy' ? 'bg-red-50 text-red-500 border-b-2 border-red-500' : 'text-gray-400 hover:bg-gray-50'}`}
                        >
                            매수
                        </button>
                        <button 
                            onClick={() => setTradeType('sell')}
                            className={`flex-1 py-5 font-black text-lg transition-colors ${tradeType === 'sell' ? 'bg-blue-50 text-blue-500 border-b-2 border-blue-500' : 'text-gray-400 hover:bg-gray-50'}`}
                        >
                            매도
                        </button>
                    </div>

                    <div className="p-8 flex flex-col gap-8">
                        {/* 주문 단가 설정 */}
                        <div>
                            <div className="flex justify-between mb-2">
                                <label className="text-sm font-bold text-gray-600">주문 단가 (₩)</label>
                                <button onClick={() => setOrderPrice(current.price)} className="text-xs text-gray-400 underline hover:text-gray-600">현재가 적용</button>
                            </div>
                            <input 
                                type="number" 
                                value={orderPrice || ''}
                                onChange={(e) => setOrderPrice(Number(e.target.value))}
                                className="w-full p-4 border border-gray-200 rounded-2xl outline-none focus:border-gray-900 text-right font-bold text-lg transition"
                            />
                        </div>

                        {/* 주문 수량 설정 */}
                        <div>
                            <label className="block text-sm font-bold text-gray-600 mb-2">주문 수량 (주)</label>
                            <div className="flex gap-2 mb-3">
                                <input 
                                    type="number" 
                                    min="0"
                                    value={orderAmount || ''}
                                    onChange={(e) => setOrderAmount(Number(e.target.value))}
                                    className="flex-1 p-4 border border-gray-200 rounded-2xl outline-none focus:border-gray-900 text-right font-bold text-lg transition"
                                />
                            </div>
                            {/* 간편 수량 버튼 */}
                            <div className="grid grid-cols-4 gap-2">
                                {[1, 10, 50, 100].map(amt => (
                                    <button 
                                        key={amt} 
                                        onClick={() => setOrderAmount(prev => prev + amt)}
                                        className="py-2 bg-gray-50 hover:bg-gray-100 text-gray-600 text-sm font-bold rounded-xl transition"
                                    >
                                        +{amt}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="border-t border-gray-100 pt-6 mt-2">
                            <div className="flex justify-between items-end mb-6">
                                <span className="text-sm font-bold text-gray-500">총 주문금액</span>
                                <span className="text-2xl font-black text-gray-900">
                                    ₩{(orderPrice * orderAmount).toLocaleString()}
                                </span>
                            </div>

                            {/* 제출 버튼 */}
                            <button 
                                onClick={handleTradeSubmit}
                                className={`w-full py-5 rounded-2xl font-black text-lg text-white transition-all shadow-lg ${
                                    tradeType === 'buy' 
                                        ? 'bg-red-500 hover:bg-red-600 shadow-red-500/20' 
                                        : 'bg-blue-500 hover:bg-blue-600 shadow-blue-500/20'
                                }`}
                            >
                                {tradeType === 'buy' ? '매수하기' : '매도하기'}
                            </button>
                        </div>
                    </div>
                </div>

            </div>
        </div>
    )
}