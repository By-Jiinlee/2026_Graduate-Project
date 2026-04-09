import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTradeModeStore } from '../store/tradeModeStore'
import VirtualPortfolio from '../components/trade/VirtualPortfolio'

export default function MyPage() {
  const navigate = useNavigate()
  
  // 💡 탭 상태 관리에 'investment' 추가
  const [activeTab, setActiveTab] = useState<'profile' | 'security' | 'investment' | 'settings'>('profile')

  const [nickname, setNickname] = useState('UpTickUser')
  const [bio, setBio] = useState('')

  const [withdrawError, setWithdrawError] = useState('')
  const [withdrawLoading, setWithdrawLoading] = useState(false)
  const { mode } = useTradeModeStore()

  // 💡 로컬스토리지에서 유저의 투자 성향 정보를 가져옵니다.
  const userStr = localStorage.getItem('upTick_user')
  const user = userStr ? JSON.parse(userStr) : {}
  const investmentTypeName = user.investment_type_name || '아직 분석된 성향이 없습니다.'

  useEffect(() => {
    // 필요 시 로그인 체크 로직 추가
  }, [navigate])

  const handleCheckNickname = () => {
    if (!nickname.trim()) {
      alert('닉네임을 입력해주세요.')
      return
    }
    alert(`[API 연동 필요] 백엔드에 '${nickname}' 중복확인 요청을 보내야 합니다.`);
  }

  const handleSaveProfile = () => {
    if (!nickname.trim()) {
      alert('닉네임을 입력해주세요.')
      return
    }
    alert(`[API 연동 필요] 변경된 프로필 저장 요청을 보내야 합니다.\n- 닉네임: ${nickname}\n- 소개: ${bio}`);
  }

  const handleWithdraw = async () => {
    if (!window.confirm('정말 탈퇴하시겠습니까? 이 작업은 되돌릴 수 없습니다.')) return

    try {
      setWithdrawLoading(true)
      setWithdrawError('')
      const res = await fetch('http://localhost:3000/api/auth/withdraw', {
        method: 'DELETE',
        credentials: 'include',
      })
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

  // 💡 투자 성향 재설문하기 버튼 핸들러
  const handleRetakeSurvey = () => {
    if (window.confirm('투자 성향을 다시 분석하시겠습니까? 기존 분석 데이터가 초기화됩니다.')) {
      // 로컬스토리지에서 설문 완료 상태만 해제
      localStorage.setItem('upTick_user', JSON.stringify({
        ...user,
        is_survey_completed: false,
        investment_type_id: null,
        investment_type_name: null,
        survey_raw_data: null
      }));
      // 설문 페이지로 이동
      navigate('/survey');
    }
  }

  return (
    <div className="w-full min-h-screen bg-white pb-20 font-sans text-gray-800">
      <div className="container mx-auto px-6 max-w-5xl">
        
        {/* 1. 자산 관리 섹션 */}
        <section className="py-12 border-b border-gray-200">
          <div className="flex items-center gap-3 mb-8">
            <h2 className="text-2xl font-black">자산 관리</h2>
            <span style={{
              fontSize: '12px',
              fontWeight: '700',
              padding: '3px 10px',
              borderRadius: '20px',
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

        {/* 3. 계정 관리 섹션 */}
        <section className="py-12">
          <h2 className="text-2xl font-black mb-10">계정 관리</h2>
          
          <div className="flex items-start gap-12">
            {/* 좌측: 탭 메뉴 */}
            <div className="w-48 shrink-0 flex flex-col gap-2">
              <button 
                onClick={() => setActiveTab('profile')}
                className={`text-left px-4 py-3 rounded-xl font-bold transition ${activeTab === 'profile' ? 'bg-[#22C55E]/10 text-[#22C55E]' : 'text-gray-400 hover:bg-gray-50 hover:text-gray-800'}`}
              >
                프로필 & 개인정보
              </button>
              <button 
                onClick={() => setActiveTab('security')}
                className={`text-left px-4 py-3 rounded-xl font-bold transition ${activeTab === 'security' ? 'bg-[#22C55E]/10 text-[#22C55E]' : 'text-gray-400 hover:bg-gray-50 hover:text-gray-800'}`}
              >
                보안 및 인증
              </button>
              {/* 💡 투자 성향 정보 탭 추가 */}
              <button 
                onClick={() => setActiveTab('investment')}
                className={`text-left px-4 py-3 rounded-xl font-bold transition ${activeTab === 'investment' ? 'bg-[#22C55E]/10 text-[#22C55E]' : 'text-gray-400 hover:bg-gray-50 hover:text-gray-800'}`}
              >
                투자 성향 정보
              </button>
              <button 
                onClick={() => setActiveTab('settings')}
                className={`text-left px-4 py-3 rounded-xl font-bold transition ${activeTab === 'settings' ? 'bg-[#22C55E]/10 text-[#22C55E]' : 'text-gray-400 hover:bg-gray-50 hover:text-gray-800'}`}
              >
                환경설정
              </button>
            </div>

            {/* 우측: 탭별 콘텐츠 */}
            <div className="flex-1 min-h-[400px] bg-white border border-gray-100 rounded-3xl shadow-sm p-10">
              
              {/* --- 프로필 설정 탭 --- */}
              {activeTab === 'profile' && (
                <div className="animate-fade-in space-y-10">
                  <div>
                    <h3 className="font-black text-xl mb-6">프로필 설정</h3>
                    
                    <div className="space-y-6 max-w-md">
                      {/* 이미지 변경 */}
                      <div>
                        <label className="block font-bold text-sm text-gray-600 mb-3">프로필 이미지</label>
                        <div className="flex items-center gap-5">
                          <div className="w-20 h-20 bg-slate-100 rounded-full flex items-center justify-center border border-gray-200">
                            <svg className="w-10 h-10 text-gray-300" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clipRule="evenodd" />
                            </svg>
                          </div>
                          <div className="flex gap-2">
                            <button className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-semibold hover:bg-gray-50 transition" onClick={() => alert('[API 연동 필요] 이미지 업로드 로직')}>이미지 변경</button>
                            <button className="px-4 py-2 border border-red-200 text-red-500 rounded-lg text-sm font-semibold hover:bg-red-50 transition" onClick={() => alert('[API 연동 필요] 기본 이미지로 변경 로직')}>삭제</button>
                          </div>
                        </div>
                      </div>

                      {/* 닉네임 변경 */}
                      <div>
                        <label className="block font-bold text-sm text-gray-600 mb-2">닉네임</label>
                        <div className="flex gap-2">
                          <input 
                            type="text" 
                            value={nickname}
                            onChange={(e) => setNickname(e.target.value)}
                            className="flex-1 p-3 border border-gray-200 rounded-xl outline-none focus:border-[#22C55E] transition" 
                          />
                          <button 
                            onClick={handleCheckNickname}
                            className="px-5 bg-[#22C55E] text-white font-bold rounded-xl hover:bg-[#1ba850] transition"
                          >
                            중복확인
                          </button>
                        </div>
                      </div>

                      {/* 개인정보 변경 */}
                      <div>
                        <label className="block font-bold text-sm text-gray-600 mb-2">개인정보 (한 줄 소개 등)</label>
                        <textarea 
                          rows={3} 
                          value={bio}
                          onChange={(e) => setBio(e.target.value)}
                          placeholder="나를 표현할 수 있는 소개를 적어주세요." 
                          className="w-full p-3 border border-gray-200 rounded-xl outline-none focus:border-[#22C55E] transition resize-none"
                        ></textarea>
                      </div>

                      <button 
                        onClick={handleSaveProfile}
                        className="w-full py-4 bg-gray-900 text-white font-bold rounded-xl hover:bg-gray-800 transition mt-2"
                      >
                        프로필 저장하기
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

              {/* --- 보안 및 인증 탭 --- */}
              {activeTab === 'security' && (
                <div className="animate-fade-in space-y-10">
                  <h3 className="font-black text-xl mb-6">보안 및 인증</h3>
                  
                  <div className="space-y-8 max-w-lg">
                    {/* 비밀번호 관리 */}
                    <div>
                      <h4 className="font-bold text-gray-800 mb-3">비밀번호 변경</h4>
                      <div className="space-y-3">
                        <input type="password" placeholder="현재 비밀번호" className="w-full p-3 border border-gray-200 rounded-xl outline-none focus:border-[#22C55E] transition" />
                        <input type="password" placeholder="새 비밀번호" className="w-full p-3 border border-gray-200 rounded-xl outline-none focus:border-[#22C55E] transition" />
                        <button onClick={() => alert('[API 연동 필요] 비밀번호 변경 로직 (PATCH /api/users/password)')} className="px-5 py-3 bg-gray-900 text-white font-bold rounded-xl hover:bg-gray-800 transition text-sm">비밀번호 업데이트</button>
                      </div>
                    </div>

                    <div className="border-t border-gray-100"></div>

                    {/* 이메일 및 전화번호 인증 */}
                    <div>
                      <h4 className="font-bold text-gray-800 mb-3">연락처 정보</h4>
                      <div className="space-y-4">
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">이메일</label>
                          <div className="flex gap-2">
                            <input type="email" defaultValue="user@uptick.com" className="flex-1 p-3 border border-gray-200 rounded-xl bg-gray-50 text-gray-500 outline-none" readOnly />
                            <button onClick={() => alert('[API 연동 필요] 이메일 변경 모달 띄우기')} className="px-4 border border-gray-300 font-bold rounded-xl hover:bg-gray-50 transition text-sm">변경</button>
                          </div>
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">휴대폰 번호</label>
                          <div className="flex gap-2">
                            <input type="tel" placeholder="010-0000-0000" className="flex-1 p-3 border border-gray-200 rounded-xl outline-none focus:border-[#22C55E] transition" />
                            <button onClick={() => alert('[API 연동 필요] 휴대폰 문자 인증번호 발송')} className="px-4 border border-[#22C55E] text-[#22C55E] font-bold rounded-xl hover:bg-[#22C55E] hover:text-white transition text-sm">인증하기</button>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="border-t border-gray-100"></div>

                    {/* 로그인 기록 */}
                    <div>
                      <h4 className="font-bold text-gray-800 mb-3 flex justify-between items-center">
                        최근 로그인 기록 (위치)
                        <button onClick={() => alert('[API 연동 필요] 로그인 기록 불러오기 (GET /api/users/login-logs)')} className="text-xs text-[#22C55E] font-bold underline">새로고침</button>
                      </h4>
                      <div className="border border-gray-200 rounded-xl overflow-hidden">
                        <table className="w-full text-sm text-left">
                          <thead className="bg-gray-50 text-gray-500">
                            <tr>
                              <th className="p-3 font-semibold">일시</th>
                              <th className="p-3 font-semibold">IP / 기기</th>
                              <th className="p-3 font-semibold">위치(추정)</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100 text-gray-600">
                            <tr>
                              <td className="p-3">2026.04.09 12:30</td>
                              <td className="p-3">192.168.0.1<br/><span className="text-xs text-gray-400">Chrome, Windows</span></td>
                              <td className="p-3">대한민국, 고양시</td>
                            </tr>
                            <tr>
                              <td className="p-3">2026.04.08 09:15</td>
                              <td className="p-3">203.255.10.1<br/><span className="text-xs text-gray-400">Safari, iPhone</span></td>
                              <td className="p-3">대한민국, 서울특별시</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* 💡 --- 투자 성향 정보 탭 --- */}
              {activeTab === 'investment' && (
                <div className="animate-fade-in space-y-8">
                  <h3 className="font-black text-xl mb-6">투자 성향 분석 결과</h3>
                  
                  <div className="max-w-md">
                    <div className="bg-gray-50 border border-gray-200 rounded-2xl p-8 text-center mb-6">
                      <p className="text-gray-500 text-sm mb-2">회원님의 현재 투자 유형은</p>
                      <p className="text-2xl font-bold text-[#22C55E] mb-2">{investmentTypeName}</p>
                      <p className="text-sm text-gray-600">입니다.</p>
                    </div>

                    <p className="text-xs text-gray-500 mb-4 leading-relaxed">
                      * 투자 성향은 회원님의 행동 패턴이나 시장 상황에 따라 언제든지 변경될 수 있습니다. 
                      현재 상황과 맞지 않다고 생각되시면 아래 버튼을 눌러 다시 분석해 보세요.
                    </p>

                    <button 
                      onClick={handleRetakeSurvey}
                      className="w-full py-4 border-2 border-[#22C55E] text-[#22C55E] font-bold rounded-xl hover:bg-[#22C55E]/5 transition flex justify-center items-center gap-2"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                      투자 성향 재설문하기
                    </button>
                  </div>
                </div>
              )}

              {/* --- 환경설정 탭 --- */}
              {activeTab === 'settings' && (
                <div className="animate-fade-in space-y-8">
                  <h3 className="font-black text-xl mb-6">환경설정</h3>
                  
                  <div className="space-y-4 max-w-lg">
                    {/* 알림 설정 */}
                    <div className="p-5 border border-gray-100 rounded-2xl flex justify-between items-center bg-gray-50/50">
                      <div>
                        <h4 className="font-bold text-gray-800">앱 알림 (Push)</h4>
                        <p className="text-xs text-gray-500 mt-1">주가 급등락, 자산 변동 알림을 받습니다.</p>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" className="sr-only peer" defaultChecked onChange={(e) => alert(`[API 연동 필요] 알림 설정 변경: ${e.target.checked}`)} />
                        <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#22C55E]"></div>
                      </label>
                    </div>

                    {/* 커뮤니티 설정 */}
                    <div className="p-5 border border-gray-100 rounded-2xl flex justify-between items-center bg-gray-50/50">
                      <div>
                        <h4 className="font-bold text-gray-800">커뮤니티 활동 공개</h4>
                        <p className="text-xs text-gray-500 mt-1">내가 작성한 글과 댓글을 다른 유저에게 공개합니다.</p>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" className="sr-only peer" onChange={(e) => alert(`[API 연동 필요] 커뮤니티 공개 설정 변경: ${e.target.checked}`)} />
                        <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#22C55E]"></div>
                      </label>
                    </div>

                    {/* 이용약관 링크 */}
                    <div className="pt-6">
                      <a href="/terms" target="_blank" rel="noreferrer" className="text-sm font-semibold text-gray-500 hover:text-gray-800 flex items-center gap-1 transition">
                        이용약관 및 개인정보처리방침 
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"></path></svg>
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