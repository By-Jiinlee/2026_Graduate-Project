import type { CorsOptions } from 'cors'

// ─────────────────────────────────────────────────────────────
// CORS 허용 출처 정책
//
// credentials:true 인 요청은 와일드카드(*)를 쓸 수 없으므로 허용목록으로 관리한다.
// 발표·시연 시 노트북 LAN IP나 휴대폰에서 접속하면 Origin 이 localhost 가 아니게 되어
// 기존 하드코딩(http://localhost:5173)으로는 전부 차단됐다.
// ─────────────────────────────────────────────────────────────

const DEFAULT_ORIGINS = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
]

// RFC1918 사설 대역 + 링크로컬만 허용한다. 공인 IP·임의 도메인은 이 패턴으로 통과시키지 않는다.
const LAN_ORIGIN_PATTERN =
    /^https?:\/\/(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|\[::1\]|localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::\d{1,5})?$/

function parseOriginList(raw: string | undefined): string[] {
    if (!raw) return []
    return raw
        .split(',')
        .map((o) => o.trim().replace(/\/+$/, ''))
        .filter((o) => o.length > 0)
}

function resolveLanPolicy(): boolean {
    const flag = process.env.ALLOW_LAN_ORIGINS?.trim().toLowerCase()
    if (flag === 'true') return true
    if (flag === 'false') return false
    // 미지정 시 개발 환경에서만 허용 — 운영 배포에서는 명시적으로 켜야 한다.
    return process.env.NODE_ENV !== 'production'
}

const explicitOrigins = [...new Set([...DEFAULT_ORIGINS, ...parseOriginList(process.env.CLIENT_ORIGINS)])]
const lanAllowed = resolveLanPolicy()

export function isAllowedOrigin(origin: string | undefined): boolean {
    // Origin 헤더가 없는 요청(서버 간 호출, curl, 검증 스크립트)은 CORS 적용 대상이 아니다.
    if (!origin) return true

    const normalized = origin.replace(/\/+$/, '')
    if (explicitOrigins.includes(normalized)) return true
    return lanAllowed && LAN_ORIGIN_PATTERN.test(normalized)
}

export const corsOptions: CorsOptions = {
    origin: (origin, callback) => {
        if (isAllowedOrigin(origin ?? undefined)) return callback(null, true)
        callback(new Error(`CORS: 허용되지 않은 출처 (${origin})`))
    },
    credentials: true,
}

// socket.io 는 cors 패키지가 아니라 자체 옵션을 쓰므로 같은 판정 함수를 공유시킨다.
export const socketCorsOptions = {
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        if (isAllowedOrigin(origin)) return callback(null, true)
        callback(new Error(`CORS: 허용되지 않은 출처 (${origin})`))
    },
    credentials: true,
}

export function describeCorsPolicy(): string {
    const lan = lanAllowed ? '허용(사설 대역만)' : '차단'
    return `CORS 허용 출처: ${explicitOrigins.join(', ')} | LAN 접속: ${lan}`
}
