import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { installTradeSigning } from './utils/tradeSigning'

// 거래 요청 HMAC 자동 서명 인터셉터 등록
installTradeSigning()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
