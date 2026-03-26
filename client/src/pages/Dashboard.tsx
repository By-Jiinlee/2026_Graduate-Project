export default function Dashboard() {
  return (
    <div
      style={{
        fontFamily: 'sans-serif',
        padding: '40px 60px',
        backgroundColor: '#f9fafb',
        minHeight: '100vh',
      }}
    >
      {/* 상단 요약 */}
      <section
        style={{
          backgroundColor: '#ffffff',
          borderRadius: '16px',
          padding: '32px 40px',
          marginBottom: '24px',
          boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
        }}
      >
        <div style={{ fontSize: '13px', color: '#888', marginBottom: '8px' }}>
          총 자산 평가
        </div>
        <div style={{ fontSize: '36px', fontWeight: 'bold', color: '#111' }}>
          ₩5,138,620
        </div>
        <div style={{ fontSize: '14px', color: '#3CB371', marginTop: '6px' }}>
          ▲ +3,100 (₩143,045,822) · 수익률 +3.21%
        </div>
        <div style={{ fontSize: '12px', color: '#aaa', marginTop: '4px' }}>
          기준일: 2023.09.17.2023
        </div>
      </section>

      <div style={{ display: 'flex', gap: '24px' }}>
        {/* 왼쪽 */}
        <div
          style={{
            flex: 2,
            display: 'flex',
            flexDirection: 'column',
            gap: '24px',
          }}
        >
          {/* 자산 현황 + 주식 차트 */}
          <div style={{ display: 'flex', gap: '24px' }}>
            {/* 종목별 통계 도넛 */}
            <div
              style={{
                flex: 1,
                backgroundColor: '#fff',
                borderRadius: '16px',
                padding: '24px',
                boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
              }}
            >
              <div style={{ fontWeight: 'bold', marginBottom: '16px' }}>
                종목별 통계
              </div>
              <div
                style={{
                  width: '120px',
                  height: '120px',
                  borderRadius: '50%',
                  background:
                    'conic-gradient(#3CB371 0% 40%, #81C784 40% 65%, #C8E6C9 65% 80%, #eee 80% 100%)',
                  margin: '0 auto 16px',
                }}
              />
              {[
                { label: '삼성전자', color: '#3CB371', pct: '40%' },
                { label: 'SK하이닉스', color: '#81C784', pct: '25%' },
                { label: 'NAVER', color: '#C8E6C9', pct: '15%' },
                { label: '기타', color: '#eee', pct: '20%' },
              ].map((item) => (
                <div
                  key={item.label}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    marginBottom: '6px',
                    fontSize: '13px',
                  }}
                >
                  <div
                    style={{
                      width: '10px',
                      height: '10px',
                      borderRadius: '50%',
                      backgroundColor: item.color,
                    }}
                  />
                  <span style={{ flex: 1, color: '#555' }}>{item.label}</span>
                  <span style={{ color: '#888' }}>{item.pct}</span>
                </div>
              ))}
            </div>

            {/* 주식 차트 자리 */}
            <div
              style={{
                flex: 2,
                backgroundColor: '#fff',
                borderRadius: '16px',
                padding: '24px',
                boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <div style={{ fontWeight: 'bold', marginBottom: '16px' }}>
                주식 차트
              </div>
              <div
                style={{
                  flex: 1,
                  backgroundColor: '#f5f5f5',
                  borderRadius: '8px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#bbb',
                  fontSize: '13px',
                }}
              >
                차트 (추후 연동)
              </div>
            </div>
          </div>

          {/* 보유 종목 목록 */}
          <div
            style={{
              backgroundColor: '#fff',
              borderRadius: '16px',
              padding: '24px',
              boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
            }}
          >
            <div style={{ fontWeight: 'bold', marginBottom: '16px' }}>
              보유 주식 목록
            </div>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: '14px',
              }}
            >
              <thead>
                <tr style={{ borderBottom: '1px solid #eee', color: '#888' }}>
                  {[
                    '종목명',
                    '보유수량',
                    '평균단가',
                    '현재가',
                    '평가손익',
                    '수익률',
                  ].map((h) => (
                    <th
                      key={h}
                      style={{
                        padding: '8px 12px',
                        textAlign: 'left',
                        fontWeight: '500',
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  {
                    name: '삼성전자',
                    qty: 10,
                    avg: '68,000',
                    cur: '72,000',
                    pnl: '+40,000',
                    rate: '+5.88%',
                    up: true,
                  },
                  {
                    name: 'SK하이닉스',
                    qty: 5,
                    avg: '130,000',
                    cur: '125,000',
                    pnl: '-25,000',
                    rate: '-3.85%',
                    up: false,
                  },
                  {
                    name: 'NAVER',
                    qty: 3,
                    avg: '210,000',
                    cur: '218,000',
                    pnl: '+24,000',
                    rate: '+3.81%',
                    up: true,
                  },
                  {
                    name: '카카오',
                    qty: 8,
                    avg: '55,000',
                    cur: '52,000',
                    pnl: '-24,000',
                    rate: '-5.45%',
                    up: false,
                  },
                ].map((row) => (
                  <tr
                    key={row.name}
                    style={{ borderBottom: '1px solid #f5f5f5' }}
                  >
                    <td style={{ padding: '12px' }}>{row.name}</td>
                    <td style={{ padding: '12px' }}>{row.qty}주</td>
                    <td style={{ padding: '12px' }}>₩{row.avg}</td>
                    <td style={{ padding: '12px' }}>₩{row.cur}</td>
                    <td
                      style={{
                        padding: '12px',
                        color: row.up ? '#3CB371' : '#e53935',
                      }}
                    >
                      {row.pnl}
                    </td>
                    <td
                      style={{
                        padding: '12px',
                        color: row.up ? '#3CB371' : '#e53935',
                      }}
                    >
                      {row.rate}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* 오른쪽 - 최근 거래 + 뉴스 */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            gap: '24px',
          }}
        >
          {/* 최근 거래 목록 */}
          <div
            style={{
              backgroundColor: '#fff',
              borderRadius: '16px',
              padding: '24px',
              boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
            }}
          >
            <div style={{ fontWeight: 'bold', marginBottom: '16px' }}>
              최근 거래 목록
            </div>
            {[
              {
                name: '삼성전자',
                type: '매수',
                price: '₩5,930',
                change: '+7.2%',
                up: true,
              },
              {
                name: 'SK하이닉스',
                type: '매도',
                price: '₩5,930',
                change: '-3.1%',
                up: false,
              },
              {
                name: 'NAVER',
                type: '매수',
                price: '₩5,930',
                change: '+2.8%',
                up: true,
              },
            ].map((item, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '10px 0',
                  borderBottom: '1px solid #f5f5f5',
                  fontSize: '13px',
                }}
              >
                <div>
                  <div style={{ fontWeight: '600' }}>{item.name}</div>
                  <div style={{ color: '#aaa', fontSize: '12px' }}>
                    {item.type}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div>{item.price}</div>
                  <div style={{ color: item.up ? '#3CB371' : '#e53935' }}>
                    {item.change}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* 뉴스/새소식 */}
          <div
            style={{
              backgroundColor: '#fff',
              borderRadius: '16px',
              padding: '24px',
              boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
            }}
          >
            <div style={{ fontWeight: 'bold', marginBottom: '16px' }}>
              뉴스 / 새소식
            </div>
            {[
              '삼성전자, 3분기 영업이익 전년比 300% 증가',
              'SK하이닉스 HBM 수요 급증으로 주가 상승세',
              'AI 관련주 강세, NAVER·카카오 동반 상승',
            ].map((news, i) => (
              <div
                key={i}
                style={{
                  fontSize: '13px',
                  color: '#444',
                  padding: '10px 0',
                  borderBottom: '1px solid #f5f5f5',
                  lineHeight: '1.5',
                  cursor: 'pointer',
                }}
              >
                {news}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
