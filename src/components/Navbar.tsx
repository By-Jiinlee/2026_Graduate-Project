import { Link } from 'react-router-dom';

export default function Navbar() {
  return (
    <nav className="bg-white p-4 shadow-md sticky top-0 z-50">
      <div className="container mx-auto flex justify-between items-center">

        {/* 로고 영역 */}
        <div className="flex items-center space-x-2">
          <img src="/logo.png" alt="로고" className="h-8 w-auto" />
          <Link to="/" className="text-xl font-black text-black tracking-tight">
            UpTick
          </Link>
        </div>

        <div className="flex items-center space-x-8">
          <div className="flex space-x-8 text-black font-medium text-sm">
            <Link to="/stock" className="hover:text-[#4CAF4F] transition whitespace-nowrap">종목</Link>
            <Link to="/manage" className="hover:text-[#4CAF4F] transition whitespace-nowrap">주식 관리</Link>
            <Link to="/community" className="hover:text-[#4CAF4F] transition whitespace-nowrap">커뮤니티</Link>
            <Link to="/events" className="hover:text-[#4CAF4F] transition whitespace-nowrap">이벤트</Link>
            <Link to="/support" className="hover:text-[#4CAF4F] transition whitespace-nowrap">고객센터</Link>
            <Link to="/about" className="hover:text-[#4CAF4F] transition whitespace-nowrap">소개</Link>
            <Link to="/mypage" className="hover:text-[#4CAF4F] transition whitespace-nowrap">마이페이지</Link>
          </div>

          <Link to="/auth" className="bg-[#4CAF4F] text-white px-6 py-2 rounded-md font-bold hover:opacity-80 transition text-sm inline-block text-center whitespace-nowrap">
            시작하기 →
          </Link>
        </div>
      </div>
    </nav>
  );
}