/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'uptick-green': '#2ecc71', // 프로젝트 전용 색상 추가
      }
    },
  },
  plugins: [],
}