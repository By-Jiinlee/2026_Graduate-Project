import { useState } from 'react'

export default function Auth() {
  const [view, setView] = useState('initial')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center items-center py-12 px-6">
      <div className="bg-white p-10 rounded-2xl shadow-sm border border-gray-100 w-full max-w-md flex flex-col items-center min-h-[400px] justify-center">
        <h2 className="text-4xl font-black mb-10 text-black tracking-tight">
          uptick
        </h2>
        {view === 'initial' && (
          <div className="w-full flex flex-col items-center">
            <button
              type="button"
              onClick={() => setView('signup')}
              className="w-full bg-[#4CAF4F] text-white py-4 rounded-md font-bold text-lg hover:opacity-80 transition mb-6"
            >
              회원가입 하기
            </button>
            <button
              type="button"
              onClick={() => setView('login')}
              className="text-gray-400 text-sm hover:text-gray-600 underline underline-offset-4 transition"
            >
              이미 계정이 있다면 로그인하러 가기
            </button>
          </div>
        )}
        {view === 'signup' && (
          <div className="w-full">
            <h3 className="text-xl font-bold mb-6 text-center text-gray-800">
              회원가입
            </h3>
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <input
                type="text"
                placeholder="이름"
                className="border border-gray-300 p-3 rounded-md focus:outline-none focus:border-[#4CAF4F] focus:ring-1 focus:ring-[#4CAF4F]"
              />
              <input
                type="email"
                placeholder="이메일"
                className="border border-gray-300 p-3 rounded-md focus:outline-none focus:border-[#4CAF4F] focus:ring-1 focus:ring-[#4CAF4F]"
              />
              <input
                type="password"
                placeholder="비밀번호"
                className="border border-gray-300 p-3 rounded-md focus:outline-none focus:border-[#4CAF4F] focus:ring-1 focus:ring-[#4CAF4F]"
              />
              <input
                type="password"
                placeholder="비밀번호 확인"
                className="border border-gray-300 p-3 rounded-md focus:outline-none focus:border-[#4CAF4F] focus:ring-1 focus:ring-[#4CAF4F]"
              />
              <button
                type="submit"
                className="w-full bg-[#4CAF4F] text-white py-3 rounded-md font-bold text-lg hover:opacity-80 transition mt-4"
              >
                가입 완료
              </button>
            </form>
            <div className="mt-6 text-center">
              <button
                type="button"
                onClick={() => setView('login')}
                className="text-gray-400 text-sm hover:text-gray-600 underline"
              >
                이미 계정이 있으신가요? 로그인
              </button>
            </div>
          </div>
        )}
        {view === 'login' && (
          <div className="w-full">
            <h3 className="text-xl font-bold mb-6 text-center text-gray-800">
              로그인
            </h3>
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <input
                type="email"
                placeholder="이메일"
                className="border border-gray-300 p-3 rounded-md focus:outline-none focus:border-[#4CAF4F] focus:ring-1 focus:ring-[#4CAF4F]"
              />
              <input
                type="password"
                placeholder="비밀번호"
                className="border border-gray-300 p-3 rounded-md focus:outline-none focus:border-[#4CAF4F] focus:ring-1 focus:ring-[#4CAF4F]"
              />
              <button
                type="submit"
                className="w-full bg-[#4CAF4F] text-white py-3 rounded-md font-bold text-lg hover:opacity-80 transition mt-4"
              >
                로그인
              </button>
            </form>
            <div className="mt-6 text-center">
              <button
                type="button"
                onClick={() => setView('initial')}
                className="text-gray-400 text-sm hover:text-gray-600 underline"
              >
                계정이 없으신가요? 회원가입
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
