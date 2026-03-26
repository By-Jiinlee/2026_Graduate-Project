import { Link } from 'react-router-dom';

export default function Navbar() {
  return (
    <nav className="bg-white p-4 shadow-md sticky top-0 z-50">
      <div className="container mx-auto flex justify-between items-center">

        {/* 로고 영역: 텍스트 먼저, 로고 나중 + 로고 크기/위치 조정 */}
        <div className="flex items-center space-x-2">
          <Link to="/" className="text-xl font-black text-black tracking-tight">
            UpTick
          </Link>
          <img 
            src="/logo.png" 
            alt="UpTick 로고" 
            className="h-10 w-auto relative -top-0.5" 
          />
        </div>

        {/* 네비게이션 메뉴 및 시작하기 버튼 */}
        <div className="flex items-center space-x-20">
          <div className="flex space-x-16 text-black font-medium">
            <Link to="/stock" className="hover:text-[#4CAF4F] transition">종목</Link>
            <Link to="/manage" className="hover:text-[#4CAF4F] transition">주식 관리</Link>
            <Link to="/community" className="hover:text-[#4CAF4F] transition">커뮤니티</Link>
            <Link to="/events" className="hover:text-[#4CAF4F] transition">이벤트</Link>
            <Link to="/support" className="hover:text-[#4CAF4F] transition">고객센터</Link>
            <Link to="/about" className="hover:text-[#4CAF4F] transition">소개</Link>
            <Link to="/mypage" className="hover:text-[#4CAF4F] transition">마이페이지</Link>
          </div>

          <Link to="/auth" className="bg-[#4CAF4F] text-white px-8 py-3 rounded-md font-bold hover:opacity-80 transition text-sm inline-block text-center">
            시작하기 →
          </Link>
        </div>

      </div>
    </nav>
  );
}