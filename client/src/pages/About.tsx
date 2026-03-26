export default function About() {
  const members = [
    { name: '이지인', role: 'PM\n프론트엔드' },
    { name: '김시우', role: 'QA\n프론트엔드' },
    { name: '윤다혜', role: 'DB 관리자\n백엔드' },
    { name: '이경준', role: '웹 보안\n백엔드' },
    { name: '이시준', role: '웹 보안\n백엔드' },
  ]

  return (
<<<<<<< HEAD
    <div style={{
      fontFamily: 'sans-serif',
      padding: '60px 120px',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center', // 전체 컨테이너 요소를 가운데로 정렬
      textAlign: 'center',  // 텍스트를 가운데 정렬
    }}>
=======
    <div style={{ fontFamily: 'sans-serif', padding: '60px 120px' }}>
>>>>>>> 344acb2c6ba53f50cd543eae6d046ae1010cb349

      {/* 소개 텍스트 */}
      <section style={{ marginBottom: '60px' }}>
        <h1 style={{ fontSize: '28px', fontWeight: 'bold', marginBottom: '24px' }}>
          UpTick을 소개합니다.
        </h1>
        <p style={{ fontSize: '15px', color: '#444', lineHeight: '1.8', maxWidth: '700px' }}>
<<<<<<< HEAD
          리스크 없이 시장을 경험하고, 자세한 전략을 수립할 수 있습니다. <br />
          초보자와 전문투자자 고수와 같은 실용 해결하기, <br /> 
          UpTick에서 경험해보세요.
=======
          정확한 마켓트렌드와 투자자의 입장 단계별 환경에는 주식 흐름입니다.
          리스크 없이 시장을 경험하고, 자세한 전략을 수립할 수 있습니다.
          초보자와 전문투자자 고수와 같은 실용 해결하기, 업티 나쁜은 UpTick입니다.
>>>>>>> 344acb2c6ba53f50cd543eae6d046ae1010cb349
        </p>
      </section>

      {/* 구분선 */}
      <hr style={{ borderColor: '#eee', marginBottom: '48px' }} />

      {/* 팀원 소개 */}
      <section>
        <h2 style={{ fontSize: '20px', fontWeight: 'bold', marginBottom: '32px' }}>
          UpTick 구성원
        </h2>
        <div style={{ display: 'flex', gap: '32px', flexWrap: 'wrap' }}>
          {members.map(member => (
            <div key={member.name} style={{ textAlign: 'center', width: '120px' }}>
              {/* 아바타 */}
              <div style={{
                width: '80px',
                height: '80px',
                borderRadius: '50%',
                backgroundColor: '#e0e0e0',
                margin: '0 auto 12px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '32px',
              }}>
                👤
              </div>
              <div style={{ fontWeight: 'bold', fontSize: '15px', marginBottom: '6px' }}>
                {member.name}
              </div>
              <div style={{ fontSize: '12px', color: '#888', whiteSpace: 'pre-line', lineHeight: '1.6' }}>
                {member.role}
              </div>
            </div>
          ))}
        </div>
      </section>

    </div>
  )
}