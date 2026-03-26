import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Navbar from './components/Navbar'
import LandingPage from './pages/LandingPage'
import Dashboard from './pages/Dashboard'
import StockList from './pages/StockList'
import About from './pages/About'
import Community from './pages/Community'
import Support from './pages/Support'
import Events from './pages/Events'
import MyPage from './pages/MyPage'
import Auth from './pages/Auth' // Auth 페이지 추가

function App() {
  return (
    <BrowserRouter>
      <Navbar />
      <Routes>
        <Route path="/" element={<LandingPage />} />
        {/* 네브바의 링크(/stock)와 맞추기 위해 /stocks 대신 /stock 사용 추천 */}
        <Route path="/stock" element={<StockList />} />
        <Route path="/manage" element={<Dashboard />} />{' '}
        {/* /dashboard 대신 /manage로 통일 */}
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/stocks" element={<StockList />} />
        <Route path="/about" element={<About />} />
        <Route path="/community" element={<Community />} />
        <Route path="/support" element={<Support />} />
        <Route path="/events" element={<Events />} />
        <Route path="/mypage" element={<MyPage />} />
        <Route path="/auth" element={<Auth />} />{' '}
        {/* 시작하기 버튼을 위한 경로 추가 */}
      </Routes>
    </BrowserRouter>
  )
}

export default App
