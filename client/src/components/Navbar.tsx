import { Link, useNavigate } from 'react-router-dom'
import { useState } from 'react'

const checkLoggedIn = () => document.cookie.split(';').some(c => c.trim().startsWith('isLoggedIn=true'))

export default function Navbar() {
  const navigate = useNavigate()
  const [loggedIn, setLoggedIn] = useState(checkLoggedIn())

  const handleLogout = async () => {
    await fetch('http://localhost:3000/api/auth/logout', {
      method: 'POST',
      credentials: 'include',
    })
    document.cookie = 'accessToken=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;'
    document.cookie = 'refreshToken=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;'
    document.cookie = 'isLoggedIn=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;'
    setLoggedIn(false)
    navigate('/')
  }

  return (
    <nav className="bg-white p-4 shadow-md sticky top-0 z-50">
      <div className="container mx-auto flex justify-between items-center">
        <div className="flex items-center space-x-2">
          <img src="/logo.png" alt="로고" className="h-8 w-auto" />
          <Link to="/" className="text-xl font-black text-black tracking-tight">
            UpTick
          </Link>
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
              <Link
                to="/mypage"
                className="w-10 h-10 rounded-full bg-[#22C55E] flex items-center justify-center text-white font-bold hover:bg-[#16A34A] transition"
                title="마이페이지"
              >
                👤
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
  )
}