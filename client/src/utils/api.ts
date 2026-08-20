// ─────────────────────────────────────────────────────────────
// API 기준 주소 해석
//
// 기존에는 각 파일이 서버 주소를 직접 박고 있어서, 발표·시연 중 노트북 LAN IP나
// 휴대폰으로 접속하면 localhost 가 접속한 기기 자신을 가리켜 전부 실패했다.
// 기본값을 "현재 접속한 호스트 + 서버 포트"로 유도해 접속 경로와 무관하게 동작시킨다.
//
//   VITE_API_BASE  전체 주소를 고정 (예: https://api.example.com) — 배포 시 사용
//   VITE_API_PORT  호스트만 유도하고 포트를 바꿀 때 (기본 3000)
// ─────────────────────────────────────────────────────────────

const DEFAULT_SERVER_PORT = '3000'

function readEnv(key: string): string {
  const raw = (import.meta.env as Record<string, string | undefined>)[key]
  return typeof raw === 'string' ? raw.trim() : ''
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function resolveApiBase(): string {
  const configured = readEnv('VITE_API_BASE')
  if (configured) return stripTrailingSlash(configured)

  // SSR·테스트 등 window 가 없는 환경에서도 모듈 로드가 깨지지 않게 방어한다.
  if (typeof window === 'undefined') return `http://localhost:${DEFAULT_SERVER_PORT}`

  const { protocol, hostname } = window.location
  const port = readEnv('VITE_API_PORT') || DEFAULT_SERVER_PORT
  return `${protocol}//${hostname}:${port}`
}

export const API_BASE = resolveApiBase()

// socket.io 는 경로가 아닌 오리진만 필요해 별칭으로 둔다.
export const SOCKET_URL = API_BASE

export function apiUrl(path: string): string {
  return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`
}
