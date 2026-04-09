import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTradeModeStore } from '../store/tradeModeStore'
import VirtualPortfolio from '../components/trade/VirtualPortfolio'

interface TrustedDevice {
  id: number
  device_type: string
  label: string
  ip: string
  last_used_at: string
  expires_at: string
}

interface LoginRecord {
  id: number
  ip_address: string
  country?: string
  region?: string
  city?: string
  user_agent?: string
  logged_at: string
}

interface UserInfo {
  id: number
  email: string
  name: string
  nickname: string | null
  phone: string | null
  is_phone_verified: boolean
  email_changed_at: string | null
}

const API = 'http://localhost:3000/api/auth'

export default function MyPage() {
  const navigate = useNavigate()

  const [activeTab, setActiveTab] = useState<'profile' | 'security' | 'investment' | 'settings'>('profile')
  const { mode } = useTradeModeStore()

  // ── 유저 정보 ──────────────────────────────────────────────
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null)
  const [nickname, setNickname] = useState('')
  const [nicknameCheck, setNicknameCheck] = useState<{ ok: boolean; msg: string } | null>(null)
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileMsg, setProfileMsg] = useState('')

  // ── 이메일 변경 ─────────────────────────────────────────────
  const [emailChanging, setEmailChanging] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const [emailCode, setEmailCode] = useState('')
  const [emailStep, setEmailStep] = useState<'input' | 'verify'>('input')
  const [emailMsg, setEmailMsg] = useState('')
  const [emailLoading, setEmailLoading] = useState(false)

  // ── 비밀번호 변경 ───────────────────────────────────────────
  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [pwMsg, setPwMsg] = useState('')
  const [pwLoading, setPwLoading] = useState(false)

  // ── 휴대폰 인증 ─────────────────────────────────────────────
  const [phone, setPhone] = useState('')
  const [phoneCode, setPhoneCode] = useState('')
  const [phoneStep, setPhoneStep] = useState<'input' | 'verify'>('input')
  const [phoneMsg, setPhoneMsg] = useState('')
  const [phoneLoading, setPhoneLoading] = useState(false)

  // ── 로그인 기록 ─────────────────────────────────────────────
  const [loginRecords, setLoginRecords] = useState<LoginRecord[]>([])

  // ── 기기 기억하기 ───────────────────────────────────────────
  const [devices, setDevices] = useState<TrustedDevice[]>([])
  const [isCurrentDeviceTrusted, setIsCurrentDeviceTrusted] = useState(false)
  const [deviceRegisterLoading, setDeviceRegisterLoading] = useState(false)

  // ── 탈퇴 ────────────────────────────────────────────────────
  const [withdrawError, setWithdrawError] = useState('')
  const [withdrawLoading, setWithdrawLoading] = useState(false)

  // ── 투자성향 ────────────────────────────────────────────────
  const userStr = localStorage.getItem('upTick_user')
  const user = userStr ? JSON.parse(userStr) : {}
  const investmentTypeName = user.investment_type_name || '아직 분석된 성향이 없습니다.'

  // ── 데이터 로드 ─────────────────────────────────────────────
  const fetchMyInfo = useCallback(async () => {
    try {
      const res = await fetch(`${API}/me`, { credentials: 'include' })
      if (!res.ok) return
      const data: UserInfo = await res.json()
      setUserInfo(data)
      setNickname(data.nickname ?? '')
      setPhone(data.phone ?? '')
    } catch {}
  }, [])

  const fetchDevices = useCallback(async () => {
    try {
      const res = await fetch(`${API}/devices`, { credentials: 'include' })
      if (!res.ok) return
      const data = await res.json()
      setDevices(data.devices ?? [])
      setIsCurrentDeviceTrusted(data.isTrustedDevice ?? false)
    } catch {}
  }, [])

  const fetchLoginRecords = useCallback(async () => {
    try {
      const res = await fetch(`${API}/login-records`, { credentials: 'include' })
      if (!res.ok) return
      const data = await res.json()
      setLoginRecords(data.records ?? [])
    } catch {}
  }, [])

  useEffect(() => {
    fetchMyInfo()
  }, [fetchMyInfo])

  useEffect(() => {
    if (activeTab === 'security') {
      fetchDevices()
      fetchLoginRecords()
    }
  }, [activeTab, fetchDevices, fetchLoginRecords])

  // ── 닉네임 중복 확인 ────────────────────────────────────────
  const handleCheckNickname = async () => {
    if (!nickname.trim()) { setNicknameCheck({ ok: false, msg: '닉네임을 입력해주세요' }); return }
    try {
      const res = await fetch(`${API}/nickname/check?nickname=${encodeURIComponent(nickname)}`, { credentials: 'include' })
      const data = await res.json()
      setNicknameCheck({ ok: res.ok, msg: data.message })
    } catch {
      setNicknameCheck({ ok: false, msg: '확인 중 오류가 발생했습니다' })
    }
  }

  // ── 닉네임 저장 ─────────────────────────────────────────────
  const handleSaveProfile = async () => {
    if (!nickname.trim()) { setProfileMsg('닉네임을 입력해주세요'); return }
    if (nicknameCheck?.ok === false) { setProfileMsg('닉네임 중복 확인을 먼저 해주세요'); return }
    try {
      setProfileSaving(true)
      setProfileMsg('')
      const res = await fetch(`${API}/me`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message)
      setProfileMsg('저장되었습니다')
      setNicknameCheck(null)
      fetchMyInfo()
    } catch (err: any) {
      setProfileMsg(err.message)
    } finally {
      setProfileSaving(false)
    }
  }

  // ── 이메일 변경 ─────────────────────────────────────────────
  const handleSendEmailChangeCode = async () => {
    if (!newEmail.trim()) { setEmailMsg('새 이메일을 입력해주세요'); return }
    try {
      setEmailLoading(true)
      setEmailMsg('')
      const res = await fetch(`${API}/email/change/send`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: newEmail }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message)
      setEmailStep('verify')
      setEmailMsg('인증코드가 발송되었습니다')
    } catch (err: any) {
      setEmailMsg(err.message)
    } finally {
      setEmailLoading(false)
    }
  }

  const handleVerifyEmail = async () => {
    if (!emailCode.trim()) { setEmailMsg('인증코드를 입력해주세요'); return }
    try {
      setEmailLoading(true)
      setEmailMsg('')
      const res = await fetch(`${API}/email`, {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: newEmail, code: emailCode }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message)
      setEmailMsg('이메일이 변경되었습니다')
      setEmailChanging(false)
      setEmailStep('input')
      setNewEmail('')
      setEmailCode('')
      fetchMyInfo()
    } catch (err: any) {
      setEmailMsg(err.message)
    } finally {
      setEmailLoading(false)
    }
  }

  // ── 비밀번호 변경 ───────────────────────────────────────────
  const handleChangePassword = async () => {
    if (!currentPw || !newPw) { setPwMsg('모든 항목을 입력해주세요'); return }
    try {
      setPwLoading(true)
      setPwMsg('')
      const res = await fetch(`${API}/password`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: currentPw, newPassword: newPw }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message)
      setPwMsg('비밀번호가 변경되었습니다')
      setCurrentPw('')
      setNewPw('')
    } catch (err: any) {
      setPwMsg(err.message)
    } finally {
      setPwLoading(false)
    }
  }

  // ── 휴대폰 인증 ─────────────────────────────────────────────
  const handleSendPhoneCode = async () => {
    if (!phone.trim()) { setPhoneMsg('휴대폰 번호를 입력해주세요'); return }
    try {
      setPhoneLoading(true)
      setPhoneMsg('')
      const res = await fetch(`${API}/phone/send`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message)
      setPhoneStep('verify')
      setPhoneMsg('인증번호가 발송되었습니다')
    } catch (err: any) {
      setPhoneMsg(err.message)
    } finally {
      setPhoneLoading(false)
    }
  }

  const handleVerifyPhone = async () => {
    if (!phoneCode.trim()) { setPhoneMsg('인증번호를 입력해주세요'); return }
    try {
      setPhoneLoading(true)
      setPhoneMsg('')
      const res = await fetch(`${API}/phone/verify`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, code: phoneCode }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message)
      setPhoneMsg('휴대폰 인증이 완료되었습니다')
      setPhoneStep('input')
      setPhoneCode('')
      fetchMyInfo()
    } catch (err: any) {
      setPhoneMsg(err.message)
    } finally {
      setPhoneLoading(false)
    }
  }

  // ── 기기 등록 / 해제 ────────────────────────────────────────
  const handleRegisterDevice = async () => {
    if (!window.confirm('현재 기기를 신뢰 기기로 등록합니다.\n기존에 등록된 모든 기기는 자동으로 해제됩니다.')) return
    try {
      setDeviceRegisterLoading(true)
      const res = await fetch(`${API}/devices/register`, { method: 'POST', credentials: 'include' })
      if (!res.ok) throw new Error('등록 실패')
      await fetchDevices()
    } catch (err: any) {
      alert(err.message)
    } finally {
      setDeviceRegisterLoading(false)
    }
  }

  const handleRemoveDevice = async (deviceId: number) => {
    if (!window.confirm('해당 기기의 신뢰를 해제하시겠습니까?')) return
    try {
      const res = await fetch(`${API}/devices/${deviceId}`, { method: 'DELETE', credentials: 'include' })
      if (!res.ok) throw new Error('해제 실패')
      await fetchDevices()
    } catch (err: any) {
      alert(err.message)
    }
  }

  // ── 탈퇴 ────────────────────────────────────────────────────
  const handleWithdraw = async () => {
    if (!window.confirm('정말 탈퇴하시겠습니까? 이 작업은 되돌릴 수 없습니다.')) return
    try {
      setWithdrawLoading(true)
      setWithdrawError('')
      const res = await fetch(`${API}/withdraw`, { method: 'DELETE', credentials: 'include' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message)
      document.cookie = 'accessToken=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;'
      document.cookie = 'refreshToken=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;'
      document.cookie = 'isLoggedIn=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;'
      window.location.href = '/'
    } catch (err: any) {
      setWithdrawError(err.message)
    } finally {
      setWithdrawLoading(false)
    }
  }

  // ── 투자성향 재설문 ─────────────────────────────────────────
  const handleRetakeSurvey = () => {
    if (window.confirm('투자 성향을 다시 분석하시겠습니까? 기존 분석 데이터가 초기화됩니다.')) {
      localStorage.setItem('upTick_user', JSON.stringify({
        ...user,
        is_survey_completed: false,
        investment_type_id: null,
        investment_type_name: null,
        survey_raw_data: null,
      }))
      navigate('/survey')
    }
  }

  // ── 로그인 기록 기기 요약 ───────────────────────────────────
  const parseUserAgent = (ua?: string) => {
    if (!ua) return '알 수 없는 기기'
    const browser = /Edg\//i.test(ua) ? 'Edge' : /Chrome/i.test(ua) ? 'Chrome' : /Firefox/i.test(ua) ? 'Firefox' : /Safari/i.test(ua) ? 'Safari' : '기타'
    const os = /iPhone|iPad/i.test(ua) ? 'iOS' : /Android/i.test(ua) ? 'Android' : /Windows/i.test(ua) ? 'Windows' : /Mac/i.test(ua) ? 'Mac' : 'Linux'
    return `${browser}, ${os}`
  }

  return (
    <div className="w-full min-h-screen bg-white pb-20 font-sans text-gray-800">
      <div className="container mx-auto px-6 max-w-5xl">

        {/* 1. 자산 관리 섹션 */}
        <section className="py-12 border-b border-gray-200">
          <div className="flex items-center gap-3 mb-8">
            <h2 className="text-2xl font-black">자산 관리</h2>
            <span style={{
              fontSize: '12px', fontWeight: '700', padding: '3px 10px', borderRadius: '20px',
              backgroundColor: mode === 'virtual' ? '#f0fdf4' : '#fff7ed',
              color: mode === 'virtual' ? '#15803d' : '#c2410c',
            }}>
              {mode === 'virtual' ? '📊 모의투자' : '💼 실거래'}
            </span>
          </div>
          {mode === 'virtual' ? (
            <VirtualPortfolio />
          ) : (
            <div className="flex items-center gap-20">
              <div className="w-56 h-56 bg-slate-50 rounded-full border-2 border-dashed border-gray-200 flex items-center justify-center text-gray-300 text-sm">
                그래프 영역 (데이터 대기 중)
              </div>
              <div className="flex-1 flex flex-col gap-6">
                <div className="h-40 bg-slate-50 rounded-xl border border-dashed border-gray-200 flex items-center justify-center text-gray-300 text-sm">
                  보유 주식 목록이 여기에 표시됩니다.
                </div>
              </div>
            </div>
          )}
        </section>

        {/* 2. 계정 관리 섹션 */}
        <section className="py-12">
          <h2 className="text-2xl font-black mb-10">계정 관리</h2>

          <div className="flex items-start gap-12">
            {/* 좌측: 탭 메뉴 */}
            <div className="w-48 shrink-0 flex flex-col gap-2">
              {(['profile', 'security', 'investment', 'settings'] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`text-left px-4 py-3 rounded-xl font-bold transition ${activeTab === tab ? 'bg-[#22C55E]/10 text-[#22C55E]' : 'text-gray-400 hover:bg-gray-50 hover:text-gray-800'}`}
                >
                  {tab === 'profile' ? '프로필 & 개인정보' : tab === 'security' ? '보안 및 인증' : tab === 'investment' ? '투자 성향 정보' : '환경설정'}
                </button>
              ))}
            </div>

            {/* 우측: 탭별 콘텐츠 */}
            <div className="flex-1 min-h-[400px] bg-white border border-gray-100 rounded-3xl shadow-sm p-10">

              {/* ── 프로필 탭 ── */}
              {activeTab === 'profile' && (
                <div className="space-y-10">
                  <div>
                    <h3 className="font-black text-xl mb-6">프로필 설정</h3>
                    <div className="space-y-6 max-w-md">

                      {/* 이름 (변경 불가) */}
                      <div>
                        <label className="block font-bold text-sm text-gray-600 mb-2">이름</label>
                        <input
                          type="text"
                          value={userInfo?.name ?? ''}
                          readOnly
                          className="w-full p-3 border border-gray-200 rounded-xl bg-gray-50 text-gray-400 outline-none cursor-not-allowed"
                        />
                        <p className="text-xs text-gray-400 mt-1">이름은 변경할 수 없습니다.</p>
                      </div>

                      {/* 닉네임 */}
                      <div>
                        <label className="block font-bold text-sm text-gray-600 mb-2">
                          닉네임
                          <span className="ml-2 text-xs text-gray-400 font-normal">커뮤니티에서 사용됩니다</span>
                        </label>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={nickname}
                            onChange={(e) => { setNickname(e.target.value); setNicknameCheck(null) }}
                            placeholder="2~20자, 한글/영문/숫자/_"
                            className="flex-1 p-3 border border-gray-200 rounded-xl outline-none focus:border-[#22C55E] transition"
                          />
                          <button
                            onClick={handleCheckNickname}
                            className="px-4 border border-[#22C55E] text-[#22C55E] font-bold rounded-xl hover:bg-[#22C55E] hover:text-white transition text-sm whitespace-nowrap"
                          >
                            중복확인
                          </button>
                        </div>
                        {nicknameCheck && (
                          <p className={`text-xs mt-1 font-semibold ${nicknameCheck.ok ? 'text-[#22C55E]' : 'text-red-500'}`}>
                            {nicknameCheck.msg}
                          </p>
                        )}
                      </div>

                      {/* 이메일 */}
                      <div>
                        <label className="block font-bold text-sm text-gray-600 mb-2">
                          이메일
                          {userInfo?.email_changed_at && (() => {
                            const days = Math.floor((Date.now() - new Date(userInfo.email_changed_at!).getTime()) / (1000 * 60 * 60 * 24))
                            const daysLeft = 30 - days
                            return daysLeft > 0
                              ? <span className="ml-2 text-xs text-orange-400 font-normal">변경까지 {daysLeft}일 남음</span>
                              : null
                          })()}
                        </label>
                        <div className="flex gap-2">
                          <input
                            type="email"
                            value={userInfo?.email ?? ''}
                            readOnly
                            className="flex-1 p-3 border border-gray-200 rounded-xl bg-gray-50 text-gray-500 outline-none"
                          />
                          <button
                            onClick={() => { setEmailChanging(v => !v); setEmailMsg(''); setEmailStep('input'); setNewEmail(''); setEmailCode('') }}
                            className="px-4 border border-gray-300 font-bold rounded-xl hover:bg-gray-50 transition text-sm"
                          >
                            {emailChanging ? '취소' : '변경'}
                          </button>
                        </div>

                        {emailChanging && (
                          <div className="mt-3 space-y-2">
                            <div className="flex gap-2">
                              <input
                                type="email"
                                placeholder="새 이메일 주소"
                                value={newEmail}
                                onChange={(e) => setNewEmail(e.target.value)}
                                disabled={emailStep === 'verify'}
                                className="flex-1 p-3 border border-gray-200 rounded-xl outline-none focus:border-[#22C55E] transition text-sm disabled:bg-gray-50"
                              />
                              <button
                                onClick={handleSendEmailChangeCode}
                                disabled={emailLoading || emailStep === 'verify'}
                                className="px-4 border border-[#22C55E] text-[#22C55E] font-bold rounded-xl hover:bg-[#22C55E] hover:text-white transition text-sm disabled:opacity-50 whitespace-nowrap"
                              >
                                인증코드 발송
                              </button>
                            </div>
                            {emailStep === 'verify' && (
                              <div className="flex gap-2">
                                <input
                                  type="text"
                                  placeholder="인증코드 6자리"
                                  value={emailCode}
                                  onChange={(e) => setEmailCode(e.target.value)}
                                  className="flex-1 p-3 border border-gray-200 rounded-xl outline-none focus:border-[#22C55E] transition text-sm"
                                />
                                <button
                                  onClick={handleVerifyEmail}
                                  disabled={emailLoading}
                                  className="px-4 bg-[#22C55E] text-white font-bold rounded-xl hover:bg-[#1ba850] transition text-sm disabled:opacity-50"
                                >
                                  확인
                                </button>
                              </div>
                            )}
                            {emailMsg && (
                              <p className={`text-xs font-semibold ${emailMsg.includes('발송') || emailMsg.includes('변경되었습니다') ? 'text-[#22C55E]' : 'text-red-500'}`}>
                                {emailMsg}
                              </p>
                            )}
                            <p className="text-xs text-gray-400">* 이메일은 30일에 1번만 변경할 수 있습니다.</p>
                          </div>
                        )}
                      </div>

                      {profileMsg && (
                        <p className={`text-sm font-semibold ${profileMsg === '저장되었습니다' ? 'text-[#22C55E]' : 'text-red-500'}`}>{profileMsg}</p>
                      )}

                      <button
                        onClick={handleSaveProfile}
                        disabled={profileSaving}
                        className="w-full py-4 bg-gray-900 text-white font-bold rounded-xl hover:bg-gray-800 transition disabled:opacity-50"
                      >
                        {profileSaving ? '저장 중...' : '닉네임 저장하기'}
                      </button>
                    </div>
                  </div>

                  {/* 회원 탈퇴 */}
                  <div className="pt-8 border-t border-gray-100">
                    <h4 className="text-sm font-bold text-gray-800 mb-2">계정 탈퇴</h4>
                    <p className="text-xs text-gray-400 mb-4">
                      탈퇴 시 모든 데이터는 복구되지 않으며 온체인 지갑 등록도 해제됩니다.
                    </p>
                    {withdrawError && <p className="text-xs text-red-500 mb-3">{withdrawError}</p>}
                    <button
                      onClick={handleWithdraw}
                      disabled={withdrawLoading}
                      className="text-sm font-bold text-red-400 hover:text-red-600 underline underline-offset-4 transition disabled:text-gray-300 disabled:cursor-not-allowed"
                    >
                      {withdrawLoading ? '처리 중...' : '회원 탈퇴하기'}
                    </button>
                  </div>
                </div>
              )}

              {/* ── 보안 탭 ── */}
              {activeTab === 'security' && (
                <div className="space-y-10">
                  <h3 className="font-black text-xl mb-6">보안 및 인증</h3>

                  <div className="space-y-8 max-w-lg">

                    {/* 비밀번호 변경 */}
                    <div>
                      <h4 className="font-bold text-gray-800 mb-3">비밀번호 변경</h4>
                      <div className="space-y-3">
                        <input
                          type="password"
                          placeholder="현재 비밀번호"
                          value={currentPw}
                          onChange={(e) => setCurrentPw(e.target.value)}
                          className="w-full p-3 border border-gray-200 rounded-xl outline-none focus:border-[#22C55E] transition"
                        />
                        <input
                          type="password"
                          placeholder="새 비밀번호 (영문+숫자+특수문자 8자 이상)"
                          value={newPw}
                          onChange={(e) => setNewPw(e.target.value)}
                          className="w-full p-3 border border-gray-200 rounded-xl outline-none focus:border-[#22C55E] transition"
                        />
                        {pwMsg && (
                          <p className={`text-sm font-semibold ${pwMsg.includes('변경되었습니다') ? 'text-[#22C55E]' : 'text-red-500'}`}>{pwMsg}</p>
                        )}
                        <button
                          onClick={handleChangePassword}
                          disabled={pwLoading}
                          className="px-5 py-3 bg-gray-900 text-white font-bold rounded-xl hover:bg-gray-800 transition text-sm disabled:opacity-50"
                        >
                          {pwLoading ? '변경 중...' : '비밀번호 업데이트'}
                        </button>
                      </div>
                    </div>

                    <div className="border-t border-gray-100" />

                    {/* 휴대폰 번호 인증 */}
                    <div>
                      <h4 className="font-bold text-gray-800 mb-3">
                        휴대폰 번호
                        {userInfo?.is_phone_verified && (
                          <span className="ml-2 text-xs text-[#22C55E] font-semibold bg-green-50 px-2 py-0.5 rounded-full">인증 완료</span>
                        )}
                      </h4>
                      <div className="space-y-3">
                        <div className="flex gap-2">
                          <input
                            type="tel"
                            placeholder="010-0000-0000"
                            value={phone}
                            onChange={(e) => setPhone(e.target.value)}
                            disabled={phoneStep === 'verify'}
                            className="flex-1 p-3 border border-gray-200 rounded-xl outline-none focus:border-[#22C55E] transition disabled:bg-gray-50"
                          />
                          <button
                            onClick={handleSendPhoneCode}
                            disabled={phoneLoading || phoneStep === 'verify'}
                            className="px-4 border border-[#22C55E] text-[#22C55E] font-bold rounded-xl hover:bg-[#22C55E] hover:text-white transition text-sm disabled:opacity-50"
                          >
                            인증번호 발송
                          </button>
                        </div>
                        {phoneStep === 'verify' && (
                          <div className="flex gap-2">
                            <input
                              type="text"
                              placeholder="인증번호 6자리"
                              value={phoneCode}
                              onChange={(e) => setPhoneCode(e.target.value)}
                              className="flex-1 p-3 border border-gray-200 rounded-xl outline-none focus:border-[#22C55E] transition"
                            />
                            <button
                              onClick={handleVerifyPhone}
                              disabled={phoneLoading}
                              className="px-4 bg-[#22C55E] text-white font-bold rounded-xl hover:bg-[#1ba850] transition text-sm disabled:opacity-50"
                            >
                              확인
                            </button>
                          </div>
                        )}
                        {phoneMsg && (
                          <p className={`text-sm font-semibold ${phoneMsg.includes('완료') || phoneMsg.includes('발송') ? 'text-[#22C55E]' : 'text-red-500'}`}>{phoneMsg}</p>
                        )}
                      </div>
                    </div>

                    <div className="border-t border-gray-100" />

                    {/* 로그인 기록 */}
                    <div>
                      <h4 className="font-bold text-gray-800 mb-3 flex justify-between items-center">
                        최근 로그인 기록
                        <button onClick={fetchLoginRecords} className="text-xs text-[#22C55E] font-bold underline">새로고침</button>
                      </h4>
                      {loginRecords.length === 0 ? (
                        <p className="text-sm text-gray-400 text-center py-4 border border-gray-100 rounded-xl">기록이 없습니다.</p>
                      ) : (
                        <div className="border border-gray-200 rounded-xl overflow-hidden">
                          <table className="w-full text-sm text-left">
                            <thead className="bg-gray-50 text-gray-500">
                              <tr>
                                <th className="p-3 font-semibold">일시</th>
                                <th className="p-3 font-semibold">IP / 기기</th>
                                <th className="p-3 font-semibold">위치</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100 text-gray-600">
                              {loginRecords.map(r => (
                                <tr key={r.id}>
                                  <td className="p-3">{new Date(r.logged_at).toLocaleString('ko-KR')}</td>
                                  <td className="p-3">
                                    {r.ip_address}<br />
                                    <span className="text-xs text-gray-400">{parseUserAgent(r.user_agent)}</span>
                                  </td>
                                  <td className="p-3">
                                    {[r.country, r.city].filter(Boolean).join(', ') || '알 수 없음'}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>

                    <div className="border-t border-gray-100" />

                    {/* 기기 기억하기 */}
                    <div>
                      <h4 className="font-bold text-gray-800 mb-1 flex justify-between items-center">
                        기기 기억하기
                        <button onClick={fetchDevices} className="text-xs text-[#22C55E] font-bold underline">새로고침</button>
                      </h4>
                      <p className="text-xs text-gray-400 mb-4">
                        신뢰 기기로 등록하면 로그인 시 2단계 인증을 건너뜁니다. 기기 유형당 1대만 유지됩니다.
                      </p>

                      {!isCurrentDeviceTrusted && (
                        <button
                          onClick={handleRegisterDevice}
                          disabled={deviceRegisterLoading}
                          className="mb-4 px-5 py-2.5 bg-[#22C55E] text-white text-sm font-bold rounded-xl hover:bg-[#1ba850] transition disabled:opacity-50"
                        >
                          {deviceRegisterLoading ? '등록 중...' : '현재 기기를 신뢰 기기로 등록'}
                        </button>
                      )}

                      {devices.length === 0 ? (
                        <p className="text-sm text-gray-400 py-4 text-center border border-gray-100 rounded-xl">등록된 신뢰 기기가 없습니다.</p>
                      ) : (
                        <div className="space-y-2">
                          {devices.map(d => (
                            <div key={d.id} className="flex justify-between items-center p-4 border border-gray-100 rounded-xl bg-gray-50">
                              <div>
                                <p className="font-bold text-sm text-gray-800">{d.label}</p>
                                <p className="text-xs text-gray-400 mt-0.5">IP: {d.ip} · 마지막 사용: {new Date(d.last_used_at).toLocaleString('ko-KR')}</p>
                              </div>
                              <button
                                onClick={() => handleRemoveDevice(d.id)}
                                className="text-xs text-red-400 hover:text-red-600 font-bold bg-white border border-red-200 hover:bg-red-50 px-3 py-1.5 rounded-lg transition"
                              >
                                해제
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* ── 투자 성향 탭 ── */}
              {activeTab === 'investment' && (
                <div className="space-y-8">
                  <h3 className="font-black text-xl mb-6">투자 성향 분석 결과</h3>
                  <div className="max-w-md">
                    <div className="bg-gray-50 border border-gray-200 rounded-2xl p-8 text-center mb-6">
                      <p className="text-gray-500 text-sm mb-2">회원님의 현재 투자 유형은</p>
                      <p className="text-2xl font-bold text-[#22C55E] mb-2">{investmentTypeName}</p>
                      <p className="text-sm text-gray-600">입니다.</p>
                    </div>
                    <p className="text-xs text-gray-500 mb-4 leading-relaxed">
                      * 투자 성향은 행동 패턴이나 시장 상황에 따라 변경될 수 있습니다. 현재 상황과 맞지 않으면 재설문해 보세요.
                    </p>
                    <button
                      onClick={handleRetakeSurvey}
                      className="w-full py-4 border-2 border-[#22C55E] text-[#22C55E] font-bold rounded-xl hover:bg-[#22C55E]/5 transition flex justify-center items-center gap-2"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      투자 성향 재설문하기
                    </button>
                  </div>
                </div>
              )}

              {/* ── 환경설정 탭 ── */}
              {activeTab === 'settings' && (
                <div className="space-y-8">
                  <h3 className="font-black text-xl mb-6">환경설정</h3>
                  <div className="space-y-4 max-w-lg">
                    <div className="p-5 border border-gray-100 rounded-2xl flex justify-between items-center bg-gray-50/50">
                      <div>
                        <h4 className="font-bold text-gray-800">앱 알림 (Push)</h4>
                        <p className="text-xs text-gray-500 mt-1">주가 급등락, 자산 변동 알림을 받습니다.</p>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" className="sr-only peer" defaultChecked />
                        <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#22C55E]"></div>
                      </label>
                    </div>
                    <div className="p-5 border border-gray-100 rounded-2xl flex justify-between items-center bg-gray-50/50">
                      <div>
                        <h4 className="font-bold text-gray-800">커뮤니티 활동 공개</h4>
                        <p className="text-xs text-gray-500 mt-1">내가 작성한 글과 댓글을 다른 유저에게 공개합니다.</p>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" className="sr-only peer" />
                        <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#22C55E]"></div>
                      </label>
                    </div>
                    <div className="pt-6">
                      <a href="/terms" target="_blank" rel="noreferrer" className="text-sm font-semibold text-gray-500 hover:text-gray-800 flex items-center gap-1 transition">
                        이용약관 및 개인정보처리방침
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
                      </a>
                    </div>
                  </div>
                </div>
              )}

            </div>
          </div>
        </section>

      </div>
    </div>
  )
}
