import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import Navbar from './components/Navbar'
import LandingPage from './pages/LandingPage'
import Dashboard from './pages/Dashboard'
import StockList from './pages/StockList'
import About from './pages/About'
import Community from './pages/Community'
import PostDetail from './pages/PostDetail'
import WritePost from './pages/WritePost'
import Support from './pages/Support'
import Events from './pages/Events'
import MyPage from './pages/MyPage'
import Register from './pages/Register'
import Login from './pages/Login'

const isLoggedIn = () => document.cookie.split(';').some(c => c.trim().startsWith('isLoggedIn=true'))

const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const [count, setCount] = useState(5)

  useEffect(() => {
    if (!isLoggedIn()) {
      const timer = setInterval(() => {
        setCount(prev => prev - 1)
      }, 1000)
      return () => clearInterval(timer)
    }
  }, [])

  if (!isLoggedIn()) {
    if (count <= 0) return <Navigate to="/login" replace />

    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'sans-serif',
        backgroundColor: '#f9fafb',
      }}>
        <div style={{
          backgroundColor: '#fff',
          borderRadius: '20px',
          padding: '48px 40px',
          textAlign: 'center',
          boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
          width: '400px',
        }}>
          <p style={{ fontSize: '24px', marginBottom: '12px' }}>🔒</p>
          <h2 style={{ fontSize: '20px', fontWeight: 'bold', color: '#1a1a1a', marginBottom: '12px' }}>
            로그인 후 이용 가능한 서비스입니다
          </h2>
          <p style={{ fontSize: '14px', color: '#888', marginBottom: '24px' }}>
            {count}초 후 로그인 페이지로 이동합니다
          </p>
          <a href="/login" style={{
            display: 'inline-block',
            padding: '12px 32px',
            backgroundColor: '#3CB371',
            color: '#fff',
            borderRadius: '10px',
            fontWeight: '600',
            textDecoration: 'none',
            fontSize: '15px',
          }}>
            지금 로그인하기
          </a>
        </div>
      </div>
    )
  }

  return <>{children}</>
}

function App() {
  return (
    <BrowserRouter>
      <Navbar />
      <Routes>
        {/* 비로그인 접근 가능 */}
        <Route path="/" element={<LandingPage />} />
        <Route path="/stock" element={<StockList />} />
        <Route path="/stocks" element={<StockList />} />
        <Route path="/about" element={<About />} />
        <Route path="/register" element={<Register />} />
        <Route path="/login" element={<Login />} />

        {/* 로그인 필요 */}
        <Route path="/manage" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
        <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
        <Route path="/community" element={<ProtectedRoute><Community /></ProtectedRoute>} />
        <Route path="/community/:id" element={<ProtectedRoute><PostDetail /></ProtectedRoute>} />
        <Route path="/community/write" element={<ProtectedRoute><WritePost /></ProtectedRoute>} />
        <Route path="/support" element={<ProtectedRoute><Support /></ProtectedRoute>} />
        <Route path="/events" element={<ProtectedRoute><Events /></ProtectedRoute>} />
        <Route path="/mypage" element={<ProtectedRoute><MyPage /></ProtectedRoute>} />
      </Routes>
    </BrowserRouter>
  )
}

export default App