import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom'; // 페이지 이동을 위해 추가

export default function Auth() {
  // 로그인에 필요한 상태만 남겼습니다.
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(''); // 새로운 요청 시 에러 초기화

    try {
      const response = await fetch('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      if (response.ok) {
        const data = await response.json();
        alert('UpTick에 오신 것을 환영합니다!');

        // 성공 시 메인 페이지('/')로 이동합니다.
        // localStorage.setItem('token', data.token); // 나중에 토큰 저장할 때 주석 해제
        navigate('/'); 
      } else {
        const data = await response.json();
        setErrorMessage(data.message || '이메일 또는 비밀번호가 올바르지 않습니다.');
      }
    } catch (error) {
      setErrorMessage('서버와 연결할 수 없습니다. 백엔드 서버가 켜져 있는지 확인해주세요.');
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center items-center py-12 px-6">
      <div className="bg-white p-10 rounded-2xl shadow-sm border border-gray-100 w-full max-w-md flex flex-col items-center min-h-[400px] justify-center">
        <h2 className="text-4xl font-black mb-10 text-black tracking-tight">
          uptick
        </h2>

        {/* 에러 발생 시 경고창 띄우기 */}
        {errorMessage && (
          <div className="w-full mb-6 p-3 bg-red-50 text-red-500 text-sm rounded-md text-center border border-red-100">
            {errorMessage}
          </div>
        )}

        <div className="w-full">
          <h3 className="text-xl font-bold mb-6 text-center text-gray-800">로그인</h3>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <input
              type="email" placeholder="이메일" required
              value={email} onChange={(e) => setEmail(e.target.value)}
              className="border border-gray-300 p-3 rounded-md focus:outline-none focus:border-[#22C55E] focus:ring-1 focus:ring-[#22C55E]" 
            />
            <input
              type="password" placeholder="비밀번호" required
              value={password} onChange={(e) => setPassword(e.target.value)}
              className="border border-gray-300 p-3 rounded-md focus:outline-none focus:border-[#22C55E] focus:ring-1 focus:ring-[#22C55E]" 
            />
            <button type="submit" className="w-full bg-[#22C55E] text-white py-3 rounded-md font-bold text-lg hover:opacity-80 transition mt-4">
              로그인
            </button>
          </form>
          
          {/* 회원가입 페이지(/register)로 넘어가는 링크 */}
          <div className="mt-6 text-center">
            <Link to="/register" className="text-gray-400 text-sm hover:text-gray-600 underline">
              계정이 없으신가요? 회원가입
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}