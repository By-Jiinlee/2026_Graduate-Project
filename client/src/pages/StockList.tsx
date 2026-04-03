import React, { useEffect, useState, useMemo } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';

interface StockData {
  id: number;
  name: string;
  code: string;
  price: string | number;
  change: string | number;
  changeRate: string | number;
  volume: string | number;
  market?: string; // 코스피, 코스닥 구분을 위해 필요 (DB 쿼리에서 가져와야 함)
}

const StockList: React.FC = () => {
  const navigate = useNavigate();
  const [stocks, setStocks] = useState<StockData[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  
  // --- 1. 상태 추가 영역 ---
  const [selectedMarket, setSelectedMarket] = useState('전체'); // 필터 상태 (전체/코스피/코스닥)
  const [favorites, setFavorites] = useState<number[]>([]); // 즐겨찾기 아이디 배열

  const fetchStocks = async () => {
    try {
      const response = await axios.get('http://localhost:3000/api/market/stock-prices/all');
      if (response.data.success) {
        setStocks(response.data.data);
      }
    } catch (error) {
      console.error("데이터 로드 실패:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStocks();
    // 로컬 스토리지에서 기존 즐겨찾기 불러오기 (임시 저장용)
    const savedFavs = localStorage.getItem('uptick_favs');
    if (savedFavs) setFavorites(JSON.parse(savedFavs));
  }, []);

  // --- 2. 즐겨찾기 토글 함수 ---
  const toggleFavorite = (e: React.MouseEvent, id: number) => {
    e.stopPropagation(); // 행 클릭 이벤트(상세페이지 이동) 방지
    const newFavs = favorites.includes(id) 
      ? favorites.filter(favId => favId !== id) 
      : [...favorites, id];
    setFavorites(newFavs);
    localStorage.setItem('uptick_favs', JSON.stringify(newFavs));
  };

  // --- 3. 필터링 및 검색 로직 (market 필터 추가) ---
  const filteredStocks = useMemo(() => {
    return stocks.filter(stock => {
      const matchSearch = stock.name.toLowerCase().includes(searchTerm.toLowerCase()) || stock.code.includes(searchTerm);
      
      // 시장 필터 (현재 API 응답에 market 정보가 포함되어야 정확히 작동합니다)
      const matchMarket = selectedMarket === '전체' || stock.market === selectedMarket;
      
      return matchSearch && matchMarket;
    });
  }, [stocks, searchTerm, selectedMarket]);

  // 즐겨찾는 종목만 따로 추출 (우측 사이드바용)
  const favoriteStocks = useMemo(() => {
    return stocks.filter(stock => favorites.includes(stock.id));
  }, [stocks, favorites]);

  const formatNum = (val: string | number) => Number(val).toLocaleString();

  if (loading) return <div className="flex justify-center items-center h-screen">로딩 중...</div>;

  return (
    <div className="flex gap-8 p-8 bg-gray-50 min-h-screen font-sans text-gray-900">
      
      {/* 왼쪽 사이드바: 시장 필터 기능 추가 */}
      <aside className="w-48 shrink-0">
        <h3 className="text-xl font-bold mb-6 text-gray-800">관심종목</h3>
        <div className="flex p-1 mb-6 bg-gray-200 rounded-xl">
          <button className="flex-1 py-1.5 text-sm font-bold rounded-lg bg-[#2ecc71] text-white">국내</button>
          <button className="flex-1 py-1.5 text-sm font-bold text-gray-500">해외</button>
        </div>
        <ul className="space-y-4 font-semibold text-gray-400">
          {['전체', '코스피', '코스닥', 'ETF'].map((menu) => (
            <li 
              key={menu}
              onClick={() => setSelectedMarket(menu)}
              className={`pl-3 cursor-pointer transition-all ${selectedMarket === menu ? 'text-gray-900 border-l-4 border-[#2ecc71]' : 'hover:text-gray-600'}`}
            >
              {menu}
            </li>
          ))}
        </ul>
      </aside>

      <main className="flex-1 bg-white p-8 rounded-[32px] shadow-sm border border-gray-100">
        <div className="flex justify-between items-center mb-8">
          <h2 className="text-2xl font-black">국내종목리스트</h2>
          <div className="flex items-center px-5 py-2.5 bg-gray-100 rounded-full">
            <input 
              type="text" 
              placeholder="종목명 / 코드 검색" 
              className="bg-transparent outline-none w-56 text-sm"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            <span className="text-blue-500">🔍</span>
          </div>
        </div>

        <table className="w-full border-collapse">
          <thead>
            <tr className="text-gray-400 text-sm border-b border-gray-100 italic">
              <th className="pb-4 font-semibold text-left">종목명</th>
              <th className="pb-4 font-semibold text-left">종목코드</th>
              <th className="pb-4 font-semibold text-right">현재가</th>
              <th className="pb-4 font-semibold text-right">전일대비</th>
              <th className="pb-4 font-semibold text-right">등락률</th>
              <th className="pb-4 font-semibold text-right">거래량</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {filteredStocks.map((stock) => (
              <tr 
                key={stock.id} 
                onClick={() => navigate(`/stock/${stock.id}`)}
                className="hover:bg-gray-50 transition-colors cursor-pointer"
              >
                <td className="py-5 font-bold flex items-center gap-2">
                  {/* 즐겨찾기 별표 추가 */}
                  <span 
                    onClick={(e) => toggleFavorite(e, stock.id)}
                    className={`text-xl ${favorites.includes(stock.id) ? 'text-yellow-400' : 'text-gray-200'} hover:scale-125 transition-transform`}
                  >
                    ★
                  </span>
                  {stock.name}
                </td>
                <td className="py-5 text-gray-300 text-xs">{stock.code}</td>
                <td className="py-5 text-right font-black">₩{formatNum(stock.price)}</td>
                <td className={`py-5 text-right font-bold ${Number(stock.change) > 0 ? 'text-red-500' : 'text-blue-500'}`}>
                  {Number(stock.change) > 0 ? '▲' : '▼'} {formatNum(Math.abs(Number(stock.change)))}
                </td>
                <td className={`py-5 text-right font-bold ${Number(stock.change) > 0 ? 'text-red-500' : 'text-blue-500'}`}>
                  {Number(stock.change) > 0 ? '+' : ''}{Number(stock.changeRate).toFixed(2)}%
                </td>
                <td className="py-5 text-right text-gray-400 font-medium">{formatNum(stock.volume)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </main>

      {/* 오른쪽 사이드바: 즐겨찾기 실시간 반영 */}
      <aside className="w-64 shrink-0">
        <div className="p-7 bg-white rounded-3xl border border-gray-100 shadow-sm sticky top-8">
          <h3 className="text-sm font-extrabold mb-6 text-gray-800 uppercase tracking-widest">즐겨찾는 나의 종목</h3>
          <div className="space-y-5">
            {favoriteStocks.length > 0 ? favoriteStocks.map(s => (
              <div key={s.id} onClick={() => navigate(`/stock/${s.id}`)} className="flex justify-between items-center text-sm cursor-pointer hover:bg-gray-50 p-1 rounded-lg">
                <span className="font-bold text-gray-700">{s.name}</span>
                <span className={`font-bold ${Number(s.changeRate) > 0 ? 'text-red-500' : 'text-blue-500'}`}>
                  {Number(s.changeRate) > 0 ? '+' : ''}{Number(s.changeRate).toFixed(2)}%
                </span>
              </div>
            )) : (
              <p className="text-xs text-gray-400 py-4 text-center">별표를 눌러 종목을 추가하세요!</p>
            )}
          </div>
          <button className="w-full mt-8 py-3.5 bg-[#2ecc71] text-white font-black rounded-2xl hover:bg-[#27ae60] shadow-md shadow-green-100 transition-all">
             종목 관리
          </button>
        </div>
      </aside>
    </div>
  );
};

export default StockList;