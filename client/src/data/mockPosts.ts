// src/data/mockPosts.ts
// src/data/mockPosts.ts

export interface Comment {
  id: number;
  author: string;
  content: string;
  date: string;
}

export interface Post {
  id: number;
  title: string;
  author: string;
  date: string;
  views: number;
  likes: number;
  category: string;
  content: string;
  comments: Comment[]; // 댓글 배열 추가
}

export const initialPosts: Post[] = [
  { 
    id: 1, 
    title: '삼성전자 지금 매수 타이밍인가요?', 
    author: '투자왕', 
    date: '2024.03.01', 
    views: 342, 
    likes: 28, 
    category: '질문', 
    content: '최근 주가가 많이 떨어졌는데 지금이 저점일까요?...',
    comments: [
      { id: 101, author: '개미심리', content: '아직 바닥 안 나온 것 같아요.', date: '2024.03.01' }
    ]
  },
  // ... 나머지 데이터들도 comments: [] 를 추가해 주세요.
];

//data/moskPosts.ts 파일은 게시글 데이터를 정의하는 TypeScript 인터페이스와 초기 게시글 목록을 포함하고 있습니다. Post 인터페이스는 게시글의 구조를 정의하며, initialPosts 배열은 실제로 사용할 수 있는 예시 게시글 데이터를 제공합니다. 각 게시글에는 id, title, author, date, views, likes, category, content 등의 속성이 포함되어 있습니다.
//백엔드연결전 Dashboard 페이지 기능 테스트 위한 더미 데이터입니다. 실제 프로젝트에서는 API를 통해 데이터를 받아와서 사용하게 됩니다.