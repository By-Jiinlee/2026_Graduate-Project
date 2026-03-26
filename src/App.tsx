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
import Auth from './pages/Auth'

function App() {
  return (
    <BrowserRouter>
      <Navbar />
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/stocks" element={<StockList />} />
        <Route path="/about" element={<About />} />
        <Route path="/community" element={<Community />} />
        <Route path="/support" element={<Support />} />
        <Route path="/events" element={<Events />} />
        <Route path="/mypage" element={<MyPage />} />
        <Route path="/auth" element={<Auth />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App