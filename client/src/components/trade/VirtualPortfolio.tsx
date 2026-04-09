import { useEffect, useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import { io, Socket } from 'socket.io-client'
import PinPad from './PinPad'
import { formatStockName } from '../../utils/formatStockName'

interface Holding {
  stock_id: number
  code: string
  name: string
  quantity: number
  avg_price: number
  currentPrice: number
  evalAmount: number
  pnl: number
  pnlRate: number
}

interface Portfolio {
  balance: number
  initialBalance: number
  totalEval: number
  totalAsset: number
  totalPnl: number
  totalPnlRate: number
  holdings: Holding[]
}

interface Order {
  id: number
  side: 'buy' | 'sell'
  order_type: 'market' | 'limit'
  stock_name: string
  stock_code: string
  quantity: number
  price: number
  total_amount: number
  status: string
  ordered_at: string
  filled_at: string | null
}

// PIN setup flow: 'set1' | 'set2' | 'open'
type PinFlow = 'set1' | 'set2' | 'open' | null

export default function VirtualPortfolio() {
  const navigate = useNavigate()
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null)
  const [orders, setOrders] = useState<Order[]>([])
  const [noAccount, setNoAccount] = useState(false)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'holdings' | 'orders'>('holdings')
  const [ordersLoading, setOrdersLoading] = useState(false)

  // PIN flow state
  const [pinFlow, setPinFlow] = useState<PinFlow>(null)
  const [tempPin, setTempPin] = useState('')      // first entry stored for confirm
  const [pinPadKey, setPinPadKey] = useState(0)  // force remount on error
  const [pinError, setPinError] = useState('')
  const [working, setWorking] = useState(false)

  const socketRef = useRef<Socket | null>(null)

  const fetchPortfolio = useCallback(async () => {
    try {
      const res = await axios.get('http://localhost:3000/api/trade/virtual/portfolio', { withCredentials: true })
      setPortfolio(res.data)
      setNoAccount(false)
    } catch (err: any) {
      if (err.response?.status === 404) setNoAccount(true)
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchOrders = useCallback(async () => {
    setOrdersLoading(true)
    try {
      const res = await axios.get('http://localhost:3000/api/trade/virtual/orders', { withCredentials: true })
      setOrders(res.data)
    } catch {
      // silent
    } finally {
      setOrdersLoading(false)
    }
  }, [])

  useEffect(() => { fetchPortfolio() }, [fetchPortfolio])

  // 실시간 가격 업데이트 — 크롤러 브로드캐스트 수신 (구독 없이)
  useEffect(() => {
    if (!portfolio || portfolio.holdings.length === 0) return

    const socket = io('http://localhost:3000')
    socketRef.current = socket

    const holdingCodes = new Set(portfolio.holdings.map(h => h.code))

    socket.on('stock:price', (data: { code: string; price: number }) => {
      if (!holdingCodes.has(data.code)) return

      setPortfolio(prev => {
        if (!prev) return prev
        const holdingIdx = prev.holdings.findIndex(h => h.code === data.code)
        if (holdingIdx === -1) return prev

        const holdings = prev.holdings.map((h, i) => {
          if (i !== holdingIdx) return h
          const evalAmount = h.quantity * data.price
          const costBasis = h.quantity * Number(h.avg_price)
          const pnl = evalAmount - costBasis
          const pnlRate = costBasis > 0 ? (pnl / costBasis) * 100 : 0
          return { ...h, currentPrice: data.price, evalAmount, pnl, pnlRate }
        })

        const totalEval = holdings.reduce((sum, h) => sum + h.evalAmount, 0)
        const totalAsset = prev.balance + totalEval
        const totalPnl = holdings.reduce((sum, h) => sum + h.pnl, 0)
        const totalCost = holdings.reduce((sum, h) => sum + h.quantity * Number(h.avg_price), 0)
        const totalPnlRate = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0

        return { ...prev, holdings, totalEval, totalAsset, totalPnl, totalPnlRate }
      })
    })

    return () => { socket.disconnect() }
  }, [portfolio?.holdings.map(h => h.code).join(',')])

  useEffect(() => {
    if (tab === 'orders' && portfolio) fetchOrders()
  }, [tab, portfolio, fetchOrders])

  // ── PIN flow handlers ──────────────────────────────────────

  const startAccountOpening = () => {
    setPinError('')
    setPinFlow('set1')
    setPinPadKey(k => k + 1)
  }

  const handlePinInput = async (pin: string) => {
    if (pinFlow === 'set1') {
      // Store first PIN, go to confirm step
      setTempPin(pin)
      setPinFlow('set2')
      setPinPadKey(k => k + 1)

    } else if (pinFlow === 'set2') {
      // Confirm step
      if (pin !== tempPin) {
        setPinError('PIN이 일치하지 않습니다. 다시 설정해주세요.')
        setTempPin('')
        setPinFlow('set1')
        setPinPadKey(k => k + 1)
        return
      }
      // Match — call setPin API
      setWorking(true)
      try {
        await axios.post('http://localhost:3000/api/trade/virtual/pin', { pin }, { withCredentials: true })
        setPinFlow('open')
        setPinPadKey(k => k + 1)
        setPinError('')
      } catch (err: any) {
        setPinError(err.response?.data?.message ?? '오류가 발생했습니다')
        setTempPin('')
        setPinFlow('set1')
        setPinPadKey(k => k + 1)
      } finally {
        setWorking(false)
      }

    } else if (pinFlow === 'open') {
      // Open account confirmation
      setWorking(true)
      try {
        await axios.post('http://localhost:3000/api/trade/virtual/account/open', { pin }, { withCredentials: true })
        setPinFlow(null)
        setPinError('')
        setLoading(true)
        fetchPortfolio()
      } catch (err: any) {
        setPinError(err.response?.data?.message ?? '계좌 개설에 실패했습니다')
        setPinPadKey(k => k + 1)
      } finally {
        setWorking(false)
      }
    }
  }

  const cancelPinFlow = () => {
    setPinFlow(null)
    setTempPin('')
    setPinError('')
  }

  // ── Render: loading ──────────────────────────────────────────

  if (loading) return (
    <div style={{ color: '#9ca3af', padding: '40px', textAlign: 'center', fontSize: '14px' }}>
      불러오는 중...
    </div>
  )

  // ── Render: no account ───────────────────────────────────────

  if (noAccount) {
    const pinTitles: Record<NonNullable<PinFlow>, string> = {
      set1: 'PIN 설정 (1/2)',
      set2: 'PIN 확인 (2/2)',
      open: '계좌 개설 확인',
    }
    const pinSubtitles: Record<NonNullable<PinFlow>, string> = {
      set1: '매수/매도 시 사용할 6자리 PIN을 입력하세요',
      set2: '확인을 위해 PIN을 다시 입력하세요',
      open: '방금 설정한 PIN을 입력하면 계좌가 개설됩니다',
    }

    return (
      <div style={{ textAlign: 'center', padding: '48px 20px' }}>
        <div style={{
          width: '64px', height: '64px', borderRadius: '20px',
          backgroundColor: '#f0fdf4', display: 'inline-flex',
          alignItems: 'center', justifyContent: 'center',
          fontSize: '28px', marginBottom: '20px',
        }}>
          📊
        </div>
        <p style={{ fontWeight: '800', fontSize: '18px', marginBottom: '8px', color: '#111' }}>
          모의투자 계좌가 없습니다
        </p>
        <p style={{ fontSize: '13px', color: '#6b7280', marginBottom: '8px', lineHeight: '1.6' }}>
          1,000만 원의 가상 자산으로 실전 같은 주식 투자를 체험해보세요
        </p>
        {pinError && (
          <p style={{ fontSize: '13px', color: '#dc2626', marginBottom: '12px', fontWeight: '600' }}>
            {pinError}
          </p>
        )}
        <button
          onClick={startAccountOpening}
          disabled={working}
          style={{
            marginTop: '8px',
            padding: '12px 28px',
            backgroundColor: '#22C55E',
            color: '#fff',
            border: 'none',
            borderRadius: '12px',
            fontWeight: '700',
            fontSize: '14px',
            cursor: 'pointer',
            boxShadow: '0 4px 12px rgba(34,197,94,0.3)',
          }}
        >
          계좌 개설하기
        </button>

        {pinFlow && (
          <PinPad
            key={pinPadKey}
            title={pinTitles[pinFlow]}
            subtitle={pinSubtitles[pinFlow]}
            onConfirm={handlePinInput}
            onCancel={cancelPinFlow}
          />
        )}
      </div>
    )
  }

  if (!portfolio) return null

  // ── Summary stats ────────────────────────────────────────────

  const totalReturn = portfolio.initialBalance > 0
    ? ((portfolio.totalAsset - portfolio.initialBalance) / portfolio.initialBalance) * 100
    : 0
  const isProfit = portfolio.totalPnl >= 0

  return (
    <div>
      {/* ── 자산 요약 ── */}
      <div style={{
        background: isProfit
          ? 'linear-gradient(135deg, #fef2f2 0%, #fee2e2 100%)'
          : 'linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%)',
        borderRadius: '20px',
        padding: '24px 28px',
        marginBottom: '24px',
        position: 'relative',
        overflow: 'hidden',
      }}>
        {/* decorative arc */}
        <div style={{
          position: 'absolute', right: '-30px', top: '-30px',
          width: '140px', height: '140px', borderRadius: '50%',
          backgroundColor: isProfit ? 'rgba(220,38,38,0.06)' : 'rgba(59,130,246,0.08)',
        }} />
        <p style={{ fontSize: '12px', fontWeight: '600', color: '#6b7280', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          총 자산
        </p>
        <p style={{ fontSize: '28px', fontWeight: '900', color: '#111', marginBottom: '16px' }}>
          ₩{portfolio.totalAsset.toLocaleString()}
        </p>

        {/* 보유주식 + 계좌잔고 구성 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px', fontSize: '12px', color: '#6b7280' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <div style={{ width: '10px', height: '10px', borderRadius: '2px', backgroundColor: isProfit ? '#dc2626' : '#3b82f6' }} />
            <span>보유주식</span>
            <span style={{ fontWeight: '700', color: '#111' }}>₩{portfolio.totalEval.toLocaleString()}</span>
          </div>
          <span style={{ color: '#d1d5db' }}>+</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <div style={{ width: '10px', height: '10px', borderRadius: '2px', backgroundColor: '#9ca3af' }} />
            <span>계좌잔고</span>
            <span style={{ fontWeight: '700', color: '#111' }}>₩{portfolio.balance.toLocaleString()}</span>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '32px' }}>
          <div>
            <p style={{ fontSize: '11px', color: '#9ca3af', marginBottom: '2px' }}>총 손익</p>
            <p style={{ fontSize: '16px', fontWeight: '700', color: isProfit ? '#dc2626' : '#2563eb' }}>
              {isProfit ? '+' : ''}₩{portfolio.totalPnl.toLocaleString()}
            </p>
          </div>
          <div>
            <p style={{ fontSize: '11px', color: '#9ca3af', marginBottom: '2px' }}>수익률</p>
            <p style={{ fontSize: '16px', fontWeight: '700', color: portfolio.totalPnlRate >= 0 ? '#dc2626' : '#2563eb' }}>
              {portfolio.totalPnlRate >= 0 ? '+' : ''}{portfolio.totalPnlRate.toFixed(2)}%
            </p>
          </div>
        </div>
      </div>

      {/* ── 미니 스탯 ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', marginBottom: '24px' }}>
        {[
          { label: '주식 평가금액', value: `₩${portfolio.totalEval.toLocaleString()}` },
          { label: '평가 손익률', value: `${portfolio.totalPnlRate >= 0 ? '+' : ''}${portfolio.totalPnlRate.toFixed(2)}%`, color: portfolio.totalPnlRate >= 0 ? '#dc2626' : '#2563eb' },
          { label: '초기 지급금', value: `₩${portfolio.initialBalance.toLocaleString()}` },
        ].map(item => (
          <div key={item.label} style={{ backgroundColor: '#f9fafb', borderRadius: '14px', padding: '14px 16px', border: '1px solid #f3f4f6' }}>
            <p style={{ fontSize: '11px', color: '#9ca3af', marginBottom: '6px' }}>{item.label}</p>
            <p style={{ fontSize: '14px', fontWeight: '700', color: (item as any).color ?? '#111' }}>{item.value}</p>
          </div>
        ))}
      </div>

      {/* ── 탭 ── */}
      <div style={{ display: 'flex', gap: '4px', backgroundColor: '#f3f4f6', borderRadius: '14px', padding: '4px', marginBottom: '20px' }}>
        {(['holdings', 'orders'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              flex: 1,
              padding: '9px',
              border: 'none',
              borderRadius: '10px',
              fontSize: '13px',
              fontWeight: '700',
              cursor: 'pointer',
              transition: 'all 0.18s ease',
              backgroundColor: tab === t ? '#fff' : 'transparent',
              color: tab === t ? '#111' : '#9ca3af',
              boxShadow: tab === t ? '0 1px 4px rgba(0,0,0,0.08)' : 'none',
            }}
          >
            {t === 'holdings' ? `보유종목 ${portfolio.holdings.length > 0 ? `(${portfolio.holdings.length})` : ''}` : '거래내역'}
          </button>
        ))}
      </div>

      {/* ── 보유종목 탭 ── */}
      {tab === 'holdings' && (
        portfolio.holdings.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: '#9ca3af', fontSize: '13px', backgroundColor: '#f9fafb', borderRadius: '16px' }}>
            보유 중인 종목이 없습니다
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {portfolio.holdings.map(h => {
              const up = h.pnl >= 0
              return (
                <div
                  key={h.stock_id}
                  onClick={() => navigate(`/stock/${h.stock_id}`)}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    backgroundColor: '#fafafa',
                    borderRadius: '14px',
                    padding: '16px 18px',
                    border: '1px solid #f3f4f6',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                  onMouseEnter={e => {
                    (e.currentTarget as HTMLDivElement).style.backgroundColor = '#f0fdf4'
                    ;(e.currentTarget as HTMLDivElement).style.borderColor = '#bbf7d0'
                  }}
                  onMouseLeave={e => {
                    (e.currentTarget as HTMLDivElement).style.backgroundColor = '#fafafa'
                    ;(e.currentTarget as HTMLDivElement).style.borderColor = '#f3f4f6'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    {/* 종목 아이콘 */}
                    <div style={{
                      width: '38px', height: '38px', borderRadius: '10px',
                      backgroundColor: up ? '#fef2f2' : '#eff6ff',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '16px',
                      color: up ? '#dc2626' : '#2563eb',
                      flexShrink: 0,
                    }}>
                      {up ? '▲' : '▼'}
                    </div>
                    <div>
                      <p style={{ fontWeight: '700', fontSize: '14px', color: '#111', marginBottom: '2px' }}>
                        {formatStockName(h.name)}
                      </p>
                      <p style={{ fontSize: '11px', color: '#9ca3af' }}>
                        {h.quantity}주 &nbsp;·&nbsp; 매매가 ₩{Number(h.avg_price).toLocaleString()} &nbsp;·&nbsp; 현재가 ₩{Number(h.currentPrice).toLocaleString()}
                      </p>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <p style={{ fontWeight: '800', fontSize: '14px', color: '#111', marginBottom: '2px' }}>
                      ₩{h.evalAmount.toLocaleString()}
                    </p>
                    <p style={{
                      fontSize: '12px', fontWeight: '700',
                      color: up ? '#dc2626' : '#2563eb',
                    }}>
                      <span style={{ fontSize: '8px', verticalAlign: 'middle' }}>{up ? '▲' : '▼'}</span>
                      {' '}{up ? '+' : ''}{h.pnlRate.toFixed(2)}%
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        )
      )}

      {/* ── 거래내역 탭 ── */}
      {tab === 'orders' && (
        ordersLoading ? (
          <div style={{ textAlign: 'center', padding: '40px', color: '#9ca3af', fontSize: '13px' }}>불러오는 중...</div>
        ) : orders.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px', color: '#9ca3af', fontSize: '13px', backgroundColor: '#f9fafb', borderRadius: '16px' }}>
            거래 내역이 없습니다
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {orders.map(o => {
              const isBuy = o.side === 'buy'
              return (
                <div
                  key={o.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    backgroundColor: '#fafafa',
                    borderRadius: '14px',
                    padding: '14px 18px',
                    border: '1px solid #f3f4f6',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    {/* 매수/매도 뱃지 */}
                    <div style={{
                      width: '34px', height: '34px', borderRadius: '9px',
                      backgroundColor: isBuy ? '#fef2f2' : '#eff6ff',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '11px', fontWeight: '800',
                      color: isBuy ? '#dc2626' : '#2563eb',
                      flexShrink: 0,
                    }}>
                      {isBuy ? '매수' : '매도'}
                    </div>
                    <div>
                      <p style={{ fontWeight: '700', fontSize: '13px', color: '#111', marginBottom: '2px' }}>
                        {formatStockName(o.stock_name)}
                        <span style={{ fontSize: '11px', color: '#9ca3af', fontWeight: '500', marginLeft: '6px' }}>
                          {o.order_type === 'market' ? '시장가' : '지정가'}
                        </span>
                      </p>
                      <p style={{ fontSize: '11px', color: '#9ca3af' }}>
                        {o.quantity}주 · ₩{Number(o.price).toLocaleString()} · {o.ordered_at}
                      </p>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <p style={{ fontWeight: '700', fontSize: '13px', color: isBuy ? '#dc2626' : '#2563eb', marginBottom: '2px' }}>
                      {isBuy ? '-' : '+'}₩{Number(o.total_amount).toLocaleString()}
                    </p>
                    <p style={{
                      fontSize: '11px', fontWeight: '600',
                      color: o.status === 'filled' ? '#16a34a' : '#9ca3af',
                    }}>
                      {o.status === 'filled' ? '체결' : o.status}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        )
      )}
    </div>
  )
}
