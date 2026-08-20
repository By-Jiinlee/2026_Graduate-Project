import crypto from 'crypto'
import { computeSignature, verifyRequestSignature } from '../../services/auth/hmacService'

// ─────────────────────────────────────────────────────────────
// [보안 검증] HMAC 요청서명 — 무결성·재전송 방어 공격 시뮬레이션
// 실행: cd server && npx ts-node src/test/security/hmacSignature.test.ts
// ─────────────────────────────────────────────────────────────

const secret = crypto.randomBytes(32).toString('hex')
const N = 10

interface SignedReq { ts: string; nonce: string; body: string; sig: string }

function makeSignedReq(payload: object): SignedReq {
  const ts = Date.now().toString()
  const nonce = crypto.randomUUID()
  const body = JSON.stringify(payload)
  const sig = computeSignature(secret, ts, nonce, body)
  return { ts, nonce, body, sig }
}

let normalPass = 0
let tamperBlock = 0
let expireBlock = 0
let replayBlock = 0

const validReqs: SignedReq[] = []

// 1) 정상 서명 — 통과해야 함
for (let i = 0; i < N; i++) {
  const r = makeSignedReq({ stockCode: '005930', quantity: i + 1 })
  validReqs.push(r)
  const res = verifyRequestSignature({ secret, signature: r.sig, timestamp: r.ts, nonce: r.nonce, rawBody: r.body })
  if (res.valid) normalPass++
}

// 2) 본문 변조 — 서명은 원본, 수량만 100배로 위조 → 차단돼야 함
for (let i = 0; i < N; i++) {
  const r = makeSignedReq({ stockCode: '005930', quantity: i + 1 })
  const tamperedBody = JSON.stringify({ stockCode: '005930', quantity: (i + 1) * 100 })
  const res = verifyRequestSignature({ secret, signature: r.sig, timestamp: r.ts, nonce: r.nonce, rawBody: tamperedBody })
  if (!res.valid) tamperBlock++
}

// 3) 만료 — timestamp 를 40초 전으로 → ±30초 창 초과로 차단돼야 함
for (let i = 0; i < N; i++) {
  const ts = (Date.now() - 40_000).toString()
  const nonce = crypto.randomUUID()
  const body = JSON.stringify({ stockCode: '005930', quantity: i + 1 })
  const sig = computeSignature(secret, ts, nonce, body)
  const res = verifyRequestSignature({ secret, signature: sig, timestamp: ts, nonce, rawBody: body })
  if (!res.valid && res.reason === 'EXPIRED') expireBlock++
}

// 4) Replay — 앞서 통과한 정상 요청을 그대로 재전송 → nonce 재사용으로 차단돼야 함
for (const r of validReqs) {
  const res = verifyRequestSignature({ secret, signature: r.sig, timestamp: r.ts, nonce: r.nonce, rawBody: r.body })
  if (!res.valid && res.reason === 'REPLAY') replayBlock++
}

const totalAttempts = N * 4
const totalMalicious = N * 3
const detected = tamperBlock + expireBlock + replayBlock
const detectRate = ((detected / totalMalicious) * 100).toFixed(0)

console.log('[보안 테스트] HMAC 요청서명')
console.log(`총 시도: ${totalAttempts}회 | 탐지: ${detected}회 | 차단: ${detected}회 | 탐지율: ${detectRate}%`)
console.log(`- 정상 서명       : ${normalPass}/${N} 통과`)
console.log(`- 본문 변조       : ${tamperBlock}/${N} 차단`)
console.log(`- 만료(±30s 초과) : ${expireBlock}/${N} 차단`)
console.log(`- Nonce 재사용    : ${replayBlock}/${N} 차단(Replay)`)

const passed = normalPass === N && tamperBlock === N && expireBlock === N && replayBlock === N
process.exit(passed ? 0 : 1)
