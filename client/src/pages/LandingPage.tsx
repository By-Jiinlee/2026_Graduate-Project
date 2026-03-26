export default function LandingPage() {
  return (
    <div style={{ fontFamily: 'sans-serif' }}>

      {/* 히어로 섹션 */}
      <section style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '80px 120px',
        backgroundColor: '#f9fafb',
      }}>
        <div>
          <h1 style={{ fontSize: '42px', fontWeight: 'bold', color: '#111', lineHeight: 1.3 }}>
            투자의 기준을 높이다,<br />
            <span style={{ color: '#3CB371' }}>UpTick</span>
          </h1>
          <p style={{ fontSize: '16px', color: '#666', marginTop: '16px', marginBottom: '32px' }}>
            실시간 시장 데이터와 AI 분석으로<br />더 스마트한 투자를 시작하세요.
          </p>
          <button style={{
            backgroundColor: '#3CB371',
            color: 'white',
            padding: '14px 32px',
            borderRadius: '8px',
            border: 'none',
            fontSize: '16px',
            fontWeight: '600',
            cursor: 'pointer',
          }}>
            시작하기
          </button>
        </div>

        {/* 오른쪽 장식 */}
        <div style={{
          width: '420px',
          height: '280px',
          backgroundColor: '#e8f5e9',
          borderRadius: '16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '80px',
        }}>
          📈
        </div>
      </section>

      {/* 지수 티커 바 */}
      <section style={{
        display: 'flex',
        justifyContent: 'space-around',
        padding: '24px 120px',
        backgroundColor: '#ffffff',
        borderTop: '1px solid #eee',
        borderBottom: '1px solid #eee',
      }}>
        {[
          { name: 'KOSPI', value: '2,466.05', change: '+0.32%', up: true },
          { name: 'KOSDAQ', value: '5,407.24', change: '+1.12%', up: true },
          { name: 'S&P 500', value: '812.33', change: '-0.05%', up: false },
          { name: 'NASDAQ', value: '2,001.81', change: '+0.87%', up: true },
          { name: 'DOW', value: '5,001.67', change: '-0.21%', up: false },
        ].map(item => (
          <div key={item.name} style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '13px', color: '#888' }}>{item.name}</div>
            <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#111' }}>{item.value}</div>
            <div style={{ fontSize: '13px', color: item.up ? '#3CB371' : '#e53935' }}>{item.change}</div>
          </div>
        ))}
      </section>

      {/* 시장 정보 섹션 */}
      <section style={{ padding: '60px 120px' }}>
        <h2 style={{ fontSize: '24px', fontWeight: 'bold', marginBottom: '32px' }}>시장 정보</h2>
        <div style={{ display: 'flex', gap: '24px' }}>

          {/* 차트 자리 */}
          <div style={{
            flex: 1,
            height: '200px',
            backgroundColor: '#f0f0f0',
            borderRadius: '12px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#aaa',
            fontSize: '14px',
          }}>
            KOSPI 차트 (추후 연동)
          </div>

          <div style={{
            flex: 1,
            height: '200px',
            backgroundColor: '#f0f0f0',
            borderRadius: '12px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#aaa',
            fontSize: '14px',
          }}>
            KOSDAQ 차트 (추후 연동)
          </div>
        </div>
      </section>

    </div>
  )
}