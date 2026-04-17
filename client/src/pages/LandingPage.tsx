import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { io, Socket } from 'socket.io-client'

// ─── 타입 ─────────────────────────────────────────────────────

interface IndexData {
  code: string
  name: string
  price: number
  change: number
  changeRate: number
  market: 'KR' | 'US'
  delayed?: boolean
}

// ─── 초기 지수 데이터 ─────────────────────────────────────────

const INITIAL_INDICES: Record<string, IndexData> = {
  '0001':   { code: '0001',   name: 'KOSPI',   price: 0, change: 0, changeRate: 0, market: 'KR' },
  '1001':   { code: '1001',   name: 'KOSDAQ',  price: 0, change: 0, changeRate: 0, market: 'KR' },
  'SP500':  { code: 'SP500',  name: 'S&P 500', price: 0, change: 0, changeRate: 0, market: 'US', delayed: true },
  'NASDAQ': { code: 'NASDAQ', name: 'NASDAQ',  price: 0, change: 0, changeRate: 0, market: 'US', delayed: true },
  'DOW':    { code: 'DOW',    name: 'DOW',     price: 0, change: 0, changeRate: 0, market: 'US', delayed: true },
}

const INDEX_ORDER = ['0001', '1001', 'SP500', 'NASDAQ', 'DOW']

// ─── 숫자 포맷 ────────────────────────────────────────────────

const formatPrice = (price: number): string => {
  if (price === 0) return '-'
  return price.toLocaleString('ko-KR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

const formatChangeRate = (changeRate: number): string => {
  if (changeRate === 0) return '-'
  const absRate = Math.abs(changeRate).toFixed(2)
  return `${absRate}%`
}

// ─── 컴포넌트 ─────────────────────────────────────────────────

export default function LandingPage(): React.ReactElement {
  const [indices, setIndices] = useState<Record<string, IndexData>>(INITIAL_INDICES)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const socket: Socket = io('http://localhost:3000', {
      transports: ['websocket'],
    })

    socket.on('connect', () => setConnected(true))
    socket.on('disconnect', () => setConnected(false))

    socket.on('index:price', (data: IndexData) => {
      setIndices((prev) => ({
        ...prev,
        [data.code]: data,
      }))
    })

    return () => {
      socket.disconnect()
    }
  }, [])

  return (
    <div style={{ fontFamily: 'sans-serif' }}>
      {/* 히어로 섹션 */}
      <section
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '80px 120px',
          backgroundColor: '#f9fafb',
        }}
      >
        <div>
          <h1
            style={{
              fontSize: '42px',
              fontWeight: 'bold',
              color: '#111',
              lineHeight: 1.3,
            }}
          >
            투자의 기준을 높이다,
            <br />
            <span style={{ color: '#22C55E' }}>UpTick</span>
          </h1>
          <p
            style={{
              fontSize: '16px',
              color: '#666',
              marginTop: '16px',
              marginBottom: '32px',
            }}
          >
            실시간 시장 데이터와 AI 분석으로
            <br />더 스마트한 투자를 시작하세요.
          </p>

          <Link to="/auth" style={{ textDecoration: 'none' }}>
            <button
              style={{
                backgroundColor: '#22C55E',
                color: 'white',
                padding: '14px 32px',
                borderRadius: '8px',
                border: 'none',
                fontSize: '16px',
                fontWeight: '600',
                cursor: 'pointer',
                display: 'inline-block',
              }}
            >
              시작하기
            </button>
          </Link>
        </div>

        {/* 오른쪽 이미지 */}
        <div
          style={{
            width: '500px',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <img
            src="/main.png"
            alt="UpTick 메인 이미지"
            style={{
              width: '100%',
              height: 'auto',
              borderRadius: '16px',
              objectFit: 'contain',
            }}
          />
        </div>
      </section>

      {/* 지수 티커 바 */}
      <section
        style={{
          display: 'flex',
          justifyContent: 'space-around',
          alignItems: 'center',
          padding: '24px 120px',
          backgroundColor: '#ffffff',
          borderTop: '1px solid #eee',
          borderBottom: '1px solid #eee',
          position: 'relative',
        }}
      >
        {INDEX_ORDER.map((code) => {
          const item = indices[code]
          const isUp = item.change >= 0
          const hasData = item.price !== 0

          return (
            <div key={code} style={{ textAlign: 'left', minWidth: '120px' }}>
              {/* 지수명 */}
              <div style={{ fontSize: '13px', color: '#888', marginBottom: '4px' }}>
                {item.name}
                {item.delayed && (
                  <span style={{ fontSize: '10px', color: '#bbb', marginLeft: '4px' }}>
                    15분지연
                  </span>
                )}
              </div>

              {/* 현재가 */}
              <div
                style={{
                  fontSize: '22px',
                  fontWeight: 'bold',
                  color: '#111',
                  marginBottom: '4px',
                }}
              >
                {formatPrice(item.price)}
              </div>

              {/* 화살표 + % */}
              {hasData ? (
                <div
                  style={{
                    fontSize: '13px',
                    color: isUp ? '#3CB371' : '#e53935',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '3px',
                  }}
                >
                  <span>{isUp ? '▲' : '▼'}</span>
                  <span>{formatChangeRate(item.changeRate)}</span>
                </div>
              ) : (
                <div style={{ fontSize: '13px', color: '#ccc' }}>-</div>
              )}
            </div>
          )
        })}

        {/* 연결 상태 */}
        <div style={{ position: 'absolute', right: '24px', top: '12px' }}>
          <span
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              backgroundColor: connected ? '#22C55E' : '#ccc',
              display: 'inline-block',
            }}
          />
        </div>
      </section>

      {/* 시장 정보 섹션 */}
      <section style={{ padding: '60px 120px' }}>
        <h2 style={{ fontSize: '24px', fontWeight: 'bold', marginBottom: '32px' }}>
          시장 정보
        </h2>
        <div style={{ display: 'flex', gap: '24px' }}>
          <div
            style={{
              flex: 1,
              height: '200px',
              backgroundColor: '#f0f0f0',
              borderRadius: '12px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#aaa',
            }}
          >
            KOSPI 차트 (추후 연동)
          </div>
          <div
            style={{
              flex: 1,
              height: '200px',
              backgroundColor: '#f0f0f0',
              borderRadius: '12px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#aaa',
            }}
          >
            KOSDAQ 차트 (추후 연동)
          </div>
        </div>
      </section>
    </div>
  )
}