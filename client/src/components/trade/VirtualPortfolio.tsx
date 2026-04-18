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
  pending_sell: number
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

interface PendingOrder {
  id: number
  side: 'buy' | 'sell'
  stock_name: string
  stock_code: string
  quantity: number
  price: number
  total_amount: number
  ordered_at: string
}

type PinFlow = 'set1' | 'set2' | 'open' | null
type ManagePinFlow = 'old' | 'new1' | 'new2' | null

export default function VirtualPortfolio() {
  const navigate = useNavigate()
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null)
  const [orders, setOrders] = useState<Order[]>([])
  const [pendingOrders, setPendingOrders] = useState<PendingOrder[]>([])
  const [noAccount, setNoAccount] = useState(false)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'holdings' | 'orders' | 'pending'>('holdings')
  const [ordersLoading, setOrdersLoading] = useState(false)
  const [pendingLoading, setPendingLoading] = useState(false)
  const [isPhoneVerified, setIsPhoneVerified] = useState<boolean | null>(null)

  // 계좌 개설 PIN flow
  const [pinFlow, setPinFlow] = useState<PinFlow>(null)
  const [tempPin, setTempPin] = useState('')
  const [pinPadKey, setPinPadKey] = useState(0)
  const [pinError, setPinError] = useState('')
  const [working, setWorking] = useState(false)

  // PIN 변경 flow
  const [managePinFlow, setManagePinFlow] = useState<ManagePinFlow>(null)
  const [oldPin, setOldPin] = useState('')
  const [newPin1, setNewPin1] = useState('')
  const [managePinPadKey, setManagePinPadKey] = useState(0)
  const [managePinError, setManagePinError] = useState('')

  // 계좌 리셋 flow
  const [showResetPin, setShowResetPin] = useState(false)
  const [resetPinKey, setResetPinKey] = useState(0)
  const [resetError, setResetError] = useState('')
  const [resetWorking, setResetWorking] = useState(false)

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
    } catch { /* silent */ }
    finally { setOrdersLoading(false) }
  }, [])

  const fetchPendingOrders = useCallback(async () => {
    setPendingLoading(true)
    try {
      const res = await axios.get('http://localhost:3000/api/trade/virtual/orders/pending', { withCredentials: true })
      setPendingOrders(res.data)
    } catch { /* silent */ }
    finally { setPendingLoading(false) }
  }, [])

  useEffect(() => {
    fetchPortfolio()
    axios.get('http://localhost:3000/api/auth/me', { withCredentials: true })
      .then(r => setIsPhoneVerified(!!r.data.is_phone_verified))
      .catch(() => setIsPhoneVerified(false))
  }, [fetchPortfolio])

  // 실시간 가격 업데이트 — 보유 종목 구독
  useEffect(() => {
    if (!portfolio || portfolio.holdings.length === 0) return

    const socket = io('http://localhost:3000')
    socketRef.current = socket
    const holdingCodes = new Set(portfolio.holdings.map(h => h.code))

    const subscribeAll = () => {
      portfolio.holdings.forEach(h => socket.emit('subscribe:stock', h.code))
    }

    socket.on('connect', subscribeAll)
    if (socket.connected) subscribeAll()

    socket.on('stock:price', (data: { code: string; price: number }) => {
      if (!holdingCodes.has(data.code)) return
      setPortfolio(prev => {
        if (!prev) return prev
        const idx = prev.holdings.findIndex(h => h.code === data.code)
        if (idx === -1) return prev
        const holdings = prev.holdings.map((h, i) => {
          if (i !== idx) return h
          const evalAmount = h.quantity * data.price
          const costBasis  = h.quantity * Number(h.avg_price)
          const pnl        = evalAmount - costBasis
          const pnlRate    = costBasis > 0 ? (pnl / costBasis) * 100 : 0
          return { ...h, currentPrice: data.price, evalAmount, pnl, pnlRate }
        })
        const totalEval  = holdings.reduce((s, h) => s + h.evalAmount, 0)
        const totalAsset = prev.balance + totalEval
        const totalPnl   = holdings.reduce((s, h) => s + h.pnl, 0)
        const totalCost  = holdings.reduce((s, h) => s + h.quantity * Number(h.avg_price), 0)
        const totalPnlRate = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0
        return { ...prev, holdings, totalEval, totalAsset, totalPnl, totalPnlRate }
      })
    })

    return () => {
      portfolio.holdings.forEach(h => socket.emit('unsubscribe:stock', h.code))
      socket.disconnect()
    }
  }, [portfolio?.holdings.map(h => h.code).join(',')])

  useEffect(() => {
    if (tab === 'orders'  && portfolio) fetchOrders()
    if (tab === 'pending' && portfolio) fetchPendingOrders()
  }, [tab, portfolio, fetchOrders, fetchPendingOrders])

  // ── 계좌 개설 PIN flow ────────────────────────────────────────

  const startAccountOpening = () => {
    setPinError('')
    setPinFlow('set1')
    setPinPadKey(k => k + 1)
  }

  const handlePinInput = async (pin: string) => {
    if (pinFlow === 'set1') {
      setTempPin(pin)
      setPinFlow('set2')
      setPinPadKey(k => k + 1)
    } else if (pinFlow === 'set2') {
      if (pin !== tempPin) {
        setPinError('PIN이 일치하지 않습니다. 다시 설정해주세요.')
        setTempPin('')
        setPinFlow('set1')
        setPinPadKey(k => k + 1)
        return
      }
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

  // ── PIN 변경 flow ──────────────────────────────────────────────

  const startChangePin = () => {
    setManagePinError('')
    setOldPin('')
    setNewPin1('')
    setManagePinFlow('old')
    setManagePinPadKey(k => k + 1)
  }

  const handleChangePinInput = async (pin: string) => {
    if (managePinFlow === 'old') {
      setOldPin(pin)
      setManagePinFlow('new1')
      setManagePinPadKey(k => k + 1)
    } else if (managePinFlow === 'new1') {
      setNewPin1(pin)
      setManagePinFlow('new2')
      setManagePinPadKey(k => k + 1)
    } else if (managePinFlow === 'new2') {
      if (pin !== newPin1) {
        setManagePinError('새 PIN이 일치하지 않습니다.')
        setNewPin1('')
        setManagePinFlow('new1')
        setManagePinPadKey(k => k + 1)
        return
      }
      try {
        await axios.post(
          'http://localhost:3000/api/trade/virtual/pin/change',
          { oldPin, newPin: pin },
          { withCredentials: true }
        )
        setManagePinFlow(null)
        setManagePinError('')
        alert('PIN이 변경되었습니다.')
      } catch (err: any) {
        setManagePinError(err.response?.data?.message ?? 'PIN 변경에 실패했습니다')
        setOldPin('')
        setNewPin1('')
        setManagePinFlow('old')
        setManagePinPadKey(k => k + 1)
      }
    }
  }

  // ── 계좌 리셋 flow ────────────────────────────────────────────

  const startReset = () => {
    setResetError('')
    setShowResetPin(true)
    setResetPinKey(k => k + 1)
  }

  const handleResetPin = async (pin: string) => {
    setResetWorking(true)
    try {
      await axios.post(
        'http://localhost:3000/api/trade/virtual/account/reset',
        { pin },
        { withCredentials: true }
      )
      setShowResetPin(false)
      setResetError('')
      setLoading(true)
      fetchPortfolio()
    } catch (err: any) {
      setResetError(err.response?.data?.message ?? '초기화에 실패했습니다')
      setResetPinKey(k => k + 1)
    } finally {
      setResetWorking(false)
    }
  }

  // ── 미체결 주문 취소 ───────────────────────────────────────────

  const handleCancelOrder = async (orderId: number) => {
    try {
      await axios.delete(
        `http://localhost:3000/api/trade/virtual/orders/${orderId}`,
        { withCredentials: true }
      )
      fetchPendingOrders()
      fetchPortfolio()
    } catch (err: any) {
      alert(err.response?.data?.message ?? '취소에 실패했습니다')
    }
  }

  // ── Render: loading ──────────────────────────────────────────

  if (loading) return (
    <div style={{ color: '#9ca3af', padding: '40px', textAlign: 'center', fontSize: '14px' }}>
      불러오는 중...
    </div>
  )

  // ── Render: no account ───────────────────────────────────────

  if (noAccount) {
    if (isPhoneVerified === false) {
      return (
        <div style={{ textAlign: 'center', padding: '48px 20px' }}>
          <div style={{ width: '64px', height: '64px', borderRadius: '20px', backgroundColor: '#fff7ed', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '28px', marginBottom: '20px' }}>
            🔐
          </div>
          <p style={{ fontWeight: '800', fontSize: '18px', marginBottom: '8px', color: '#111' }}>
            휴대폰 인증 후 이용 가능합니다
          </p>
          <p style={{ fontSize: '13px', color: '#6b7280', marginBottom: '24px', lineHeight: '1.6' }}>
            모의투자 계좌 개설을 위해<br />먼저 휴대폰 인증을 완료해주세요.
          </p>
          <button
            onClick={() => navigate('/mypage')}
            style={{ padding: '12px 28px', backgroundColor: '#22C55E', color: '#fff', border: 'none', borderRadius: '12px', fontWeight: '700', fontSize: '14px', cursor: 'pointer', boxShadow: '0 4px 12px rgba(34,197,94,0.3)' }}
          >
            마이페이지에서 인증하기
          </button>
        </div>
      )
    }

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
        <div style={{ width: '64px', height: '64px', borderRadius: '20px', backgroundColor: '#f0fdf4', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '28px', marginBottom: '20px' }}>
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
          style={{ marginTop: '8px', padding: '12px 28px', backgroundColor: '#22C55E', color: '#fff', border: 'none', borderRadius: '12px', fontWeight: '700', fontSize: '14px', cursor: 'pointer', boxShadow: '0 4px 12px rgba(34,197,94,0.3)' }}
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

  const totalReturn = portfolio.initialBalance > 0
    ? ((portfolio.totalAsset - portfolio.initialBalance) / portfolio.initialBalance) * 100
    : 0
  const isProfit = portfolio.totalPnl >= 0

  return (
    <div>
      {/* ── PIN 변경 모달 ── */}
      {managePinFlow && (() => {
        const titles: Record<NonNullable<ManagePinFlow>, string> = {
          old:  '현재 PIN 입력',
          new1: '새 PIN 설정 (1/2)',
          new2: '새 PIN 확인 (2/2)',
        }
        const subtitles: Record<NonNullable<ManagePinFlow>, string> = {
          old:  '기존 6자리 PIN을 입력하세요',
          new1: '새로 사용할 6자리 PIN을 입력하세요',
          new2: '확인을 위해 새 PIN을 다시 입력하세요',
        }
        return (
          <PinPad
            key={managePinPadKey}
            title={titles[managePinFlow]}
            subtitle={managePinError || subtitles[managePinFlow]}
            onConfirm={handleChangePinInput}
            onCancel={() => { setManagePinFlow(null); setManagePinError('') }}
          />
        )
      })()}

      {/* ── 계좌 리셋 모달 ── */}
      {showResetPin && (
        <PinPad
          key={resetPinKey}
          title="계좌 초기화 확인"
          subtitle={resetError || 'PIN을 입력하면 계좌가 초기 상태로 리셋됩니다'}
          onConfirm={handleResetPin}
          onCancel={() => { setShowResetPin(false); setResetError('') }}
        />
      )}

      {/* ── 자산 요약 ── */}
      <div style={{
        background: isProfit
          ? 'linear-gradient(135deg, #fef2f2 0%, #fee2e2 100%)'
          : 'linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%)',
        borderRadius: '20px',
        padding: '24px 28px',
        marginBottom: '16px',
        position: 'relative',
        overflow: 'hidden',
      }}>
        <div style={{ position: 'absolute', right: '-30px', top: '-30px', width: '140px', height: '140px', borderRadius: '50%', backgroundColor: isProfit ? 'rgba(220,38,38,0.06)' : 'rgba(59,130,246,0.08)' }} />
        <p style={{ fontSize: '12px', fontWeight: '600', color: '#6b7280', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          총 자산
        </p>
        <p style={{ fontSize: '28px', fontWeight: '900', color: '#111', marginBottom: '16px' }}>
          ₩{portfolio.totalAsset.toLocaleString()}
        </p>
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
          <div>
            <p style={{ fontSize: '11px', color: '#9ca3af', marginBottom: '2px' }}>총수익률</p>
            <p style={{ fontSize: '16px', fontWeight: '700', color: totalReturn >= 0 ? '#dc2626' : '#2563eb' }}>
              {totalReturn >= 0 ? '+' : ''}{totalReturn.toFixed(2)}%
            </p>
          </div>
        </div>
      </div>

      {/* ── 관리 버튼 ── */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        <button
          onClick={startChangePin}
          style={{ flex: 1, padding: '9px 12px', border: '1.5px solid #e5e7eb', borderRadius: '10px', backgroundColor: '#fff', fontSize: '12px', fontWeight: '700', color: '#374151', cursor: 'pointer' }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = '#22C55E'; e.currentTarget.style.color = '#15803d' }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = '#e5e7eb'; e.currentTarget.style.color = '#374151' }}
        >
          🔑 PIN 변경
        </button>
        <button
          onClick={() => {
            if (window.confirm('계좌를 초기화하면 모든 보유종목과 거래내역이 사라지고 1,000만 원으로 리셋됩니다. 계속하시겠습니까?')) {
              startReset()
            }
          }}
          style={{ flex: 1, padding: '9px 12px', border: '1.5px solid #fecaca', borderRadius: '10px', backgroundColor: '#fff', fontSize: '12px', fontWeight: '700', color: '#dc2626', cursor: 'pointer' }}
          onMouseEnter={e => { e.currentTarget.style.backgroundColor = '#fef2f2' }}
          onMouseLeave={e => { e.currentTarget.style.backgroundColor = '#fff' }}
        >
          🔄 계좌 초기화
        </button>
      </div>

      {/* ── 탭 ── */}
      <div style={{ display: 'flex', gap: '4px', backgroundColor: '#f3f4f6', borderRadius: '14px', padding: '4px', marginBottom: '20px' }}>
        {(['holdings', 'pending', 'orders'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              flex: 1,
              padding: '9px',
              border: 'none',
              borderRadius: '10px',
              fontSize: '12px',
              fontWeight: '700',
              cursor: 'pointer',
              transition: 'all 0.18s ease',
              backgroundColor: tab === t ? '#fff' : 'transparent',
              color: tab === t ? '#111' : '#9ca3af',
              boxShadow: tab === t ? '0 1px 4px rgba(0,0,0,0.08)' : 'none',
              position: 'relative',
            }}
          >
            {t === 'holdings'
              ? `보유종목${portfolio.holdings.length > 0 ? ` (${portfolio.holdings.length})` : ''}`
              : t === 'pending'
              ? `미체결${pendingOrders.length > 0 ? ` (${pendingOrders.length})` : ''}`
              : '거래내역'}
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
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#fafafa', borderRadius: '14px', padding: '16px 18px', border: '1px solid #f3f4f6', cursor: 'pointer', transition: 'all 0.15s ease' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.backgroundColor = '#f0fdf4'; (e.currentTarget as HTMLDivElement).style.borderColor = '#bbf7d0' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.backgroundColor = '#fafafa'; (e.currentTarget as HTMLDivElement).style.borderColor = '#f3f4f6' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div style={{ width: '38px', height: '38px', borderRadius: '10px', backgroundColor: up ? '#fef2f2' : '#eff6ff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px', color: up ? '#dc2626' : '#2563eb', flexShrink: 0 }}>
                      {up ? '▲' : '▼'}
                    </div>
                    <div>
                      <p style={{ fontWeight: '700', fontSize: '14px', color: '#111', marginBottom: '2px' }}>
                        {formatStockName(h.name)}
                        {h.pending_sell > 0 && (
                          <span style={{ fontSize: '10px', marginLeft: '6px', color: '#9ca3af', fontWeight: '500' }}>
                            (매도대기 {h.pending_sell}주)
                          </span>
                        )}
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
                    <p style={{ fontSize: '12px', fontWeight: '700', color: up ? '#dc2626' : '#2563eb' }}>
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

      {/* ── 미체결 탭 ── */}
      {tab === 'pending' && (
        pendingLoading ? (
          <div style={{ textAlign: 'center', padding: '40px', color: '#9ca3af', fontSize: '13px' }}>불러오는 중...</div>
        ) : pendingOrders.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px', color: '#9ca3af', fontSize: '13px', backgroundColor: '#f9fafb', borderRadius: '16px' }}>
            미체결 주문이 없습니다
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {pendingOrders.map(o => {
              const isBuy = o.side === 'buy'
              return (
                <div
                  key={o.id}
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#fafafa', borderRadius: '14px', padding: '14px 18px', border: '1px solid #f3f4f6' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div style={{ width: '34px', height: '34px', borderRadius: '9px', backgroundColor: isBuy ? '#fef2f2' : '#eff6ff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: '800', color: isBuy ? '#dc2626' : '#2563eb', flexShrink: 0 }}>
                      {isBuy ? '매수' : '매도'}
                    </div>
                    <div>
                      <p style={{ fontWeight: '700', fontSize: '13px', color: '#111', marginBottom: '2px' }}>
                        {formatStockName(o.stock_name)}
                        <span style={{ fontSize: '10px', color: '#f59e0b', fontWeight: '700', marginLeft: '6px', backgroundColor: '#fffbeb', padding: '1px 5px', borderRadius: '4px' }}>
                          지정가 대기중
                        </span>
                      </p>
                      <p style={{ fontSize: '11px', color: '#9ca3af' }}>
                        {o.quantity}주 · 지정가 ₩{Number(o.price).toLocaleString()} · {o.ordered_at}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => handleCancelOrder(o.id)}
                    style={{ padding: '6px 12px', border: '1.5px solid #fecaca', borderRadius: '8px', backgroundColor: '#fff', fontSize: '11px', fontWeight: '700', color: '#dc2626', cursor: 'pointer', flexShrink: 0 }}
                    onMouseEnter={e => { e.currentTarget.style.backgroundColor = '#fef2f2' }}
                    onMouseLeave={e => { e.currentTarget.style.backgroundColor = '#fff' }}
                  >
                    취소
                  </button>
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
              const statusColor = o.status === 'filled' ? '#16a34a' : o.status === 'cancelled' ? '#9ca3af' : '#f59e0b'
              const statusLabel = o.status === 'filled' ? '체결' : o.status === 'cancelled' ? '취소' : '대기'
              return (
                <div
                  key={o.id}
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#fafafa', borderRadius: '14px', padding: '14px 18px', border: '1px solid #f3f4f6' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div style={{ width: '34px', height: '34px', borderRadius: '9px', backgroundColor: isBuy ? '#fef2f2' : '#eff6ff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: '800', color: isBuy ? '#dc2626' : '#2563eb', flexShrink: 0 }}>
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
                    <p style={{ fontSize: '11px', fontWeight: '600', color: statusColor }}>
                      {statusLabel}
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
