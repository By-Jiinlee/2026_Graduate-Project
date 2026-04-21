import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path' // 1. path 임포트 (에러나면 npm install -D @types/node)

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // 2. 모든 react 호출을 현재 프로젝트의 node_modules 안의 react로 고정
      react: path.resolve(__dirname, './node_modules/react'),
      'react-dom': path.resolve(__dirname, './node_modules/react-dom'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})