import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [step, setStep] = useState(1)
  const [loginData, setLoginData] = useState<{
    userId: number
    walletAddress: string
    nonce: string
    isTrustedDevice?: boolean
    requireWalletSign?: boolean
  } | null>(null)
  const [error, setError] = useState('')
  const navigate = useNavigate()

  // ─── 로그인 1단계 ─────────────────────────────────────────────
  const handleLoginStep1 = async () => {
  try {
    setError('')
    const res = await fetch('http://localhost:3000/api/auth/login/step1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, password }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.message)

    setLoginData(data)

    if (data.isTrustedDevice) {
      // 신뢰 기기 → MetaMask 없이 자동 step2
      const res2 = await fetch('http://localhost:3000/api/auth/login/step2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ userId: data.userId, walletAddress: data.walletAddress, signature: '', skipSignature: true }),
      })
      const data2 = await res2.json()
      if (!res2.ok) throw new Error(data2.message)
      localStorage.setItem('loginTime', Date.now().toString())
      localStorage.setItem('upTick_user', JSON.stringify(data2.user))
      window.location.href = data2.user?.is_survey_completed ? '/' : '/survey'
    } else {
      setStep(2)
    }
  } catch (err: any) {
    setError(err.message)
  }
}

  // ─── 로그인 2단계 ─────────────────────────────────────────────
  const handleLoginStep2 = async () => {
    try {
      setError('')
      if (!window.ethereum) throw new Error('MetaMask가 설치되어 있지 않습니다')
      if (!loginData) throw new Error('로그인 정보가 없습니다')

      const accounts = await window.ethereum.request({
        method: 'eth_requestAccounts',
      })
      const address = accounts[0]

      // 백엔드 buildAuthMessage와 동일한 메시지 생성
      const { keccak256, concat, toBytes, getAddress } = await import('viem')

      const CONTRACT_ADDRESS = '0xe7BBeA01683414DEd829f08e8d6822eF0CD7a38a'
      const CHAIN_ID = BigInt(11155111) // Sepolia

      const innerHash = keccak256(
        concat([
          toBytes(CHAIN_ID, { size: 32 }),
          toBytes(getAddress(CONTRACT_ADDRESS), { size: 20 }),
          toBytes(getAddress(loginData.walletAddress), { size: 20 }),
          toBytes(BigInt(loginData.nonce), { size: 32 }),
        ]),
      )

      const signature = await window.ethereum.request({
        method: 'personal_sign',
        params: [innerHash, address],
      })

      const res = await fetch('http://localhost:3000/api/auth/login/step2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          userId: loginData.userId,
          walletAddress: loginData.walletAddress,
          signature,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message)
      localStorage.setItem('loginTime', Date.now().toString())
      localStorage.setItem('upTick_user', JSON.stringify(data.user))
      window.location.href = data.user?.is_survey_completed ? '/' : '/survey'

    } catch (err: any) {
      setError(err.message)
    }
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
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: '#f9fafb',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'sans-serif',
      }}
    >
      <div
        style={{
          backgroundColor: '#fff',
          borderRadius: '20px',
          padding: '48px 40px',
          width: '400px',
          boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
        }}
      >
        {/* 로고 */}
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <span
            style={{ fontSize: '28px', fontWeight: 'bold', color: '#3CB371' }}
          >
            UpTick
          </span>
          <span style={{ fontSize: '22px', marginLeft: '6px' }}>📈</span>
          <p style={{ fontSize: '14px', color: '#888', marginTop: '8px' }}>
            투자의 기준을 높이다
          </p>
        </div>

        {error && (
          <p
            style={{
              fontSize: '13px',
              color: '#e53935',
              marginBottom: '12px',
              textAlign: 'center',
            }}
          >
            {error}
          </p>
        )}

        {/* Step 1 - 이메일 + 비밀번호 */}
        {step === 1 && (
          <>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '14px',
                marginBottom: '24px',
              }}
            >
              <div>
                <label
                  style={{
                    fontSize: '13px',
                    color: '#555',
                    fontWeight: '600',
                    display: 'block',
                    marginBottom: '6px',
                  }}
                >
                  이메일
                </label>
                <input
                  type="email"
                  placeholder="이메일을 입력하세요"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  style={inputStyle}
                />
              </div>
              <div>
                <label
                  style={{
                    fontSize: '13px',
                    color: '#555',
                    fontWeight: '600',
                    display: 'block',
                    marginBottom: '6px',
                  }}
                >
                  비밀번호
                </label>
                <input
                  type="password"
                  placeholder="비밀번호를 입력하세요"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleLoginStep1()}
                  style={inputStyle}
                />
              </div>
            </div>
            <button onClick={handleLoginStep1} style={btnStyle}>
              로그인
            </button>
          </>
        )}

        {/* Step 2 - MetaMask 서명 */}
        {step === 2 && (
          <>
            <p
              style={{
                fontSize: '14px',
                color: '#555',
                marginBottom: '24px',
                textAlign: 'center',
              }}
            >
              MetaMask로 서명해주세요.
            </p>
            <button onClick={handleLoginStep2} style={btnStyle}>
              MetaMask 서명
            </button>
          </>
        )}

        {/* 하단 링크 */}
        <div style={{ textAlign: 'center', fontSize: '13px', color: '#888' }}>
          아직 계정이 없으신가요?{' '}
          <Link
            to="/register"
            style={{
              color: '#3CB371',
              fontWeight: '600',
              textDecoration: 'none',
            }}
          >
            회원가입
          </Link>
        </div>
        <div
          style={{ textAlign: 'center', marginTop: '12px', fontSize: '13px' }}
        >
          <Link to="/" style={{ color: '#aaa', textDecoration: 'none' }}>
            비밀번호를 잊으셨나요?
          </Link>
        </div>
      </div>
    </div>
  )
}
