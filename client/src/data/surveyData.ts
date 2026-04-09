// src/data/surveyData.ts

export interface Question {
  id: number;
  question: string;
  options: { text: string; score: number }[];
}

export const questions: Question[] = [
  {
    id: 1,
    question: "Q1. 선호하는 투자 기간은?",
    options: [
      { text: "1주 이내 (초단기)", score: 10 },
      { text: "1달 이내 (단기)", score: 5 },
      { text: "6달 이상 (장기)", score: 0 }
    ]
  },
  {
    id: 2,
    question: "Q2. 손실 감내 수준은?",
    options: [
      { text: "5% 이내 (안정)", score: 0 },
      { text: "20% 이내 (중립)", score: 5 },
      { text: "그 이상도 감수 (공격)", score: 10 }
    ]
  },
  {
    id: 3,
    question: "Q3. 종목 선정 시 가장 중요하게 보는 것은?",
    options: [
      { text: "차트 / 수급", score: 10 },
      { text: "뉴스 / 이슈", score: 5 },
      { text: "재무 / 실적", score: 0 }
    ]
  },
  {
    id: 4,
    question: "Q4. 선호하는 종목 규모는?",
    options: [
      { text: "대형주 (안정)", score: 0 },
      { text: "상관없음 (유연)", score: 5 },
      { text: "소형주도 OK (공격)", score: 10 }
    ]
  },
  {
    id: 5,
    question: "Q5. 본인의 투자 경험은?",
    options: [
      { text: "1년 미만 (입문)", score: 0 },
      { text: "1~3년 (경험자)", score: 5 },
      { text: "3년 이상 (숙련자)", score: 10 }
    ]
  }
];

export const investmentTypes = [
  { id: 1, name: "안전지향 예금주형", minScore: 0, maxScore: 5 },
  { id: 2, name: "보수적 은퇴 설계자", minScore: 6, maxScore: 10 },
  { id: 3, name: "배당 수익 추구형", minScore: 11, maxScore: 15 },
  { id: 4, name: "가치 투자 탐험가", minScore: 16, maxScore: 20 },
  { id: 5, name: "글로벌 자산 배분가", minScore: 21, maxScore: 25 },
  { id: 6, name: "ESG 윤리 투자자", minScore: 26, maxScore: 30 },
  { id: 7, name: "성장주 콜렉터", minScore: 31, maxScore: 35 },
  { id: 8, name: "블록체인 얼리어답터", minScore: 36, maxScore: 40 },
  { id: 9, name: "시장 중립 전략가", minScore: 41, maxScore: 45 },
  { id: 10, name: "공격적 단타 고수", minScore: 46, maxScore: 50 }
];