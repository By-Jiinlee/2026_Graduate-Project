import React, { useEffect, useRef, useState } from 'react';

// --- 스크롤 감지 애니메이션 컴포넌트 ---
const ScrollReveal = ({ children, isEven }: { children: React.ReactNode, isEven: boolean }) => {
  const [isVisible, setVisible] = useState(false);
  const domRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        // 화면에 30% 이상 등장하면 애니메이션 실행
        if (entry.isIntersecting) {
          setVisible(true);
        }
      });
    }, { threshold: 0.3 }); 

    if (domRef.current) observer.observe(domRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={domRef}
      className={`transition-all duration-[1200ms] ease-out transform ${
        isVisible ? 'opacity-100 translate-y-0 translate-x-0' : `opacity-0 translate-y-24 ${isEven ? '-translate-x-16' : 'translate-x-16'}`
      }`}
    >
      {children}
    </div>
  );
};

export default function About() {
  // 상단 스크롤 진행도 바 상태
  const [scrollProgress, setScrollProgress] = useState(0);

  useEffect(() => {
    const handleScroll = () => {
      const totalScroll = document.documentElement.scrollTop;
      const windowHeight = document.documentElement.scrollHeight - document.documentElement.clientHeight;
      const scroll = `${totalScroll / windowHeight}`;
      setScrollProgress(Number(scroll));
    }
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // 멤버 데이터
  const members = [
    { name: '이지인', role: 'PM', subRole: '프론트엔드', color: 'from-emerald-400 to-[#22C55E]', icon: '👩‍💻' },
    { name: '김시우', role: 'QA', subRole: '프론트엔드', color: 'from-blue-400 to-indigo-500', icon: '👨‍💻' },
    { name: '윤다혜', role: 'DB 관리자', subRole: '백엔드', color: 'from-purple-400 to-fuchsia-500', icon: '👩‍💻' },
    { name: '이경준', role: '웹 보안', subRole: '백엔드', color: 'from-orange-400 to-rose-500', icon: '👨‍💻' },
    { name: '이시훈', role: '웹 보안', subRole: '백엔드', color: 'from-pink-400 to-rose-500', icon: '👨‍💻' },
  ];

  return (
    <div className="w-full min-h-screen bg-gray-50 font-sans pb-32">
      {/* 상단 스크롤 진행바 */}
      <div 
        className="fixed top-0 left-0 h-1.5 bg-[#22C55E] z-50 transition-all duration-150" 
        style={{ width: `${scrollProgress * 100}%` }} 
      />

      {/* 1. 상단 인트로 섹션 (화면을 가득 채우게 설정) */}
      <section className="flex flex-col items-center justify-center min-h-[70vh] px-6 text-center">
        <h1 className="text-5xl md:text-6xl font-black mb-8 tracking-tight">
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#22C55E] to-emerald-400 animate-pulse">
            UpTick
          </span>
          을 소개합니다
        </h1>
        <p className="text-xl text-gray-500 leading-relaxed max-w-2xl font-medium">
          리스크 없이 시장을 경험하고, 자신만의 투자 전략을 수립하세요.<br/>
          초보자부터 전문 투자자까지, 모두의 실용적인 해결책이 되는 곳.<br/>
          아래로 스크롤하여 UpTick을 만드는 사람들을 만나보세요. 👇
        </p>
      </section>

      {/* 2. 팀원 소개 섹션 (한 명씩 큼직하게 등장) */}
      <section className="flex flex-col gap-40 max-w-5xl mx-auto px-6 py-20">
        {members.map((member, index) => {
          const isEven = index % 2 === 0;
          
          return (
            <ScrollReveal key={member.name} isEven={isEven}>
              <div className={`flex flex-col md:flex-row items-center gap-16 ${isEven ? '' : 'md:flex-row-reverse'}`}>
                
                {/* 프로필 이미지 영역 (그라데이션 후광 효과) */}
                <div className="relative w-64 h-64 shrink-0">
                  <div className={`absolute inset-0 bg-gradient-to-br ${member.color} rounded-full blur-3xl opacity-30`}></div>
                  <div className="relative w-full h-full bg-white rounded-full shadow-2xl border-4 border-white flex items-center justify-center text-8xl transition-transform hover:scale-105 duration-300 cursor-pointer">
                    {member.icon}
                  </div>
                </div>

                {/* 텍스트 및 정보 영역 */}
                <div className={`flex-1 text-center ${isEven ? 'md:text-left' : 'md:text-right'}`}>
                  <h3 className="text-4xl font-black text-gray-900 mb-6">{member.name}</h3>
                  
                  <div className={`flex flex-wrap gap-3 justify-center ${isEven ? 'md:justify-start' : 'md:justify-end'} mb-6`}>
                    <span className="px-6 py-2.5 bg-[#22C55E]/10 text-[#22C55E] font-bold rounded-xl text-lg">
                      {member.role}
                    </span>
                    <span className="px-6 py-2.5 bg-gray-200 text-gray-700 font-bold rounded-xl text-lg">
                      {member.subRole}
                    </span>
                  </div>
                  
                  <p className="text-gray-500 text-lg leading-relaxed">
                    UpTick의 핵심 기능인 <strong>{member.subRole}</strong> 영역을 담당하며, <br className="hidden md:block"/>
                    사용자에게 최고의 경험을 제공하기 위해 치열하게 고민하고 기여합니다.
                  </p>
                </div>

              </div>
            </ScrollReveal>
          );
        })}
      </section>
    </div>
  );
}