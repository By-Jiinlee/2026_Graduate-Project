import { useParams, useNavigate } from 'react-router-dom';
import { useEffect, useState, useRef } from 'react';
import { type Post, type Comment } from '../data/mockPosts';

export default function PostDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [post, setPost] = useState<Post | null>(null);
  const hasIncremented = useRef(false);

  const [commentAuthor, setCommentAuthor] = useState('');
  const [commentContent, setCommentContent] = useState('');

  useEffect(() => {
    const savedPosts = localStorage.getItem('upTick_posts');
    if (savedPosts) {
      const posts: Post[] = JSON.parse(savedPosts);
      const foundPost = posts.find(p => p.id === Number(id));
      
      if (foundPost && !hasIncremented.current) {
        const updatedPosts = posts.map(p => 
          p.id === foundPost.id ? { ...p, views: p.views + 1 } : p
        );
        localStorage.setItem('upTick_posts', JSON.stringify(updatedPosts));
        setPost({ ...foundPost, views: foundPost.views + 1 });
        hasIncremented.current = true;
      } else {
        setPost(foundPost || null);
      }
    }
  }, [id]);

  const handleLike = () => {
    if (!post) return;
    const savedPosts = localStorage.getItem('upTick_posts');
    if (savedPosts) {
      const posts: Post[] = JSON.parse(savedPosts);
      const updatedPosts = posts.map(p => p.id === post.id ? { ...p, likes: p.likes + 1 } : p);
      localStorage.setItem('upTick_posts', JSON.stringify(updatedPosts));
      setPost({ ...post, likes: post.likes + 1 });
    }
  };

  const handleAddComment = () => {
    if (!commentAuthor || !commentContent || !post) return alert("내용을 입력해주세요.");
    
    const now = new Date().toLocaleString('ko-KR', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    });

    const newComment: Comment = {
      id: Date.now(),
      author: commentAuthor,
      content: commentContent,
      date: now
    };

    const updatedPost = { ...post, comments: [...(post.comments || []), newComment] };
    const savedPosts = JSON.parse(localStorage.getItem('upTick_posts') || '[]');
    localStorage.setItem('upTick_posts', JSON.stringify(savedPosts.map((p: any) => p.id === post.id ? updatedPost : p)));
    
    setPost(updatedPost);
    setCommentAuthor('');
    setCommentContent('');
  };

  if (!post) return <div style={{ padding: '100px', textAlign: 'center' }}>게시글을 로딩 중입니다...</div>;

  return (
    <div style={{ fontFamily: 'sans-serif', padding: '60px 120px', minHeight: '100vh', backgroundColor: '#f9fafb' }}>
      <button 
        onClick={() => navigate(-1)} 
        style={{ cursor: 'pointer', border: 'none', background: 'none', color: '#888', fontSize: '15px', marginBottom: '20px' }}
      >
        ← 커뮤니티로 돌아가기
      </button>
      
      {/* 본문 카드 */}
      <div style={{ backgroundColor: '#fff', borderRadius: '24px', padding: '48px', boxShadow: '0 4px 20px rgba(0,0,0,0.05)', marginBottom: '32px' }}>
        <h1 style={{ fontSize: '28px', marginBottom: '16px', color: '#222' }}>{post.title}</h1>
        <div style={{ color: '#888', fontSize: '14px', marginBottom: '40px', display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #f0f0f0', paddingBottom: '20px' }}>
          <span>작성자: <strong>{post.author}</strong> | {post.date}</span>
          <span>추천수: <strong style={{ color: '#22C55E' }}>{post.likes}</strong> | 조회수: {post.views}</span>
        </div>

        {/* 🖼️ 이미지 출력 영역 (이 부분이 핵심입니다!) */}
        {post.imageUrl && (
          <div style={{ marginBottom: '40px', textAlign: 'center', backgroundColor: '#fdfdfd', borderRadius: '16px', padding: '20px', border: '1px solid #f5f5f5' }}>
            <img 
              src={post.imageUrl} 
              alt="첨부 이미지" 
              style={{ maxWidth: '100%', borderRadius: '12px', boxShadow: '0 2px 10px rgba(0,0,0,0.05)' }} 
            />
          </div>
        )}

        <div style={{ fontSize: '17px', lineHeight: '1.8', minHeight: '200px', color: '#333', whiteSpace: 'pre-wrap' }}>
          {post.content}
        </div>

        {/* 추천 버튼 */}
        <div style={{ marginTop: '60px', display: 'flex', justifyContent: 'center' }}>
          <button 
            onClick={handleLike}
            style={{ 
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px',
              padding: '20px 48px', borderRadius: '100px', border: '1px solid #22C55E', 
              backgroundColor: '#fff', color: '#22C55E', cursor: 'pointer', fontWeight: 'bold',
              transition: '0.2s'
            }}
            onMouseEnter={e => e.currentTarget.style.backgroundColor = '#f0faf4'}
            onMouseLeave={e => e.currentTarget.style.backgroundColor = '#fff'}
          >
            <span style={{ fontSize: '28px' }}>👍</span>
            <span style={{ fontSize: '16px' }}>추천 {post.likes}</span>
          </button>
        </div>
      </div>

      {/* 댓글 영역 */}
      <div style={{ backgroundColor: '#fff', borderRadius: '24px', padding: '48px', boxShadow: '0 4px 20px rgba(0,0,0,0.05)' }}>
        <h3 style={{ fontSize: '20px', marginBottom: '32px', fontWeight: 'bold' }}>댓글 {post.comments?.length || 0}</h3>
        
        <div style={{ marginBottom: '48px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <input 
            placeholder="이름" value={commentAuthor} onChange={e => setCommentAuthor(e.target.value)}
            style={{ width: '180px', padding: '12px 16px', borderRadius: '12px', border: '1px solid #eee', outline: 'none' }}
          />
          <div style={{ display: 'flex', gap: '12px' }}>
            <textarea 
              placeholder="댓글을 남겨보세요." value={commentContent} onChange={e => setCommentContent(e.target.value)}
              style={{ flex: 1, height: '100px', padding: '16px', borderRadius: '12px', border: '1px solid #eee', resize: 'none', outline: 'none' }}
            />
            <button 
              onClick={handleAddComment}
              style={{ width: '120px', backgroundColor: '#22C55E', color: '#fff', border: 'none', borderRadius: '12px', fontWeight: 'bold', cursor: 'pointer' }}
            >
              등록
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
          {post.comments && post.comments.length > 0 ? (
            [...post.comments].reverse().map(comment => (
              <div key={comment.id} style={{ borderBottom: '1px solid #f9f9f9', paddingBottom: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
                  <span style={{ fontWeight: 'bold', color: '#222' }}>{comment.author}</span>
                  <span style={{ color: '#ccc', fontSize: '12px' }}>{comment.date}</span>
                </div>
                <div style={{ fontSize: '15px', color: '#555', lineHeight: '1.6' }}>{comment.content}</div>
              </div>
            ))
          ) : (
            <div style={{ color: '#bbb', textAlign: 'center', padding: '40px' }}>아직 댓글이 없습니다.</div>
          )}
        </div>
      </div>
    </div>
  );
}