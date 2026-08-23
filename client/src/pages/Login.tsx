import { useState, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { setSigningSecret } from '../utils/tradeSigning'
import { API_BASE } from '../utils/api'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [step, setStep] = useState(1) // 1: 기본정보, 2: 추가인증 화면
  
  // 인증 수단별 상태 ('NONE' | 'PIN' | 'EMAIL_OTP' | 'WALLET')
  const [requiredAuth, setRequiredAuth] = useState<string>('NONE')
  const [loginData, setLoginData] = useState<any>(null)

  // 추가 입력값 상태
  const [pin, setPin] = useState('')
  const [emailCode, setEmailCode] = useState('')
  const [rememberDevice, setRememberDevice] = useState(false)

  // 이메일 OTP 60초 쿨타임 관리
  const [cooldown, setCooldown] = useState(0)

  // 로그인 성공 후 PIN 설정 유도 모달 상태
  const [showPinPrompt, setShowPinPrompt] = useState(false)
  const [pendingRedirectUrl, setPendingRedirectUrl] = useState('/')

  const [error, setError] = useState('')
  const navigate = useNavigate()

  // 60초 쿨타임 타이머 작동
  useEffect(() => {
    if (cooldown > 0) {
      const timer = setInterval(() => setCooldown(c => c - 1), 1000)
      return () => clearInterval(timer)
    }
  }, [cooldown])

  // ─── 로그인 1단계 ─────────────────────────────────────────────
  const handleLoginStep1 = async () => {
    try {
      setError('')
      const res = await fetch(`${API_BASE}/api/auth/login/step1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message)

      setLoginData(data)

      // requiredAuth 결정 (없으면 기존 isTrustedDevice로 폴백)
      let authType = data.requiredAuth
      if (!authType) {
        authType = data.isTrustedDevice ? 'NONE' : 'WALLET'
      }
      setRequiredAuth(authType)

      if (authType === 'EMAIL_OTP') {
        // 이메일 인증 등급이면 자동으로 코드 발송 API 호출
        await handleSendEmailCode(data.userId)
      }

      if (authType === 'NONE') {
        // 추가 인증이 필요 없는 경우 곧바로 step2 호출
        await executeStep2({ userId: data.userId, walletAddress: data.walletAddress, signature: '', skipSignature: true } as any)
      } else {
        // 추가 인증(WALLET, PIN, EMAIL_OTP)이 필요하므로 2단계 화면으로 전환
        setStep(2)
      }
    } catch (err: any) {
      setError(err.message)
    }
  }

  // 이메일 코드 발송 API
  const handleSendEmailCode = async (userId: number) => {
    try {
      await fetch(`${API_BASE}/api/auth/login/step-up/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ userId }),
      })
      setCooldown(60) // 60초 쿨타임 시작
    } catch (err) {
      console.error('이메일 발송 실패', err)
    }
  }

  // ─── 로그인 2단계 공통 실행 함수 ─────────────────────────────────────────────
  const executeStep2 = async (payload: { userId: number; walletAddress: string; signature?: string; pin?: string; emailCode?: string; rememberDevice?: boolean; skipSignature?: boolean }) => {
    try {
      setError('')
      const res = await fetch(`${API_BASE}/api/auth/login/step2`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      })
      const data = await res.json()

      if (!res.ok) {
        // Step 2에서 400 에러 및 code가 내려온 경우 재분기 처리
        if (data.code) {
          if (data.code === 'WALLET_REQUIRED') setRequiredAuth('WALLET')
          else if (data.code === 'PIN_REQUIRED' || data.code === 'PIN_INVALID') setRequiredAuth('PIN')
          else if (data.code === 'EMAIL_OTP_REQUIRED' || data.code === 'EMAIL_OTP_INVALID') setRequiredAuth('EMAIL_OTP')
        }
        throw new Error(data.message)
      }

      // 로그인 성공 처리
      if (data.signingSecret) setSigningSecret(data.signingSecret)
      localStorage.setItem('loginTime', Date.now().toString())
      localStorage.setItem('upTick_user', JSON.stringify(data.user))

      const targetUrl = data.user?.is_survey_completed ? '/' : '/survey'

      // 로그인 성공 후 EMAIL_OTP를 통과했고 PIN이 없는 경우 검사
      if (requiredAuth === 'EMAIL_OTP') {
        const pfRes = await fetch(`${API_BASE}/api/trade/virtual/portfolio`, { credentials: 'include' })
        if (!pfRes.ok) {
          setPendingRedirectUrl(targetUrl)
          setShowPinPrompt(true)
          return
        }
      }

      window.location.href = targetUrl

    } catch (err: any) {
      setError(err.message)
    }
  }

  // ─── 인증 제출 버튼 클릭 시 ─────────────────────────────────────────────
  const handleLoginStep2Submit = async () => {
    if (!loginData) return

    let signature = ''
    if (requiredAuth === 'WALLET') {
      if (!window.ethereum) {
        setError('MetaMask가 설치되어 있지 않습니다')
        return
      }
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' })
      const address = accounts[0]

      const { keccak256, concat, toBytes, getAddress } = await import('viem')
      const CONTRACT_ADDRESS = '0xe7BBeA01683414DEd829f08e8d6822eF0CD7a38a'
      const CHAIN_ID = BigInt(11155111)

      const innerHash = keccak256(
        concat([
          toBytes(CHAIN_ID, { size: 32 }),
          toBytes(getAddress(CONTRACT_ADDRESS), { size: 20 }),
          toBytes(getAddress(loginData.walletAddress), { size: 20 }),
          toBytes(BigInt(loginData.nonce), { size: 32 }),
        ])
      )
      signature = await window.ethereum.request({
        method: 'personal_sign',
        params: [innerHash, address],
      })
    }

    await executeStep2({
      userId: loginData.userId,
      walletAddress: loginData.walletAddress,
      signature,
      pin: requiredAuth === 'PIN' ? pin : undefined,
      emailCode: requiredAuth === 'EMAIL_OTP' ? emailCode : undefined,
      rememberDevice,
    })
  }

  const inputStyle = {
    width: '100%',
    padding: '12px 14px',
    border: '1px solid #ddd',
    borderRadius: '10px',
    fontSize: '14px',
    outline: 'none',
    boxSizing: 'border-box' as const,
  }

  const btnStyle = {
    width: '100%',
    padding: '14px',
    backgroundColor: '#3CB371',
    color: '#fff',
    border: 'none',
    borderRadius: '10px',
    fontSize: '15px',
    fontWeight: '600',
    cursor: 'pointer',
    marginBottom: '16px',
  }

  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#f9fafb', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'sans-serif' }}>
      <div style={{ backgroundColor: '#fff', borderRadius: '20px', padding: '48px 40px', width: '400px', boxShadow: '0 4px 20px rgba(0,0,0,0.08)', position: 'relative' }}>
        
        {/* 로그인 성공 후 PIN 설정 유도 모달 */}
        {showPinPrompt && (
          <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', zIndex: 10 }}>
            <div style={{ backgroundColor: '#fff', padding: '24px', borderRadius: '16px', textAlign: 'center', width: '100%' }}>
              <p style={{ fontSize: '18px', fontWeight: 'bold', marginBottom: '12px' }}>🔐 간편 인증용 PIN 설정</p>
              <p style={{ fontSize: '13px', color: '#666', marginBottom: '20px', lineHeight: '1.5' }}>
                간편 인증용 PIN을 설정하면 다음부터 이메일 코드 없이 편리하게 로그인할 수 있어요.
              </p>
              <button 
                onClick={() => navigate('/mypage')}
                style={{ ...btnStyle, marginBottom: '8px' }}
              >
                지금 설정하기
              </button>
              <button 
                onClick={() => { window.location.href = pendingRedirectUrl }}
                style={{ width: '100%', padding: '10px', backgroundColor: 'transparent', border: 'none', color: '#888', cursor: 'pointer', fontSize: '13px' }}
              >
                나중에
              </button>
            </div>
          </div>
        )}

        {/* 로고 */}
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <span style={{ fontSize: '28px', fontWeight: 'bold', color: '#3CB371' }}>UpTick</span>
          <span style={{ fontSize: '22px', marginLeft: '6px' }}>📈</span>
          <p style={{ fontSize: '14px', color: '#888', marginTop: '8px' }}>투자의 기준을 높이다</p>
        </div>

        {error && <p style={{ fontSize: '13px', color: '#e53935', marginBottom: '12px', textAlign: 'center' }}>{error}</p>}

        {/* Step 1 - 이메일 + 비밀번호 */}
        {step === 1 && (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginBottom: '24px' }}>
              <div>
                <label style={{ fontSize: '13px', color: '#555', fontWeight: '600', display: 'block', marginBottom: '6px' }}>이메일</label>
                <input type="email" placeholder="이메일을 입력하세요" value={email} onChange={(e) => setEmail(e.target.value)} style={inputStyle} />
              </div>
              <div>
                <label style={{ fontSize: '13px', color: '#555', fontWeight: '600', display: 'block', marginBottom: '6px' }}>비밀번호</label>
                <input type="password" placeholder="비밀번호를 입력하세요" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleLoginStep1()} style={inputStyle} />
              </div>
            </div>
            <button onClick={handleLoginStep1} style={btnStyle}>로그인</button>
          </>
        )}

        {/* Step 2 - 적응형 인증 분기 화면 (WALLET / PIN / EMAIL_OTP) */}
        {step === 2 && (
          <>
            <div style={{ marginBottom: '24px', textAlign: 'center' }}>
              <p style={{ fontSize: '15px', fontWeight: 'bold', color: '#333', marginBottom: '8px' }}>
                안전을 위해 본인 확인이 필요합니다
              </p>

              {/* 1. 지갑 서명 분기 */}
              {requiredAuth === 'WALLET' && (
                <p style={{ fontSize: '13px', color: '#666' }}>MetaMask 지갑 서명을 진행해 주세요.</p>
              )}

              {/* 2. PIN 입력 분기 */}
              {requiredAuth === 'PIN' && (
                <div style={{ marginTop: '16px' }}>
                  <input 
                    type="password" 
                    maxLength={6} 
                    placeholder="PIN 6자리 입력" 
                    value={pin} 
                    onChange={(e) => setPin(e.target.value)} 
                    style={{ ...inputStyle, textAlign: 'center', letterSpacing: '8px', fontSize: '18px' }} 
                  />
                </div>
              )}

              {/* 3. 이메일 OTP 입력 분기 */}
              {requiredAuth === 'EMAIL_OTP' && (
                <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <input 
                    type="text" 
                    maxLength={6} 
                    placeholder="이메일 인증코드 6자리 (유효 5분)" 
                    value={emailCode} 
                    onChange={(e) => setEmailCode(e.target.value)} 
                    style={{ ...inputStyle, textAlign: 'center' }} 
                  />
                  <button 
                    disabled={cooldown > 0} 
                    onClick={() => handleSendEmailCode(loginData?.userId)}
                    style={{ padding: '8px', backgroundColor: cooldown > 0 ? '#ccc' : '#f0f0f0', border: 'none', borderRadius: '8px', fontSize: '12px', cursor: cooldown > 0 ? 'default' : 'pointer' }}
                  >
                    {cooldown > 0 ? `재발송 (${cooldown}초)` : '인증코드 재발송'}
                  </button>
                </div>
              )}

              {/* 이 기기 기억하기 체크박스 */}
              <div style={{ marginTop: '16px', textAlign: 'left', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <input type="checkbox" id="remember" checked={rememberDevice} onChange={(e) => setRememberDevice(e.target.checked)} />
                <label htmlFor="remember" style={{ color: '#555', cursor: 'pointer' }}>이 기기 기억하기</label>
              </div>
            </div>

            <button onClick={handleLoginStep2Submit} style={btnStyle}>
              {requiredAuth === 'WALLET' ? 'MetaMask 서명' : '인증 확인'}
            </button>
          </>
        )}

        {/* 하단 링크 */}
        <div style={{ textAlign: 'center', fontSize: '13px', color: '#888' }}>
          아직 계정이 없으신가요?{' '}
          <Link to="/register" style={{ color: '#3CB371', fontWeight: '600', textDecoration: 'none' }}>회원가입</Link>
        </div>
      </div>
    </div>
  )
}