import { useState } from 'react'

export default function Support() {
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

  const categories = ['TOP', '상품 가입', '사업 연영성', '수익금']

  const faqs = [
    {
      category: 'TOP',
      question: 'UpTick 신규 가입 시 혜택이 있나요?',
      answer:
        '신규 가입 시 30일 무료 프리미엄 이용권과 수수료 면제 혜택을 드립니다.',
    },
    {
      category: '상품 가입',
      question: '환불 보장이 되나요?',
      answer: '가입 후 7일 이내 환불 신청 시 전액 환불 가능합니다.',
    },
    {
      category: '사업 연영성',
      question: '중도 상환 및 해지가 가능한가요?',
      answer: '중도 상환은 언제든지 가능하며, 해지 수수료는 없습니다.',
    },
    {
      category: '수익금',
      question: '기존 상품의 추가 금액 입력 산입이 가능한가요?',
      answer:
        '기존 상품에 추가 입금은 자유롭게 가능합니다. 마이페이지에서 설정하실 수 있습니다.',
    },
    {
      category: 'TOP',
      question: '비밀번호를 잊어버렸어요. 어떻게 찾나요?',
      answer:
        '로그인 화면에서 "비밀번호 찾기"를 클릭하시면 이메일로 재설정 링크를 보내드립니다.',
    },
    {
      category: '상품 가입',
      question: '미성년자도 가입할 수 있나요?',
      answer: '만 14세 이상부터 법정대리인 동의 하에 가입 가능합니다.',
    },
  ]

  const filtered = faqs.filter(
    (f) => f.question.includes(searchQuery) || f.answer.includes(searchQuery),
  )

  return (
    <div
      style={{
        fontFamily: 'sans-serif',
        minHeight: '100vh',
        backgroundColor: '#f9fafb',
      }}
    >
      {/* 상단 헤더 */}
      <div
        style={{
          backgroundColor: '#fff',
          padding: '48px 120px 32px',
          borderBottom: '1px solid #eee',
          textAlign: 'center',
        }}
      >
        <h1
          style={{ fontSize: '28px', fontWeight: 'bold', marginBottom: '24px' }}
        >
          자주 묻는 질문
        </h1>

        {/* 검색창 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            maxWidth: '480px',
            margin: '0 auto',
            border: '1px solid #ddd',
            borderRadius: '8px',
            backgroundColor: '#fff',
            padding: '10px 16px',
            gap: '8px',
          }}
        >
          <input
            type="text"
            placeholder="검색어를 입력하세요"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              flex: 1,
              border: 'none',
              outline: 'none',
              fontSize: '14px',
              color: '#333',
            }}
          />
          <span style={{ color: '#aaa', fontSize: '16px' }}>🔍</span>
        </div>
      </div>

      {/* 본문 */}
      <div style={{ display: 'flex', padding: '40px 120px', gap: '32px' }}>
        {/* 카테고리 사이드바 */}
        <div style={{ width: '160px', flexShrink: 0 }}>
          {categories.map((cat) => (
            <div
              key={cat}
              style={{
                padding: '12px 16px',
                borderRadius: '8px',
                fontSize: '14px',
                color: '#555',
                cursor: 'pointer',
                marginBottom: '4px',
                backgroundColor: '#fff',
                fontWeight: '500',
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.backgroundColor = '#f0faf4')
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.backgroundColor = '#fff')
              }
            >
              {cat}
            </div>
          ))}
        </div>

        {/* FAQ 아코디언 */}
        <div style={{ flex: 1 }}>
          {filtered.map((faq, i) => (
            <div
              key={i}
              style={{
                backgroundColor: '#fff',
                borderRadius: '10px',
                marginBottom: '10px',
                boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
                overflow: 'hidden',
              }}
            >
              {/* 질문 */}
              <div
                onClick={() => setOpenIndex(openIndex === i ? null : i)}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '18px 24px',
                  cursor: 'pointer',
                  fontSize: '14px',
                  fontWeight: '500',
                  color: '#222',
                }}
              >
                <span>Q. {faq.question}</span>
                <span
                  style={{
                    fontSize: '18px',
                    color: '#aaa',
                    transform: openIndex === i ? 'rotate(180deg)' : 'none',
                    transition: 'transform 0.2s',
                  }}
                >
                  ∨
                </span>
              </div>

              {/* 답변 */}
              {openIndex === i && (
                <div
                  style={{
                    padding: '16px 24px 20px',
                    backgroundColor: '#f9fafb',
                    borderTop: '1px solid #eee',
                    fontSize: '14px',
                    color: '#555',
                    lineHeight: '1.7',
                  }}
                >
                  A. {faq.answer}
                </div>
              )}
            </div>
          ))}

          {filtered.length === 0 && (
            <div
              style={{
                textAlign: 'center',
                color: '#aaa',
                padding: '48px',
                fontSize: '14px',
              }}
            >
              검색 결과가 없습니다.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
