import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const navigate = useNavigate()

  const handleLogin = () => {
    if (email && password) {
      navigate('/')
    }
  }

  return (
    <div style={{
      minHeight: '100vh', backgroundColor: '#f9fafb',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'sans-serif',
    }}>
      <div style={{
        backgroundColor: '#fff', borderRadius: '20px',
        padding: '48px 40px', width: '400px',
        boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
      }}>

        {/* 로고 */}
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <span style={{ fontSize: '28px', fontWeight: 'bold', color: '#3CB371' }}>UpTick</span>
          <span style={{ fontSize: '22px', marginLeft: '6px' }}>📈</span>
          <p style={{ fontSize: '14px', color: '#888', marginTop: '8px' }}>
            투자의 기준을 높이다
          </p>
        </div>

        {/* 입력 폼 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginBottom: '24px' }}>
          <div>
            <label style={{ fontSize: '13px', color: '#555', fontWeight: '600', display: 'block', marginBottom: '6px' }}>
              이메일
            </label>
            <input
              type="email"
              placeholder="이메일을 입력하세요"
              value={email}
              onChange={e => setEmail(e.target.value)}
              style={{
                width: '100%', padding: '12px 14px',
                border: '1px solid #ddd', borderRadius: '10px',
                fontSize: '14px', outline: 'none', boxSizing: 'border-box',
              }}
            />
          </div>
          <div>
            <label style={{ fontSize: '13px', color: '#555', fontWeight: '600', display: 'block', marginBottom: '6px' }}>
              비밀번호
            </label>
            <input
              type="password"
              placeholder="비밀번호를 입력하세요"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleLogin()}
              style={{
                width: '100%', padding: '12px 14px',
                border: '1px solid #ddd', borderRadius: '10px',
                fontSize: '14px', outline: 'none', boxSizing: 'border-box',
              }}
            />
          </div>
        </div>

        {/* 로그인 버튼 */}
        <button
          onClick={handleLogin}
          style={{
            width: '100%', padding: '14px',
            backgroundColor: '#3CB371', color: '#fff',
            border: 'none', borderRadius: '10px',
            fontSize: '15px', fontWeight: '600',
            cursor: 'pointer', marginBottom: '16px',
          }}
        >
          로그인
        </button>

        {/* 하단 링크 */}
        <div style={{ textAlign: 'center', fontSize: '13px', color: '#888' }}>
          아직 계정이 없으신가요?{' '}
          <Link to="/register" style={{ color: '#3CB371', fontWeight: '600', textDecoration: 'none' }}>
            회원가입
          </Link>
        </div>

        <div style={{ textAlign: 'center', marginTop: '12px', fontSize: '13px' }}>
          <Link to="/" style={{ color: '#aaa', textDecoration: 'none' }}>
            비밀번호를 잊으셨나요?
          </Link>
        </div>
      </div>
    </div>
  )
}