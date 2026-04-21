import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
// Post 타입을 가져온 뒤, imageUrl 속성을 선택적으로 추가(확장)합니다.
import { initialPosts, type Post as BasePost } from '../data/mockPosts'

// 기존 Post 타입에 imageUrl이 없을 경우를 대비해 인터페이스를 확장합니다.
interface Post extends BasePost {
  imageUrl?: string;
}

export default function Community() {
  const navigate = useNavigate();

  const [postList, setPostList] = useState<Post[]>([]);
  const [activeTab, setActiveTab] = useState('전체');
  const [activeFilter, setActiveFilter] = useState('최신순');
  const [searchTerm, setSearchTerm] = useState('');
  const [visibleCount, setVisibleCount] = useState(10);

  useEffect(() => {
    const savedPosts = localStorage.getItem('upTick_posts');
    if (savedPosts) {
      setPostList(JSON.parse(savedPosts));
    } else {
      setPostList(initialPosts as Post[]);
    }
  }, []);

  // 검색어 하이라이트 함수
  const highlightText = (text: string, query: string) => {
    if (!query.trim()) return text;
    const parts = text.split(new RegExp(`(${query})`, 'gi'));
    return (
      <span>
        {parts.map((part, index) => 
          part.toLowerCase() === query.toLowerCase() ? (
            <mark key={index} style={{ backgroundColor: '#22C55E', color: '#fff', borderRadius: '2px', padding: '0 2px' }}>{part}</mark>
          ) : (part)
        )}
      </span>
    );
  };

  const filteredPosts = postList.filter(post => {
    const matchesTab = activeTab === '전체' || post.category === activeTab;
    const matchesSearch = post.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          post.author.toLowerCase().includes(searchTerm.toLowerCase());
    return matchesTab && matchesSearch;
  });

  const sortedPosts = [...filteredPosts].sort((a, b) => {
    if (activeFilter === '최신순') return new Date(b.date.replace(/\./g, '-')).getTime() - new Date(a.date.replace(/\./g, '-')).getTime();
    if (activeFilter === '조회순') return b.views - a.views;
    if (activeFilter === '추천순') return b.likes - a.likes;
    return 0;
  });

  const displayedPosts = sortedPosts.slice(0, visibleCount);

  return (
    <div style={{ fontFamily: 'sans-serif', padding: '40px 120px', minHeight: '100vh', backgroundColor: '#f9fafb' }}>
      {/* 검색 바 */}
      <div style={{ backgroundColor: '#fff', borderRadius: '16px', padding: '16px 24px', marginBottom: '24px', boxShadow: '0 1px 4px rgba(0,0,0,0.08)', display: 'flex', alignItems: 'center' }}>
        <span style={{ marginRight: '12px', fontSize: '18px' }}>🔍</span>
        <input 
          type="text" placeholder="제목이나 작성자를 검색해보세요" value={searchTerm} 
          onChange={(e) => { setSearchTerm(e.target.value); setVisibleCount(10); }}
          style={{ flex: 1, border: 'none', outline: 'none', fontSize: '15px' }}
        />
      </div>

      {/* 탭 및 필터 */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', alignItems: 'center' }}>
        {['전체', '인기글', '질문', '뉴스'].map(tab => (
          <button key={tab} onClick={() => { setActiveTab(tab); setVisibleCount(10); }} style={{ padding: '8px 20px', borderRadius: '20px', border: activeTab === tab ? 'none' : '1px solid #ddd', backgroundColor: activeTab === tab ? '#22C55E' : '#fff', color: activeTab === tab ? '#fff' : '#555', cursor: 'pointer' }}>{tab}</button>
        ))}
        <div style={{ flex: 1 }} />
        {['최신순', '조회순', '추천순'].map(f => (
          <button key={f} onClick={() => setActiveFilter(f)} style={{ padding: '8px 16px', borderRadius: '20px', border: '1px solid #ddd', backgroundColor: activeFilter === f ? '#f0faf4' : '#fff', color: activeFilter === f ? '#22C55E' : '#888', cursor: 'pointer', fontSize: '13px' }}>{f}</button>
        ))}
      </div>

      {/* 목록 */}
      <div style={{ backgroundColor: '#fff', borderRadius: '16px', boxShadow: '0 1px 4px rgba(0,0,0,0.08)', overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px 150px 70px 70px', padding: '12px 24px', backgroundColor: '#f5f5f5', fontSize: '13px', color: '#888' }}>
          <span>제목</span><span>작성자</span><span>작성일</span><span style={{textAlign:'center'}}>조회</span><span style={{textAlign:'center'}}>추천</span>
        </div>
        {displayedPosts.map((post) => (
          <div key={post.id} onClick={() => navigate(`/community/${post.id}`)} style={{ display: 'grid', gridTemplateColumns: '1fr 120px 150px 70px 70px', padding: '16px 24px', borderBottom: '1px solid #f0f0f0', cursor: 'pointer', alignItems: 'center' }}>
            <span><span style={{ color: '#22C55E', marginRight: '8px', fontSize: '12px' }}>[{post.category}]</span>{highlightText(post.title, searchTerm)} {post.imageUrl && '🖼️'}</span>
            <span style={{ color: '#888' }}>{highlightText(post.author, searchTerm)}</span>
            <span style={{ color: '#aaa', fontSize: '12px' }}>{post.date}</span>
            <span style={{ color: '#aaa', textAlign: 'center' }}>{post.views}</span>
            <span style={{ color: '#22C55E', textAlign: 'center' }}>{post.likes}</span>
          </div>
        ))}
      </div>

      {/* 더보기 버튼 */}
      {sortedPosts.length > visibleCount && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: '24px' }}>
          <button onClick={() => setVisibleCount(prev => prev + 10)} style={{ padding: '12px 40px', borderRadius: '30px', border: '1px solid #ddd', backgroundColor: '#fff', cursor: 'pointer' }}>더보기 ({displayedPosts.length}/{sortedPosts.length})</button>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '16px' }}>
        <button onClick={() => navigate('/community/write')} style={{ backgroundColor: '#22C55E', color: '#fff', padding: '10px 24px', borderRadius: '8px', border: 'none', fontWeight: 'bold', cursor: 'pointer' }}>글쓰기</button>
      </div>
    </div>
  )
}