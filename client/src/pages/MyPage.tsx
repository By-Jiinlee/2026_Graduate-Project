import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

export default function MyPage() {
  const navigate = useNavigate()

  useEffect(() => {
    // if (!isLoggedIn) { navigate('/auth'); }
  }, [navigate])

  return (
    <div className="w-full min-h-screen bg-white pb-20 font-sans text-gray-800">
      <div className="container mx-auto px-6 max-w-5xl">
        <section className="py-12 border-b border-gray-200">
          <h2 className="text-2xl font-black mb-10">자산 관리</h2>
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
        </section>

        <section className="py-12 border-b border-gray-200">
          <h2 className="text-2xl font-black mb-10">계좌 관리</h2>
          <div className="min-h-[200px] bg-slate-50 rounded-xl border border-dashed border-gray-200 flex items-center justify-center text-gray-300 text-sm">
            연결된 계좌 정보가 여기에 표시됩니다.
          </div>
        </section>

        <section className="py-12">
          <h2 className="text-2xl font-black mb-10">계정 관리</h2>
          <div className="flex items-start gap-16">
            <div className="w-32 h-32 bg-slate-100 rounded-full flex-shrink-0 flex items-center justify-center">
              <svg
                className="w-16 h-16 text-gray-300"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path
                  fillRule="evenodd"
                  d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
            <div className="flex-1 grid grid-cols-3 gap-12">
              <div className="flex flex-col gap-4">
                <h3 className="font-black text-lg border-b border-gray-100 pb-2">
                  프로필&개인정보
                </h3>
                <ul className="flex flex-col gap-3 text-sm text-gray-400">
                  <li className="hover:text-[#22C55E] cursor-pointer transition">
                    프로필 변경
                  </li>
                  <li className="hover:text-[#22C55E] cursor-pointer transition">
                    개인정보 변경
                  </li>
                </ul>
              </div>
              <div className="flex flex-col gap-4">
                <h3 className="font-black text-lg border-b border-gray-100 pb-2">
                  보안 및 인증
                </h3>
                <ul className="flex flex-col gap-3 text-sm text-gray-400">
                  <li className="hover:text-[#22C55E] cursor-pointer transition">
                    비밀번호 및 보안
                  </li>
                  <li className="hover:text-[#22C55E] cursor-pointer transition">
                    로그인 기록
                  </li>
                </ul>
              </div>
              <div className="flex flex-col gap-4">
                <h3 className="font-black text-lg border-b border-gray-100 pb-2">
                  알림&환경설정
                </h3>
                <ul className="flex flex-col gap-3 text-sm text-gray-400">
                  <li className="hover:text-[#22C55E] cursor-pointer transition">
                    알림
                  </li>
                  <li className="hover:text-[#22C55E] cursor-pointer transition">
                    커뮤니티
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
