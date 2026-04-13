import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import { createWalletClient, custom, keccak256, concat, toBytes, getAddress } from 'viem'
import { sepolia } from 'viem/chains'
import { useTradeModeStore } from '../../store/tradeModeStore'
import PinPad from './PinPad'

interface Props {
  stockId: number
  stockCode: string
  stockName: string
  currentPrice: number
}

type OrderType = 'market' | 'limit'
type Side = 'buy' | 'sell'

const isLoggedIn = () => document.cookie.split(';').some(c => c.trim().startsWith('isLoggedIn=true'))

export default function OrderPanel({ stockId, stockCode, stockName, currentPrice }: Props) {
  const { mode } = useTradeModeStore()
  const navigate = useNavigate()

  const [side, setSide] = useState<Side>('buy')
  const [orderType, setOrderType] = useState<OrderType>('market')
  const [quantity, setQuantity] = useState('')
  const [limitPrice, setLimitPrice] = useState('')
  const [showPin, setShowPin] = useState(false)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const [isPhoneVerified, setIsPhoneVerified] = useState<boolean | null>(null)

  useEffect(() => {
    if (!isLoggedIn()) return
    axios.get('http://localhost:3000/api/auth/me', { withCredentials: true })
      .then(res => setIsPhoneVerified(!!res.data.is_phone_verified))
      .catch(() => setIsPhoneVerified(false))
  }, [])

  const price = orderType === 'market' ? currentPrice : Number(limitPrice)
  const totalCost = price * Number(quantity)
  const fee = Math.floor(totalCost * 0.00015)
  const total = side === 'buy' ? totalCost + fee : totalCost - fee

  const handleOrderClick = () => {
    if (!quantity || Number(quantity) <= 0) {
      setMessage({ text: '수량을 입력해주세요', ok: false })
      return
    }
    if (orderType === 'limit' && (!limitPrice || Number(limitPrice) <= 0)) {
      setMessage({ text: '지정가를 입력해주세요', ok: false })
      return
    }
    setMessage(null)
    setShowPin(true)
  }

  const handlePinConfirm = async (pin: string) => {
    setShowPin(false)
    setLoading(true)
    setMessage(null)

    try {
      const endpoint = side === 'buy' ? '/api/trade/virtual/buy' : '/api/trade/virtual/sell'
      let tradeSignature: string | undefined

      // 1차 시도 — 서명 없이
      try {
        const res = await axios.post(
          `http://localhost:3000${endpoint}`,
          { stockId, stockCode, quantity: Number(quantity), orderType, limitPrice: limitPrice ? Number(limitPrice) : undefined, pin },
          { withCredentials: true },
        )
        setMessage({ text: res.data.message, ok: true })
        setQuantity('')
        return
      } catch (err: any) {
        if (err.response?.data?.message !== 'LARGE_ORDER') throw err
      }

      // 고액 거래 — MetaMask 서명
      setMessage({ text: '고액 거래입니다. MetaMask 서명을 진행해주세요...', ok: false })

      if (!window.ethereum) throw new Error('MetaMask가 설치되어 있지 않습니다')

      const walletClient = createWalletClient({ chain: sepolia, transport: custom(window.ethereum) })
      const [address] = await walletClient.requestAddresses()

      const nonceRes = await axios.get(
        `http://localhost:3000/api/auth/trade-nonce?address=${address}`,
        { withCredentials: true },
      )
      const nonce = BigInt(nonceRes.data.nonce)
      const contractAddress = getAddress(import.meta.env.VITE_CONTRACT_AUTH_ADDRESS as string)
      const amount = BigInt(Math.round(price * Number(quantity)))

      const msgHash = keccak256(
        concat([
          toBytes(BigInt(sepolia.id), { size: 32 }),
          toBytes(contractAddress,    { size: 20 }),
          toBytes(address,            { size: 20 }),
          toBytes(nonce,              { size: 32 }),
          toBytes(amount,             { size: 32 }),
          new TextEncoder().encode(stockCode),
        ])
      )

      tradeSignature = await walletClient.signMessage({ account: address, message: { raw: msgHash } })

      const res = await axios.post(
        `http://localhost:3000${endpoint}`,
        { stockId, stockCode, quantity: Number(quantity), orderType, limitPrice: limitPrice ? Number(limitPrice) : undefined, pin, tradeSignature, signedAmount: amount.toString() },
        { withCredentials: true },
      )
      setMessage({ text: res.data.message, ok: true })
      setQuantity('')
    } catch (err: any) {
      setMessage({ text: err.response?.data?.message ?? err.message ?? '주문 실패', ok: false })
    } finally {
      setLoading(false)
    }
  }

  if (!isLoggedIn()) {
    return (
      <div style={{
        backgroundColor: '#fff',
        border: '1px solid #e5e7eb',
        borderRadius: '20px',
        padding: '36px 24px',
        textAlign: 'center',
      }}>
        <p style={{ fontSize: '28px', marginBottom: '12px' }}>🔒</p>
        <p style={{ fontWeight: '700', fontSize: '15px', color: '#111', marginBottom: '6px' }}>로그인 후 이용 가능합니다</p>
        <p style={{ fontSize: '13px', color: '#9ca3af', marginBottom: '20px' }}>주문 서비스는 로그인이 필요해요</p>
        <button
          onClick={() => navigate('/login')}
          style={{
            padding: '10px 28px',
            backgroundColor: '#22C55E',
            color: '#fff',
            border: 'none',
            borderRadius: '10px',
            fontWeight: '700',
            fontSize: '14px',
            cursor: 'pointer',
          }}
        >
          로그인하기
        </button>
      </div>
    )
  }

  if (isLoggedIn() && isPhoneVerified === false) {
    return (
      <div style={{
        backgroundColor: '#fff',
        border: '1px solid #e5e7eb',
        borderRadius: '20px',
        padding: '36px 24px',
        textAlign: 'center',
      }}>
        <p style={{ fontSize: '28px', marginBottom: '12px' }}>📵</p>
        <p style={{ fontWeight: '700', fontSize: '15px', color: '#111', marginBottom: '6px' }}>휴대폰 인증이 필요합니다</p>
        <p style={{ fontSize: '13px', color: '#9ca3af', marginBottom: '20px' }}>
          실거래 및 모의투자는<br />휴대폰 인증 완료 후 이용 가능합니다
        </p>
        <button
          onClick={() => navigate('/mypage')}
          style={{
            padding: '10px 28px',
            backgroundColor: '#22C55E',
            color: '#fff',
            border: 'none',
            borderRadius: '10px',
            fontWeight: '700',
            fontSize: '14px',
            cursor: 'pointer',
          }}
        >
          인증하러 가기
        </button>
      </div>
    )
  }

  if (mode === 'real') {
    return (
      <div style={{
        backgroundColor: '#fff7ed',
        border: '1px solid #fed7aa',
        borderRadius: '20px',
        padding: '24px',
        textAlign: 'center',
      }}>
        <p style={{ color: '#c2410c', fontWeight: '700', fontSize: '14px' }}>💼 실거래 모드</p>
        <p style={{ color: '#9ca3af', fontSize: '13px', marginTop: '8px' }}>실거래 기능은 준비 중입니다</p>
      </div>
    )
  }

  return (
    <>
      {showPin && (
        <PinPad
          title={`${side === 'buy' ? '매수' : '매도'} PIN 확인`}
          subtitle={`${stockName} · ${quantity}주 · ₩${total.toLocaleString()}`}
          onConfirm={handlePinConfirm}
          onCancel={() => setShowPin(false)}
        />
      )}

      <div style={{
        backgroundColor: '#fff',
        border: '1px solid #e5e7eb',
        borderRadius: '20px',
        overflow: 'hidden',
      }}>
        {/* 매수/매도 탭 */}
        <div style={{ display: 'flex' }}>
          {(['buy', 'sell'] as Side[]).map(s => (
            <button
              key={s}
              onClick={() => setSide(s)}
              style={{
                flex: 1,
                padding: '14px',
                border: 'none',
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: '700',
                backgroundColor: side === s ? (s === 'buy' ? '#ef4444' : '#3b82f6') : '#f9fafb',
                color: side === s ? '#fff' : '#9ca3af',
                transition: 'all 0.2s',
                borderBottom: `2px solid ${side === s ? (s === 'buy' ? '#ef4444' : '#3b82f6') : '#f3f4f6'}`,
              }}
            >
              {s === 'buy' ? '매수' : '매도'}
            </button>
          ))}
        </div>

        <div style={{ padding: '20px' }}>
          {/* 모의투자 뱃지 + 종목명 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '18px' }}>
            <span style={{ fontSize: '11px', fontWeight: '700', color: '#15803d', backgroundColor: '#f0fdf4', padding: '2px 8px', borderRadius: '999px', border: '1px solid #bbf7d0' }}>
              모의투자
            </span>
            <span style={{ fontSize: '13px', color: '#6b7280', fontWeight: '500' }}>{stockName}</span>
          </div>

          {/* 주문 유형 */}
          <div style={{ display: 'flex', gap: '6px', marginBottom: '16px' }}>
            {(['market', 'limit'] as OrderType[]).map(t => (
              <button
                key={t}
                onClick={() => setOrderType(t)}
                style={{
                  flex: 1,
                  padding: '7px',
                  borderRadius: '8px',
                  border: `1.5px solid ${orderType === t ? '#22C55E' : '#e5e7eb'}`,
                  cursor: 'pointer',
                  fontSize: '12px',
                  fontWeight: '700',
                  backgroundColor: orderType === t ? '#f0fdf4' : '#fff',
                  color: orderType === t ? '#15803d' : '#9ca3af',
                  transition: 'all 0.15s',
                }}
              >
                {t === 'market' ? '시장가' : '지정가'}
              </button>
            ))}
          </div>

          {/* 현재가 */}
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            backgroundColor: '#f9fafb',
            borderRadius: '10px',
            padding: '10px 14px',
            marginBottom: '12px',
          }}>
            <span style={{ fontSize: '12px', color: '#9ca3af' }}>현재가</span>
            <span style={{ fontSize: '15px', fontWeight: '800', color: '#111' }}>₩{currentPrice.toLocaleString()}</span>
          </div>

          {/* 지정가 입력 */}
          {orderType === 'limit' && (
            <div style={{ marginBottom: '12px' }}>
              <label style={{ fontSize: '11px', color: '#9ca3af', fontWeight: '600', display: 'block', marginBottom: '5px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>지정가 (원)</label>
              <input
                type="number"
                value={limitPrice}
                onChange={e => setLimitPrice(e.target.value)}
                placeholder="0"
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  border: '1.5px solid #e5e7eb',
                  borderRadius: '10px',
                  fontSize: '15px',
                  fontWeight: '700',
                  outline: 'none',
                  boxSizing: 'border-box',
                  textAlign: 'right',
                  color: '#111',
                }}
                onFocus={e => (e.currentTarget.style.borderColor = '#22C55E')}
                onBlur={e => (e.currentTarget.style.borderColor = '#e5e7eb')}
              />
            </div>
          )}

          {/* 수량 */}
          <div style={{ marginBottom: '12px' }}>
            <label style={{ fontSize: '11px', color: '#9ca3af', fontWeight: '600', display: 'block', marginBottom: '5px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>수량 (주)</label>
            <div style={{ display: 'flex', alignItems: 'center', border: '1.5px solid #e5e7eb', borderRadius: '10px', overflow: 'hidden' }}>
              <button
                onClick={() => setQuantity(q => String(Math.max(0, Number(q) - 1)))}
                style={{ padding: '10px 14px', border: 'none', background: '#f9fafb', color: '#374151', fontSize: '18px', fontWeight: '300', cursor: 'pointer' }}
              >−</button>
              <input
                type="number"
                value={quantity}
                onChange={e => setQuantity(e.target.value)}
                placeholder="0"
                min="1"
                style={{
                  flex: 1,
                  padding: '10px 0',
                  border: 'none',
                  fontSize: '15px',
                  fontWeight: '700',
                  outline: 'none',
                  textAlign: 'center',
                  color: '#111',
                }}
              />
              <button
                onClick={() => setQuantity(q => String(Number(q) + 1))}
                style={{ padding: '10px 14px', border: 'none', background: '#f9fafb', color: '#374151', fontSize: '18px', fontWeight: '300', cursor: 'pointer' }}
              >+</button>
            </div>
          </div>

          {/* 예상 금액 요약 */}
          {quantity && Number(quantity) > 0 && (
            <div style={{ borderRadius: '10px', border: '1px solid #f3f4f6', overflow: 'hidden', marginBottom: '14px' }}>
              {[
                { label: '주문금액', value: `₩${totalCost.toLocaleString()}` },
                { label: '수수료 (0.015%)', value: `₩${fee.toLocaleString()}` },
              ].map(({ label, value }) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', fontSize: '12px', borderBottom: '1px solid #f3f4f6' }}>
                  <span style={{ color: '#9ca3af' }}>{label}</span>
                  <span style={{ fontWeight: '600', color: '#374151' }}>{value}</span>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 12px', fontSize: '13px', backgroundColor: '#f9fafb' }}>
                <span style={{ fontWeight: '700', color: '#111' }}>최종 {side === 'buy' ? '결제' : '수령'}</span>
                <span style={{ fontWeight: '800', color: side === 'buy' ? '#ef4444' : '#3b82f6', fontSize: '15px' }}>
                  ₩{total.toLocaleString()}
                </span>
              </div>
            </div>
          )}

          {/* 피드백 메시지 */}
          {message && (
            <div style={{
              padding: '9px 12px',
              borderRadius: '8px',
              marginBottom: '12px',
              fontSize: '12px',
              fontWeight: '600',
              backgroundColor: message.ok ? '#f0fdf4' : '#fef2f2',
              color: message.ok ? '#15803d' : '#dc2626',
              border: `1px solid ${message.ok ? '#bbf7d0' : '#fecaca'}`,
            }}>
              {message.text}
            </div>
          )}

          {/* 주문 버튼 */}
          <button
            onClick={handleOrderClick}
            disabled={loading}
            style={{
              width: '100%',
              padding: '14px',
              borderRadius: '12px',
              border: 'none',
              cursor: loading ? 'not-allowed' : 'pointer',
              fontSize: '15px',
              fontWeight: '800',
              backgroundColor: loading ? '#e5e7eb' : (side === 'buy' ? '#ef4444' : '#3b82f6'),
              color: loading ? '#9ca3af' : '#fff',
              transition: 'all 0.15s',
              letterSpacing: '0.02em',
            }}
            onMouseEnter={e => { if (!loading) e.currentTarget.style.opacity = '0.88' }}
            onMouseLeave={e => { e.currentTarget.style.opacity = '1' }}
          >
            {loading ? '처리 중...' : `${side === 'buy' ? '매수' : '매도'} 주문`}
          </button>
        </div>
      </div>
    </>
  )
}
