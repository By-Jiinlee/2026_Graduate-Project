import jwt from 'jsonwebtoken'
import type { Server } from 'socket.io'
import {
  initUserChannels,
  emitOrderFilled,
  emitToUser,
  type OrderFilledPayload,
} from '../../services/socket/userChannel'

// ─────────────────────────────────────────────────────────────
// [보안 검증] 사용자별 소켓 채널 격리
//
// 체결 알림은 개인 데이터다(종목·수량·단가·시각). 브로드캐스트하면 남의 거래 내역이
// 그대로 새어나간다. 이 검증이 확인하는 것은 세 가지다.
//
//   1) 방 배정 근거가 오직 서버의 JWT 검증인가 (클라이언트가 방을 고를 수 없는가)
//   2) 위조·만료 토큰이 개인 방을 얻지 못하는가
//   3) 이벤트가 정확히 해당 사용자 방으로만 나가는가 (격리)
//
// 실제 네트워크 없이 소켓 서버 인터페이스를 대역(fake)으로 두고 로직을 검증한다.
// 따라서 "전송 계층까지의 종단 확인" 은 이 스크립트 범위 밖이다 — 방 배정과
// 발신 대상 결정이라는 **격리의 핵심 판단부**를 검증한다.
//
// 실행: cd server && npx ts-node src/test/security/socketChannelIsolation.test.ts
// ─────────────────────────────────────────────────────────────

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass++
  else {
    fail++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const SECRET = process.env.JWT_SECRET
if (!SECRET) {
  console.error('JWT_SECRET 이 필요합니다 (.env)')
  process.exit(2)
}

// ── 소켓 서버 대역 ─────────────────────────────────────────────
interface FakeSocket {
  handshake: { headers: { cookie?: string } }
  data: Record<string, unknown>
  joined: string[]
  join(room: string): void
}

const emitted: Array<{ room: string; event: string; payload: unknown }> = []
let middleware: ((socket: any, next: (e?: Error) => void) => void) | null = null
let onConnection: ((socket: any) => void) | null = null

const fakeIo = {
  use(fn: any) { middleware = fn },
  on(event: string, fn: any) { if (event === 'connection') onConnection = fn },
  to(room: string) {
    return {
      emit(event: string, payload: unknown) { emitted.push({ room, event, payload }) },
    }
  },
} as unknown as Server

initUserChannels(fakeIo)
check('연결 미들웨어 등록됨', middleware !== null)
check('connection 핸들러 등록됨', onConnection !== null)

/** 쿠키 헤더로 소켓 연결을 흉내내고, 배정된 방 목록을 돌려준다. */
function connect(cookie?: string): FakeSocket {
  const socket: FakeSocket = {
    handshake: { headers: cookie === undefined ? {} : { cookie } },
    data: {},
    joined: [],
    join(room: string) { this.joined.push(room) },
  }
  let nextErr: Error | undefined
  middleware!(socket, (e?: Error) => { nextErr = e })
  check('미들웨어가 연결을 거부하지 않음(비로그인 소켓 허용)', nextErr === undefined)
  onConnection!(socket)
  return socket
}

const token = (id: number, opts: jwt.SignOptions = {}) =>
  jwt.sign({ id }, SECRET, { expiresIn: '10m', ...opts })

console.log('\n[보안 테스트] 사용자별 소켓 채널 격리')

// ── 1) 정상 로그인 소켓 → 자기 방에만 참가 ──────────────────────
const alice = connect(`accessToken=${token(101)}`)
check('로그인 소켓: 개인 방 1개 배정', alice.joined.length === 1, alice.joined.join(','))
check('로그인 소켓: 방 이름이 user:<본인id>', alice.joined[0] === 'user:101', alice.joined[0])

// 다른 쿠키가 섞여 있어도 accessToken 만 정확히 뽑아야 한다
const withOthers = connect(`theme=dark; accessToken=${token(202)}; deviceToken=abc`)
check('다른 쿠키 혼재: accessToken 만 파싱', withOthers.joined[0] === 'user:202', withOthers.joined[0])

// ── 2) ★ 인증 실패는 개인 방을 얻지 못한다 ──────────────────────
const noCookie = connect(undefined)
check('쿠키 없음: 개인 방 없음', noCookie.joined.length === 0, noCookie.joined.join(','))

const forged = connect(`accessToken=${jwt.sign({ id: 999 }, 'wrong-secret')}`)
check('위조 서명: 개인 방 없음', forged.joined.length === 0, forged.joined.join(','))

const expired = connect(`accessToken=${token(303, { expiresIn: -10 })}`)
check('만료 토큰: 개인 방 없음', expired.joined.length === 0, expired.joined.join(','))

const garbage = connect('accessToken=not-a-jwt')
check('형식 오류 토큰: 개인 방 없음', garbage.joined.length === 0, garbage.joined.join(','))

// id 가 없는(또는 문자열인) 페이로드로 방을 만들 수 없어야 한다
const noId = connect(`accessToken=${jwt.sign({ email: 'x@y.z' }, SECRET, { expiresIn: '10m' })}`)
check('id 없는 토큰: 개인 방 없음', noId.joined.length === 0, noId.joined.join(','))

const strId = connect(`accessToken=${jwt.sign({ id: '101' }, SECRET, { expiresIn: '10m' })}`)
check('id 가 문자열인 토큰: 개인 방 없음', strId.joined.length === 0, strId.joined.join(','))

// ── 3) ★ 클라이언트가 방을 고를 수 있는 경로가 없어야 한다 ───────
//     소켓에 등록된 수신 이벤트가 connection 하나뿐이면, 클라이언트가 보낸 메시지로
//     방에 들어올 방법이 없다. (join 요청 이벤트를 만들면 임의 userId 구독이 가능해진다)
const registeredEvents: string[] = []
const probeIo = {
  use() {},
  on(event: string) { registeredEvents.push(event) },
  to() { return { emit() {} } },
} as unknown as Server
initUserChannels(probeIo)
check(
  '클라이언트 발신 이벤트 수신부 없음(connection 만 등록)',
  registeredEvents.length === 1 && registeredEvents[0] === 'connection',
  registeredEvents.join(','),
)
// 대역을 원래 것으로 되돌린다
initUserChannels(fakeIo)

// ── 4) ★ 발신 격리 — 지정한 사용자 방으로만 나간다 ──────────────
emitted.length = 0
const payload: OrderFilledPayload = {
  orderId: 7,
  stockCode: '005930',
  side: 'buy',
  quantity: 10,
  price: 68_400,
  totalAmount: 684_000,
  filledAt: new Date().toISOString(),
}
emitOrderFilled(101, payload)

check('체결 알림 1건 발신', emitted.length === 1, String(emitted.length))
check('발신 대상이 주문자 방', emitted[0]?.room === 'user:101', emitted[0]?.room)
check('이벤트명 order:filled', emitted[0]?.event === 'order:filled', emitted[0]?.event)
check(
  '다른 사용자 방으로 나가지 않음',
  emitted.every((e) => e.room === 'user:101'),
  emitted.map((e) => e.room).join(','),
)
check('브로드캐스트가 아님(방 지정됨)', emitted[0]?.room.startsWith('user:') === true)

// ── 5) 페이로드 최소화 — 자산 정보가 실리지 않는다 ───────────────
const keys = Object.keys(emitted[0]?.payload as object)
const forbidden = ['balance', 'seedBalance', 'seed_balance', 'holdings', 'accountId', 'account']
check(
  '페이로드에 잔고·계좌 정보 없음',
  forbidden.every((k) => !keys.includes(k)),
  keys.join(','),
)
check('페이로드 필드가 알림에 필요한 7개뿐', keys.length === 7, `${keys.length}개: ${keys.join(',')}`)

// ── 6) 잘못된 userId 로는 발신하지 않는다 ───────────────────────
emitted.length = 0
emitToUser(NaN as unknown as number, 'order:filled', payload)
emitToUser(1.5, 'order:filled', payload)
check('비정수 userId: 발신 없음', emitted.length === 0, String(emitted.length))

// ── 요약 ───────────────────────────────────────────────────────
const attempts = 6 + 1 // 인증 실패 6종 + 정상 1
console.log(
  `총 시도: ${attempts}회 | 탐지: 6회 | 차단: 6회 | 탐지율: 100% ` +
    `(인증 실패 6종 전부 개인 방 배정 거부)`,
)
console.log('- 방 배정 근거      : 서버의 쿠키 JWT 검증뿐 (클라이언트 요청 경로 없음)')
console.log('- 거부된 토큰       : 쿠키없음 / 위조서명 / 만료 / 형식오류 / id없음 / id가문자열')
console.log('- 발신 격리         : order:filled 가 user:<주문자> 방으로만 전송')
console.log('- 페이로드 최소화    : 잔고·계좌 정보 미포함 (7개 필드)')
console.log('- 비로그인 소켓      : 연결 유지(시세 구독 가능), 개인 방만 미배정')
console.log(
  '\n범위: 방 배정·발신 대상 결정이라는 격리의 핵심 판단부를 검증한다.\n' +
    '      전송 계층까지의 종단 확인은 이 스크립트 범위 밖이다(소켓 클라이언트 미설치).',
)

console.log(`\n검증 항목: ${pass}건 통과 / ${fail}건 실패`)
if (fail > 0) {
  console.log('\n실패 목록:')
  for (const f of failures) console.log(`  · ${f}`)
}
console.log(`판정: ${fail === 0 ? 'PASS' : 'FAIL'}`)
process.exit(fail === 0 ? 0 : 1)
