import { Server } from 'socket.io'
import * as authService from '../auth/authService'

// ─────────────────────────────────────────────────────────────
// 사용자 전용 실시간 채널
//
// 왜 필요한가
//   지금 소켓은 시세(`stock:price`, `index:price`)만 내보낸다. 시세는 공개 데이터라
//   전체 브로드캐스트로 충분하지만, **체결 알림은 개인 데이터**다.
//   종목·수량·단가·시각이 담기므로 브로드캐스트하면 남의 거래 내역이 그대로 새어나간다.
//
//   그래서 로그인한 소켓만 자기 방(`user:<id>`)에 넣고, 개인 이벤트는 그 방으로만 보낸다.
//
// 설계 원칙
//   1) **방 참가는 서버가 정한다.** 클라이언트가 "이 방에 넣어줘" 라고 요청하는 경로를
//      만들지 않는다. 그런 경로가 있으면 임의 userId 를 보내 남의 채널을 구독할 수 있다.
//      참가 근거는 오직 쿠키의 JWT 검증 결과뿐이다.
//   2) **비로그인 연결도 허용한다.** 랜딩 페이지 등에서 시세만 보는 소켓이 이미 있고,
//      여기서 연결을 끊으면 기존 기능이 깨진다. 인증 실패는 "개인 방 없음" 으로만 처리한다.
//   3) 토큰 만료·위조는 조용히 비로그인으로 취급한다. 소켓 연결 단계에서 인증 실패 사유를
//      돌려주면 토큰 유효성 확인용 오라클로 쓰일 수 있다.
// ─────────────────────────────────────────────────────────────

const userRoom = (userId: number): string => `user:${userId}`

let ioRef: Server | null = null

/** 쿠키 헤더에서 특정 키만 꺼낸다. cookie-parser 는 HTTP 요청 전용이라 소켓에서는 못 쓴다. */
function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim())
    }
  }
  return null
}

/** 소켓 인증 + 개인 방 배정. index.ts 에서 소켓 서버 생성 직후 한 번 호출한다. */
export function initUserChannels(io: Server): void {
  ioRef = io

  io.use((socket, next) => {
    const token = readCookie(socket.handshake.headers.cookie, 'accessToken')
    if (token) {
      try {
        const decoded = authService.verifyAccessToken(token) as { id?: number }
        if (typeof decoded?.id === 'number') socket.data.userId = decoded.id
      } catch {
        // 만료·위조 — 비로그인 소켓으로 취급한다(연결은 유지, 개인 방 없음)
      }
    }
    next()
  })

  io.on('connection', (socket) => {
    const userId = socket.data.userId
    if (typeof userId === 'number') socket.join(userRoom(userId))
  })
}

/** 특정 사용자에게만 이벤트 전송. 소켓 서버가 아직 없으면 조용히 무시한다. */
export function emitToUser(userId: number, event: string, payload: unknown): void {
  if (!ioRef || !Number.isInteger(userId)) return
  ioRef.to(userRoom(userId)).emit(event, payload)
}

export interface OrderFilledPayload {
  orderId: number
  stockCode: string
  side: 'buy' | 'sell'
  quantity: number
  price: number
  totalAmount: number
  filledAt: string
}

/**
 * 지정가 체결 알림.
 *
 * 잔고·보유수량은 담지 않는다 — 알림에 필요하지 않고, 소켓 페이로드에 자산 정보를
 * 실어 보낼수록 유출 시 피해가 커진다. 화면 갱신이 필요하면 클라이언트가
 * 인증된 API 로 다시 조회하게 한다.
 */
export function emitOrderFilled(userId: number, payload: OrderFilledPayload): void {
  emitToUser(userId, 'order:filled', payload)
}
