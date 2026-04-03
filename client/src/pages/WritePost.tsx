import { useState, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { type Post } from '../data/mockPosts';

export default function WritePost() {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState(''); // 작성자 상태 유지
  const [category, setCategory] = useState('질문');
  const [content, setContent] = useState('');
  const [image, setImage] = useState('');

  const handleImageChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => setImage(reader.result as string);
      reader.readAsDataURL(file);
    }
  };

  const handleSubmit = () => {
    if (!title || !content) return alert("제목과 내용을 입력해주세요!");
    const savedPosts = localStorage.getItem('upTick_posts');
    const postList = savedPosts ? JSON.parse(savedPosts) : [];

    const newPost: Post = {
      id: Date.now(),
      title,
      author: author || '익명사용자', // 작성자 이름 없으면 기본값
      category,
      content,
      imageUrl: image,
      date: new Date().toLocaleString('ko-KR', { 
        year: 'numeric', month: '2-digit', day: '2-digit', 
        hour: '2-digit', minute: '2-digit', hour12: false 
      }),
      views: 0,
      likes: 0,
      comments: []
    };

    localStorage.setItem('upTick_posts', JSON.stringify([newPost, ...postList]));
    alert("게시글이 성공적으로 등록되었습니다.");
    navigate('/community');
  };

  return (
    <div style={{ fontFamily: 'sans-serif', padding: '60px 20px', minHeight: '100vh', backgroundColor: '#f9fafb', display: 'flex', justifyContent: 'center' }}>
      <div style={{ width: '100%', maxWidth: '800px', backgroundColor: '#fff', borderRadius: '24px', padding: '48px', boxShadow: '0 4px 20px rgba(0,0,0,0.05)' }}>
        
        {/* 상단 헤더 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '40px' }}>
          <h2 style={{ fontSize: '24px', fontWeight: 'bold', color: '#222', margin: 0 }}>새 게시글 작성</h2>
          <button onClick={() => navigate(-1)} style={{ background: 'none', border: 'none', color: '#999', cursor: 'pointer', fontSize: '16px' }}>취소</button>
        </div>

        {/* 카테고리 & 작성자 입력란 (한 줄) */}
        <div style={{ display: 'flex', gap: '12px', marginBottom: '24px' }}>
          <select 
            value={category} 
            onChange={(e) => setCategory(e.target.value)}
            style={{ padding: '10px 16px', borderRadius: '12px', border: '1px solid #eee', outline: 'none', backgroundColor: '#fdfdfd', cursor: 'pointer' }}
          >
            <option value="질문">질문</option>
            <option value="뉴스">뉴스</option>
            <option value="인기글">인기글</option>
          </select>
          <input 
            placeholder="작성자 이름" 
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            style={{ padding: '10px 16px', borderRadius: '12px', border: '1px solid #eee', outline: 'none', width: '150px' }}
          />
        </div>

        {/* 커스텀 파일 선택 버튼 */}
        <div style={{ marginBottom: '32px' }}>
          <label style={{ 
            display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '10px 16px', 
            borderRadius: '12px', border: '1px solid #22C55E', color: '#22C55E', 
            fontSize: '14px', fontWeight: '600', cursor: 'pointer', backgroundColor: '#fff',
            transition: '0.2s'
          }}>
            <span>📷 사진 첨부하기</span>
            <input type="file" accept="image/*" onChange={handleImageChange} style={{ display: 'none' }} />
          </label>
          
          {image && (
            <div style={{ marginTop: '16px', position: 'relative', display: 'inline-block' }}>
              <img src={image} alt="preview" style={{ maxWidth: '100%', maxHeight: '300px', borderRadius: '16px', border: '1px solid #eee' }} />
              <button 
                onClick={() => setImage('')} 
                style={{ position: 'absolute', top: '10px', right: '10px', backgroundColor: 'rgba(0,0,0,0.5)', color: '#fff', border: 'none', borderRadius: '50%', width: '28px', height: '28px', cursor: 'pointer' }}
              >
                ×
              </button>
            </div>
          )}
        </div>

        {/* 제목 입력창 (하단 라인 스타일) */}
        <input 
          placeholder="제목을 입력하세요" 
          value={title} 
          onChange={e => setTitle(e.target.value)} 
          style={{ 
            width: '100%', fontSize: '22px', fontWeight: '600', padding: '12px 0', 
            border: 'none', borderBottom: '2px solid #f0f0f0', outline: 'none', 
            marginBottom: '32px', transition: 'border-color 0.3s' 
          }}
          onFocus={e => e.currentTarget.style.borderBottomColor = '#22C55E'}
          onBlur={e => e.currentTarget.style.borderBottomColor = '#f0f0f0'}
        />

        {/* 내용 입력창 */}
        <textarea 
          placeholder="내용을 입력하세요..." 
          value={content} 
          onChange={e => setContent(e.target.value)} 
          style={{ 
            width: '100%', height: '350px', border: 'none', outline: 'none', 
            fontSize: '16px', lineHeight: '1.6', resize: 'none', color: '#444' 
          }} 
        />

        {/* 등록 버튼 (업틱 메인 컬러 적용) */}
        <button 
          onClick={handleSubmit} 
          style={{ 
            width: '100%', padding: '18px', backgroundColor: '#22C55E', color: '#fff', 
            border: 'none', borderRadius: '16px', fontSize: '18px', fontWeight: 'bold', 
            marginTop: '20px', cursor: 'pointer', transition: '0.2s', boxShadow: '0 4px 12px rgba(34, 197, 94, 0.2)'
          }}
          onMouseEnter={e => e.currentTarget.style.backgroundColor = '#1eb054'}
          onMouseLeave={e => e.currentTarget.style.backgroundColor = '#22C55E'}
        >
          게시글 등록하기
        </button>
      </div>
    </div>
  );
}