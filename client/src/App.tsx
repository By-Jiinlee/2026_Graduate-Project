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
import StockDetail from './pages/StockDetail'
// 💡 앞서 만든 설문 페이지 Import (경로가 다르면 수정해주세요)
import Survey from './pages/Survey' 

const isLoggedIn = () => document.cookie.split(';').some(c => c.trim().startsWith('isLoggedIn=true'))

// 1. 기존 로그인 체크 가드
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

// 2. 💡 추가된 설문 체크 가드 (로그인은 통과했으나 설문을 안 한 사람 튕겨내기)
const SurveyGuard = ({ children }: { children: React.ReactNode }) => {
  const userStr = localStorage.getItem('upTick_user')
  const user = userStr ? JSON.parse(userStr) : {}

  // 설문을 완료하지 않았다면 무조건 /survey 로 강제 이동
  if (!user.is_survey_completed) {
    return <Navigate to="/survey" replace />
  }

  return <>{children}</>
}

function App() {
  return (
    <BrowserRouter>
      <Navbar />
      <Routes>
        {/* 비로그인 접근 가능 영역 */}
        <Route path="/" element={<LandingPage />} />
        <Route path="/stock" element={<StockList />} />
        <Route path="/stocks" element={<StockList />} />
        <Route path="/about" element={<About />} />
        <Route path="/stock/:stockId" element={<StockDetail />} />
        <Route path="/register" element={<Register />} />
        <Route path="/login" element={<Login />} />

        {/* 💡 로그인은 필요하지만, 설문 완료 전에도 접근 가능한 유일한 곳 = 설문 페이지 */}
        <Route path="/survey" element={<ProtectedRoute><Survey /></ProtectedRoute>} />

        {/* 로그인 AND 설문까지 모두 완료해야 접근 가능한 영역들 (이중 감싸기) */}
        <Route path="/manage" element={<ProtectedRoute><SurveyGuard><Dashboard /></SurveyGuard></ProtectedRoute>} />
        <Route path="/dashboard" element={<ProtectedRoute><SurveyGuard><Dashboard /></SurveyGuard></ProtectedRoute>} />
        <Route path="/community" element={<ProtectedRoute><SurveyGuard><Community /></SurveyGuard></ProtectedRoute>} />
        <Route path="/community/:id" element={<ProtectedRoute><SurveyGuard><PostDetail /></SurveyGuard></ProtectedRoute>} />
        <Route path="/community/write" element={<ProtectedRoute><SurveyGuard><WritePost /></SurveyGuard></ProtectedRoute>} />
        <Route path="/support" element={<ProtectedRoute><SurveyGuard><Support /></SurveyGuard></ProtectedRoute>} />
        <Route path="/events" element={<ProtectedRoute><SurveyGuard><Events /></SurveyGuard></ProtectedRoute>} />
        <Route path="/mypage" element={<ProtectedRoute><SurveyGuard><MyPage /></SurveyGuard></ProtectedRoute>} />
      </Routes>
    </BrowserRouter>
  )
}

export default App