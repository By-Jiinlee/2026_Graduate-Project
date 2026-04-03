import { useState } from 'react'

export default function Community() {
  const [activeTab, setActiveTab] = useState('전체')
  const [activeFilter, setActiveFilter] = useState('최신순')
  const [searchTerm, setSearchTerm] = useState('') // 검색어 상태 추가

  const tabs = ['전체', '인기글', '질문', '뉴스']
  const filters = ['최신순', '조회순', '추천순']

  const posts = [
    { id: 1, title: '삼성전자 지금 매수 타이밍인가요?', author: '투자왕', date: '2024.03.01', views: 342, likes: 28 },
    { id: 2, title: 'SK하이닉스 HBM 수요 전망 분석', author: '반도체고수', date: '2024.03.01', views: 215, likes: 19 },
    { id: 3, title: '코스피 3000 돌파 가능할까요?', author: '시장분석가', date: '2024.02.28', views: 198, likes: 15 },
    { id: 4, title: 'NAVER vs 카카오 장기투자 비교', author: '장기투자자', date: '2024.02.28', views: 176, likes: 12 },
    { id: 5, title: '초보자를 위한 ETF 투자 가이드', author: '친절한고수', date: '2024.02.27', views: 521, likes: 47 },
    { id: 6, title: '2024년 2분기 전망 총정리', author: '리서치팀', date: '2024.02.27', views: 433, likes: 38 },
  ]

  // 검색어에 따른 필터링 로직
  const filteredPosts = posts.filter(post => 
    post.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
    post.author.toLowerCase().includes(searchTerm.toLowerCase())
  )

  return (
    <div style={{ fontFamily: 'sans-serif', padding: '40px 120px', minHeight: '100vh', backgroundColor: '#f9fafb' }}>

      {/* 게시글 검색 바 (기존 종목 영역 대체) */}
      <div style={{
        backgroundColor: '#fff',
        borderRadius: '16px',
        padding: '16px 24px',
        marginBottom: '24px',
        boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
        display: 'flex',
        alignItems: 'center',
        position: 'relative'
      }}>
        <span style={{ marginRight: '12px', fontSize: '18px', color: '#888' }}>🔍</span>
        <input 
          type="text"
          placeholder="검색하기"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          style={{
            flex: 1,
            border: 'none',
            outline: 'none',
            fontSize: '15px',
            color: '#333',
            backgroundColor: 'transparent'
          }}
        />
        {searchTerm && (
          <button 
            onClick={() => setSearchTerm('')}
            style={{
              border: 'none',
              background: 'none',
              color: '#ccc',
              cursor: 'pointer',
              fontSize: '18px'
            }}
          >
            ×
          </button>
        )}
      </div>

      {/* 탭 및 필터 영역 */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        {tabs.map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              padding: '8px 20px',
              borderRadius: '20px',
              border: activeTab === tab ? 'none' : '1px solid #ddd',
              backgroundColor: activeTab === tab ? '#22C55E' : '#fff',
              color: activeTab === tab ? '#fff' : '#555',
              fontWeight: activeTab === tab ? '600' : '400',
              fontSize: '13px',
              cursor: 'pointer',
            }}
          >
            {tab}
          </button>
        ))}

        <div style={{ flex: 1 }} />

        {filters.map(f => (
          <button
            key={f}
            onClick={() => setActiveFilter(f)}
            style={{
              padding: '8px 16px',
              borderRadius: '20px',
              border: '1px solid #ddd',
              backgroundColor: activeFilter === f ? '#f0faf4' : '#fff',
              color: activeFilter === f ? '#22C55E' : '#888',
              fontWeight: activeFilter === f ? '600' : '400',
              fontSize: '13px',
              cursor: 'pointer',
            }}
          >
            {f}
          </button>
        ))}
      </div>

      {/* 게시글 목록 */}
      <div style={{
        backgroundColor: '#fff',
        borderRadius: '16px',
        boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
        overflow: 'hidden',
      }}>
        {/* 헤더 */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 100px 100px 60px 60px',
          padding: '12px 24px',
          backgroundColor: '#f5f5f5',
          fontSize: '13px',
          color: '#888',
          fontWeight: '500',
        }}>
          <span>제목</span>
          <span>작성자</span>
          <span>작성일</span>
          <span style={{ textAlign: 'center' }}>조회수</span>
          <span style={{ textAlign: 'center' }}>추천</span>
        </div>

        {filteredPosts.length > 0 ? (
          filteredPosts.map((post, i) => (
            <div
              key={post.id}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 100px 100px 60px 60px',
                padding: '16px 24px',
                borderBottom: i < filteredPosts.length - 1 ? '1px solid #f0f0f0' : 'none',
                fontSize: '14px',
                cursor: 'pointer',
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#f9fafb')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = '#fff')}
            >
              <span style={{ color: '#222', fontWeight: '500' }}>{post.title}</span>
              <span style={{ color: '#888' }}>{post.author}</span>
              <span style={{ color: '#aaa' }}>{post.date}</span>
              <span style={{ color: '#aaa', textAlign: 'center' }}>{post.views}</span>
              <span style={{ color: '#22C55E', textAlign: 'center' }}>{post.likes}</span>
            </div>
          ))
        ) : (
          <div style={{ padding: '40px', textAlign: 'center', color: '#888' }}>
            검색 결과가 없습니다.
          </div>
        )}
      </div>

      {/* 글쓰기 버튼 */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '16px' }}>
        <button style={{
          backgroundColor: '#22C55E',
          color: '#fff',
          padding: '10px 24px',
          borderRadius: '8px',
          border: 'none',
          fontSize: '14px',
          fontWeight: '600',
          cursor: 'pointer',
        }}>
          글쓰기
        </button>
      </div>
    </div>
  )
}