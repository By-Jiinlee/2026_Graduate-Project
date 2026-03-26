import { useState } from 'react'

export default function Events() {
  const [activeTab, setActiveTab] = useState('전체')
  const tabs = ['전체', '진행중', '종료된 이벤트']

  const events = [
    {
      id: 1,
      title: '신규 가입 환영 이벤트',
      status: '진행중',
      desc: '가입 후 첫 거래 시 수수료 면제',
      color: '#e8f5e9',
    },
    {
      id: 2,
      title: '친구 초대 리워드',
      status: '진행중',
      desc: '친구 초대 1명당 포인트 5,000P 지급',
      color: '#e8f5e9',
    },
    {
      id: 3,
      title: '봄 시즌 특별 이벤트',
      status: '진행중',
      desc: '3월 한정 프리미엄 무료 체험',
      color: '#e8f5e9',
    },
    {
      id: 4,
      title: '연말 결산 이벤트',
      status: '종료된 이벤트',
      desc: '2023년 12월 한정 캐시백 이벤트',
      color: '#f5f5f5',
    },
    {
      id: 5,
      title: '추석 특별 혜택',
      status: '종료된 이벤트',
      desc: '명절 기념 수수료 50% 할인',
      color: '#f5f5f5',
    },
    {
      id: 6,
      title: '여름 이벤트',
      status: '종료된 이벤트',
      desc: '여름 시즌 신규 종목 분석 리포트 무료 제공',
      color: '#f5f5f5',
    },
  ]

  const filtered =
    activeTab === '전체' ? events : events.filter((e) => e.status === activeTab)

  return (
    <div
      style={{
        fontFamily: 'sans-serif',
        minHeight: '100vh',
        backgroundColor: '#f9fafb',
        padding: '40px 120px',
      }}
    >
      <h1
        style={{ fontSize: '26px', fontWeight: 'bold', marginBottom: '28px' }}
      >
        이벤트 전체보기
      </h1>

      {/* 탭 */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '28px' }}>
        {tabs.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              padding: '9px 22px',
              borderRadius: '20px',
              border: activeTab === tab ? 'none' : '1px solid #ddd',
              backgroundColor: activeTab === tab ? '#3CB371' : '#fff',
              color: activeTab === tab ? '#fff' : '#555',
              fontWeight: activeTab === tab ? '600' : '400',
              fontSize: '13px',
              cursor: 'pointer',
            }}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* 이벤트 카드 그리드 */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: '20px',
        }}
      >
        {filtered.map((event) => (
          <div
            key={event.id}
            style={{
              backgroundColor: event.color,
              borderRadius: '16px',
              padding: '32px',
              minHeight: '160px',
              cursor: 'pointer',
              border: '1px solid #e0e0e0',
              transition: 'box-shadow 0.2s',
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.1)')
            }
            onMouseLeave={(e) => (e.currentTarget.style.boxShadow = 'none')}
          >
            <div
              style={{
                display: 'inline-block',
                fontSize: '11px',
                fontWeight: '600',
                color: event.status === '진행중' ? '#3CB371' : '#aaa',
                backgroundColor: event.status === '진행중' ? '#fff' : '#eee',
                padding: '3px 10px',
                borderRadius: '20px',
                marginBottom: '12px',
                border:
                  event.status === '진행중' ? '1px solid #3CB371' : 'none',
              }}
            >
              {event.status}
            </div>
            <div
              style={{
                fontSize: '17px',
                fontWeight: 'bold',
                color: '#222',
                marginBottom: '8px',
              }}
            >
              {event.title}
            </div>
            <div style={{ fontSize: '13px', color: '#666' }}>{event.desc}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
