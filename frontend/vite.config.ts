import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const backendUrl = process.env.AUTOINO_BACKEND_URL ?? 'http://127.0.0.1:8000'

// https://vite.dev/config/
export default defineConfig({
  // 상대 경로로 빌드해 Streamlit 처럼 하위 경로(/autoino/)에 얹어도 그대로 열리게 한다
  base: './',
  plugins: [react()],
  resolve: {
    // 부품·보드 JSON 데이터베이스(저장소 루트 data/)
    alias: { '@data': fileURLToPath(new URL('../data', import.meta.url)) },
  },
  server: {
    fs: { allow: [repoRoot] },
    // 파이썬 백엔드(backend/, python -m autoino serve)로 API 요청을 넘긴다
    proxy: { '/api': backendUrl },
  },
  preview: {
    proxy: { '/api': backendUrl },
  },
})
