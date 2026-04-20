import { Link, useNavigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { useTradeModeStore } from '../store/tradeModeStore'
import { useProfileStore } from '../store/profileStore'

const checkLoggedIn = () => document.cookie.split(';').some(c => c.trim().startsWith('isLoggedIn=true'))

const getSessionRemaining = () => {
  const loginTime = localStorage.getItem('loginTime')
  if (!loginTime) return 0
  const elapsed = Math.floor((Date.now() - parseInt(loginTime)) / 1000)
  return Math.max(0, 600 - elapsed)
}

export default function Navbar() {
  const navigate = useNavigate()
  const [loggedIn, setLoggedIn] = useState(checkLoggedIn())
  const { mode, setMode, reset: resetMode } = useTradeModeStore()
  const { profileImage } = useProfileStore()
  const [remaining, setRemaining] = useState(getSessionRemaining())
  const [showWarning, setShowWarning] = useState(false)

  useEffect(() => {
    if (!loggedIn) return

    const interval = setInterval(() => {
      const r = getSessionRemaining()
      setRemaining(r)

      if (r <= 60 && r > 0) {
        setShowWarning(true)
      } else if (r > 60) {
        setShowWarning(false)
      }

      if (r <= 0) {
        setLoggedIn(false)
        localStorage.removeItem('loginTime')
        resetMode()
        document.cookie = 'accessToken=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;'
        document.cookie = 'refreshToken=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;'
        document.cookie = 'isLoggedIn=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;'
        navigate('/login')
      }
    }, 1000)

    return () => clearInterval(interval)
  }, [loggedIn])

  const handleLogout = async () => {
    await fetch('http://localhost:3000/api/auth/logout', {
      method: 'POST',
      credentials: 'include',
    })
    document.cookie = 'accessToken=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;'
    document.cookie = 'refreshToken=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;'
    document.cookie = 'isLoggedIn=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;'
    localStorage.removeItem('loginTime')
    resetMode()
    setLoggedIn(false)
    navigate('/')
  }

  const handleExtendSession = async () => {
    try {
      const res = await fetch('http://localhost:3000/api/auth/refresh', {
        method: 'POST',
        credentials: 'include',
      })
      if (!res.ok) throw new Error()
      localStorage.setItem('loginTime', Date.now().toString())
      setRemaining(600)
      setShowWarning(false)
    } catch {
      handleLogout()
    }
  }

  const formatTime = (sec: number) => {
    const m = Math.floor(sec / 60)
    const s = sec % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  return (
    <>
      {/* 1분 전 경고 팝업 */}
      {showWarning && loggedIn && (
        <div style={{
          position: 'fixed',
          top: '80px',
          right: '20px',
          backgroundColor: '#fff',
          border: '2px solid #e53935',
          borderRadius: '12px',
          padding: '20px 24px',
          boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
          zIndex: 9999,
          width: '300px',
        }}>
          <p style={{ fontSize: '15px', fontWeight: '700', color: '#e53935', marginBottom: '8px' }}>
            ⚠️ 세션 만료 임박
          </p>
          <p style={{ fontSize: '13px', color: '#555', marginBottom: '16px' }}>
            <strong>{formatTime(remaining)}</strong> 후 자동 로그아웃됩니다.
          </p>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={handleExtendSession}
              style={{
                flex: 1,
                padding: '10px',
                backgroundColor: '#3CB371',
                color: '#fff',
                border: 'none',
                borderRadius: '8px',
                fontWeight: '600',
                fontSize: '13px',
                cursor: 'pointer',
              }}
            >
              세션 연장
            </button>
            <button
              onClick={handleLogout}
              style={{
                flex: 1,
                padding: '10px',
                backgroundColor: '#f5f5f5',
                color: '#888',
                border: 'none',
                borderRadius: '8px',
                fontWeight: '600',
                fontSize: '13px',
                cursor: 'pointer',
              }}
            >
              로그아웃
            </button>
          </div>
        </div>
      )}

      <nav className="bg-white p-4 shadow-md sticky top-0 z-50">
        <div className="container mx-auto flex justify-between items-center">
          <div className="flex items-center space-x-2">
            <img src="/logo.png" alt="로고" className="h-8 w-auto" />
            <Link to="/" className="text-xl font-black text-black tracking-tight">
              UpTick
            </Link>
            {loggedIn && (
              <button
                onClick={() => setMode(mode === 'real' ? 'virtual' : 'real')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '5px',
                  marginLeft: '8px',
                  padding: '3px 10px 3px 7px',
                  borderRadius: '999px',
                  border: `1px solid ${mode === 'real' ? '#fed7aa' : '#bbf7d0'}`,
                  backgroundColor: mode === 'real' ? '#fff7ed' : '#f0fdf4',
                  cursor: 'pointer',
                  fontSize: '11px',
                  fontWeight: '700',
                  color: mode === 'real' ? '#c2410c' : '#15803d',
                  letterSpacing: '0.03em',
                  transition: 'all 0.25s ease',
                  userSelect: 'none',
                }}
              >
                <span style={{
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  backgroundColor: mode === 'real' ? '#f97316' : '#22C55E',
                  animation: 'pulse-dot 1.8s ease-in-out infinite',
                  flexShrink: 0,
                }} />
                {mode === 'real' ? '실거래' : '모의투자'}
              </button>
            )}
          </div>

          <div className="flex items-center space-x-20">
            <div className="flex space-x-16 text-black font-medium">
              <Link to="/stock" className="hover:text-[#22C55E] transition">종목</Link>
              <Link to="/manage" className="hover:text-[#22C55E] transition">주식 관리</Link>
              <Link to="/community" className="hover:text-[#22C55E] transition">커뮤니티</Link>
              <Link to="/events" className="hover:text-[#22C55E] transition">이벤트</Link>
              <Link to="/support" className="hover:text-[#22C55E] transition">고객센터</Link>
              <Link to="/about" className="hover:text-[#22C55E] transition">소개</Link>
              <Link to="/mypage" className="hover:text-[#22C55E] transition">마이페이지</Link>
            </div>

            {loggedIn ? (
              <div className="flex items-center space-x-3">
                {remaining > 0 && (
                  <span style={{
                    fontSize: '12px',
                    color: remaining <= 60 ? '#e53935' : '#888',
                    fontWeight: remaining <= 60 ? '700' : '400',
                  }}>
                    {formatTime(remaining)}
                  </span>
                )}
                <Link
                  to="/mypage"
                  className="w-10 h-10 rounded-full bg-[#22C55E] flex items-center justify-center text-white font-bold hover:bg-[#16A34A] transition overflow-hidden"
                  title="마이페이지"
                >
                  {profileImage
                    ? <img src={profileImage} alt="프로필" className="w-full h-full object-cover" />
                    : <span>👤</span>
                  }
                </Link>
                <button
                  onClick={handleLogout}
                  className="bg-gray-100 text-gray-600 px-4 py-2 rounded-md font-medium hover:bg-gray-200 transition text-sm"
                >
                  로그아웃
                </button>
              </div>
            ) : (
              <Link
                to="/login"
                className="bg-[#22C55E] text-white px-8 py-3 rounded-md font-bold hover:bg-[#16A34A] transition text-sm inline-block text-center"
              >
                시작하기 →
              </Link>
            )}
          </div>
        </div>
      </nav>
    </>
  )
}