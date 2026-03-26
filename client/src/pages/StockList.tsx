import { useState } from 'react'

export default function StockList() {
  const [searchQuery, setSearchQuery] = useState('')
  const [activeCategory, setActiveCategory] = useState('국내')

  const categories = {
    국내: ['전체', '코스피', '코스닥', 'ETF', '테마주'],
    해외: ['전체', '미국', '일본', '중국', '유럽'],
  }

  const stocks = [
    { name: '삼성전자', code: '005930', price: '72,000', change: '+1,200', rate: '+1.69%', up: true, volume: '12,453,210' },
    { name: 'SK하이닉스', code: '000660', price: '125,000', change: '-2,000', rate: '-1.57%', up: false, volume: '5,231,400' },
    { name: 'NAVER', code: '035420', price: '218,000', change: '+3,500', rate: '+1.63%', up: true, volume: '1,024,300' },
    { name: '카카오', code: '035720', price: '52,000', change: '-800', rate: '-1.52%', up: false, volume: '3,412,100' },
    { name: 'LG에너지솔루션', code: '373220', price: '380,000', change: '+5,000', rate: '+1.33%', up: true, volume: '872,400' },
    { name: '현대차', code: '005380', price: '198,000', change: '+2,500', rate: '+1.28%', up: true, volume: '1,543,200' },
    { name: '셀트리온', code: '068270', price: '168,000', change: '-1,500', rate: '-0.89%', up: false, volume: '987,600' },
    { name: 'POSCO홀딩스', code: '005490', price: '412,000', change: '+7,000', rate: '+1.73%', up: true, volume: '654,300' },
    { name: 'KB금융', code: '105560', price: '58,000', change: '-200', rate: '-0.34%', up: false, volume: '2,341,500' },
    { name: '삼성바이오로직스', code: '207940', price: '820,000', change: '+12,000', rate: '+1.49%', up: true, volume: '213,400' },
  ]

  const filtered = stocks.filter(s =>
    s.name.includes(searchQuery) || s.code.includes(searchQuery)
  )

  return (
    <div style={{ fontFamily: 'sans-serif', minHeight: '100vh', backgroundColor: '#f9fafb' }}>

      <div style={{ display: 'flex', height: 'calc(100vh - 60px)' }}>

        {/* 왼쪽 사이드바 */}
        <div style={{
          width: '200px',
          backgroundColor: '#fff',
          borderRight: '1px solid #eee',
          padding: '24px 16px',
          flexShrink: 0,
        }}>
          <div style={{ fontWeight: 'bold', fontSize: '15px', marginBottom: '16px', color: '#222' }}>관심서</div>

          {/* 국내/해외 토글 */}
          <div style={{ display: 'flex', marginBottom: '20px', backgroundColor: '#f5f5f5', borderRadius: '8px', padding: '3px' }}>
            {['국내', '해외'].map(cat => (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                style={{
                  flex: 1,
                  padding: '6px',
                  border: 'none',
                  borderRadius: '6px',
                  backgroundColor: activeCategory === cat ? '#3CB371' : 'transparent',
                  color: activeCategory === cat ? '#fff' : '#888',
                  fontSize: '13px',
                  fontWeight: '600',
                  cursor: 'pointer',
                }}
              >
                {cat}
              </button>
            ))}
          </div>

          {/* 카테고리 */}
          {categories[activeCategory as keyof typeof categories].map(item => (
            <div
              key={item}
              style={{
                padding: '10px 12px',
                borderRadius: '8px',
                fontSize: '14px',
                color: '#555',
                cursor: 'pointer',
                marginBottom: '2px',
              }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#f0faf4')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
            >
              {item}
            </div>
          ))}

          <hr style={{ margin: '16px 0', borderColor: '#eee' }} />

          <div style={{ fontWeight: 'bold', fontSize: '13px', marginBottom: '12px', color: '#888' }}>기타 필터</div>
          {['시가총액 상위', '거래량 상위', '상승률 상위', '하락률 상위'].map(item => (
            <div
              key={item}
              style={{
                padding: '10px 12px',
                borderRadius: '8px',
                fontSize: '13px',
                color: '#555',
                cursor: 'pointer',
                marginBottom: '2px',
              }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#f0faf4')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
            >
              {item}
            </div>
          ))}
        </div>

        {/* 메인 영역 */}
        <div style={{ flex: 1, padding: '32px 40px', overflowY: 'auto' }}>

          {/* 헤더 */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
            <h1 style={{ fontSize: '22px', fontWeight: 'bold' }}>국내종목리스트</h1>

            {/* 검색 */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              border: '1px solid #ddd',
              borderRadius: '8px',
              padding: '8px 14px',
              backgroundColor: '#fff',
              gap: '8px',
              width: '220px',
            }}>
              <input
                type="text"
                placeholder="종목명 / 코드 검색"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                style={{ border: 'none', outline: 'none', fontSize: '13px', flex: 1 }}
              />
              <span style={{ color: '#aaa' }}>🔍</span>
            </div>
          </div>

          {/* 테이블 */}
          <div style={{
            backgroundColor: '#fff',
            borderRadius: '16px',
            boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
            overflow: 'hidden',
          }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
              <thead>
                <tr style={{ backgroundColor: '#f5f5f5', color: '#888' }}>
                  {['종목명', '종목코드', '현재가', '전일대비', '등락률', '거래량'].map(h => (
                    <th key={h} style={{ padding: '14px 20px', textAlign: 'left', fontWeight: '500' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((stock, i) => (
                  <tr
                    key={stock.code}
                    style={{ borderBottom: '1px solid #f5f5f5', cursor: 'pointer' }}
                    onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#f9fafb')}
                    onMouseLeave={e => (e.currentTarget.style.backgroundColor = '#fff')}
                  >
                    <td style={{ padding: '14px 20px', fontWeight: '600', color: '#222' }}>{stock.name}</td>
                    <td style={{ padding: '14px 20px', color: '#aaa' }}>{stock.code}</td>
                    <td style={{ padding: '14px 20px', fontWeight: '600' }}>₩{stock.price}</td>
                    <td style={{ padding: '14px 20px', color: stock.up ? '#3CB371' : '#e53935' }}>{stock.change}</td>
                    <td style={{ padding: '14px 20px', color: stock.up ? '#3CB371' : '#e53935', fontWeight: '600' }}>{stock.rate}</td>
                    <td style={{ padding: '14px 20px', color: '#888' }}>{stock.volume}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

        </div>

        {/* 오른쪽 - 관심 종목 */}
        <div style={{
          width: '200px',
          backgroundColor: '#fff',
          borderLeft: '1px solid #eee',
          padding: '24px 16px',
          flexShrink: 0,
        }}>
          <div style={{ fontWeight: 'bold', fontSize: '14px', marginBottom: '16px', color: '#222' }}>
            즐겨찾는 나의 종목
          </div>
          {[
            { name: '삼성전자', rate: '+1.69%', up: true },
            { name: 'NAVER', rate: '+1.63%', up: true },
            { name: 'SK하이닉스', rate: '-1.57%', up: false },
          ].map(item => (
            <div key={item.name} style={{
              padding: '10px 0',
              borderBottom: '1px solid #f5f5f5',
              fontSize: '13px',
              display: 'flex',
              justifyContent: 'space-between',
            }}>
              <span style={{ color: '#444' }}>{item.name}</span>
              <span style={{ color: item.up ? '#3CB371' : '#e53935', fontWeight: '600' }}>{item.rate}</span>
            </div>
          ))}

          <button style={{
            width: '100%',
            marginTop: '16px',
            padding: '10px',
            backgroundColor: '#3CB371',
            color: '#fff',
            border: 'none',
            borderRadius: '8px',
            fontSize: '13px',
            fontWeight: '600',
            cursor: 'pointer',
          }}>
            + 종목 추가
          </button>
        </div>

      </div>
    </div>
  )
}