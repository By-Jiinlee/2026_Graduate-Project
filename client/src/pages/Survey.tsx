import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { questions, investmentTypes } from '../data/surveyData';

export default function Survey() {
  const [step, setStep] = useState(0);
  const [totalScore, setTotalScore] = useState(0);
  const navigate = useNavigate();

  // 💡 모달창 표시 여부와 결과를 담을 상태(State) 추가
  const [showModal, setShowModal] = useState(false);
  const [finalResult, setFinalResult] = useState<{ id: number; name: string } | null>(null);

  const handleAnswer = (score: number) => {
    const nextScore = totalScore + score;

    if (step < questions.length - 1) {
      setTotalScore(nextScore);
      setStep(step + 1);
    } else {
      finishSurvey(nextScore);
    }
  };

  const finishSurvey = (finalScore: number) => {
    // 점수 범위에 맞는 유형 찾기
    const resultType = investmentTypes.find(
      (type) => finalScore >= type.minScore && finalScore <= type.maxScore
    ) || investmentTypes[0]; 

    // LocalStorage 업데이트
    const userStr = localStorage.getItem('upTick_user');
    const user = userStr ? JSON.parse(userStr) : {};
    
    localStorage.setItem('upTick_user', JSON.stringify({
      ...user,
      is_survey_completed: true,
      investment_type_id: resultType.id,
      investment_type_name: resultType.name
    }));

    // 💡 alert() 대신 우리가 만든 예쁜 상태값을 채우고 모달을 켭니다!
    setFinalResult(resultType);
    setShowModal(true);
  };

  // 모달창의 "확인" 버튼을 눌렀을 때 실행될 함수
  const handleCloseModal = () => {
    setShowModal(false);
    navigate('/mypage'); 
  };

  // 진행률 계산 (0% ~ 100%)
  const progressPercent = ((step) / questions.length) * 100;

  return (
    <div style={{ 
      minHeight: '100vh', 
      backgroundColor: '#f9fafb', 
      display: 'flex', 
      alignItems: 'center', 
      justifyContent: 'center',
      padding: '20px',
      fontFamily: 'sans-serif'
    }}>
      <div style={{
        backgroundColor: '#fff',
        width: '100%',
        maxWidth: '560px',
        borderRadius: '24px',
        padding: '48px',
        boxShadow: '0 10px 40px rgba(0,0,0,0.05)',
      }}>
        
        {/* 프로그레스 바 영역 */}
        <div style={{ marginBottom: '40px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px', fontSize: '14px', color: '#888', fontWeight: 'bold' }}>
            <span>투자 성향 분석</span>
            <span style={{ color: '#3CB371' }}>{step + 1} / {questions.length}</span>
          </div>
          <div style={{ width: '100%', height: '8px', backgroundColor: '#f0f0f0', borderRadius: '4px', overflow: 'hidden' }}>
            <div style={{ 
              width: `${progressPercent}%`, 
              height: '100%', 
              backgroundColor: '#3CB371', 
              transition: 'width 0.4s ease-in-out' 
            }} />
          </div>
        </div>

        {/* 질문 영역 */}
        <h2 style={{ 
          fontSize: '24px', 
          fontWeight: 'bold', 
          color: '#1a1a1a', 
          lineHeight: '1.5',
          marginBottom: '32px',
          wordBreak: 'keep-all'
        }}>
          {questions[step].question}
        </h2>

        {/* 선택지 버튼 영역 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {questions[step].options.map((opt, i) => (
            <button 
              key={i} 
              onClick={() => handleAnswer(opt.score)}
              style={{
                padding: '20px',
                borderRadius: '16px',
                border: '2px solid #f0f0f0',
                backgroundColor: '#fff',
                fontSize: '16px',
                color: '#333',
                textAlign: 'left',
                cursor: 'pointer',
                fontWeight: '500',
                transition: 'all 0.2s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = '#3CB371';
                e.currentTarget.style.backgroundColor = '#f0faf4';
                e.currentTarget.style.transform = 'translateY(-2px)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = '#f0f0f0';
                e.currentTarget.style.backgroundColor = '#fff';
                e.currentTarget.style.transform = 'translateY(0)';
              }}
            >
              {opt.text}
            </button>
          ))}
        </div>
      </div>

      {/* 💡 예쁜 커스텀 결과 팝업창 (Modal) */}
      {showModal && finalResult && (
        <div style={{
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)', // 반투명 검은 배경
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: '20px'
        }}>
          <div style={{
            backgroundColor: '#fff',
            borderRadius: '24px',
            padding: '40px',
            width: '100%',
            maxWidth: '400px',
            textAlign: 'center',
            boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
            animation: 'fadeInUp 0.3s ease-out forwards'
          }}>
            <div style={{ fontSize: '48px', marginBottom: '16px' }}>🎉</div>
            <h3 style={{ fontSize: '20px', color: '#888', marginBottom: '8px', fontWeight: 'normal' }}>
              분석 완료! 회원님은
            </h3>
            <div style={{ fontSize: '28px', fontWeight: 'bold', color: '#3CB371', marginBottom: '32px' }}>
              [{finalResult.name}]
            </div>
            
            <button 
              onClick={handleCloseModal}
              style={{
                width: '100%',
                padding: '16px',
                backgroundColor: '#3CB371',
                color: '#fff',
                border: 'none',
                borderRadius: '12px',
                fontSize: '16px',
                fontWeight: 'bold',
                cursor: 'pointer',
                transition: 'background-color 0.2s'
              }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#2E8B57'}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#3CB371'}
            >
              결과 확인하러 가기
            </button>
          </div>
        </div>
      )}

    </div>
  );
}