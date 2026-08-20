import crypto from 'crypto'
import { Op } from 'sequelize'
import sequelize from '../../config/database'
import AnomalyLog from '../../models/auth/AnomalyLog'
import { computeSignature } from '../../services/auth/hmacService'
import { revokeAllTrustedDevices } from '../../services/auth/trustedDeviceService'
import { IP, Res, arg, die, hasFlag, loginAsTestUser, post } from './testClient'

// ─────────────────────────────────────────────────────────────
// [보안 검증] HMAC 요청서명 — E2E(End-to-End) 공격 시뮬레이션
//
// hmacSignature.test.ts 는 검증 함수를 직접 호출하는 단위 검증이다. 이 스크립트는
// "실제 서비스 경로에서 차단되는가"를 확인한다. 즉 HTTP → ipBlockMiddleware →
// isAuthenticated(JWT) → requirePhoneVerified → hmacMiddleware → 거래 컨트롤러
// 전 구간을 통과시키고, 탐지 결과가 DB(anomaly_logs)에 남는지까지 교차 확인한다.
//
// 실행 전제
//   1) 서버 실행 중 (cd server && npm run dev)
//   2) 마이그레이션 적용
//      npx ts-node src/database/migrations/apply.ts 20260730_anomaly_type_hmac.sql
//   3) 휴대폰 인증이 완료된 전용 테스트 계정 (신뢰 기기가 덮어써지므로 실사용 계정 금지)
//
// 실행
//   cd server
//   npx ts-node src/test/security/hmacSignature.e2e.test.ts --email=test@x.com --password=xxxx
// ─────────────────────────────────────────────────────────────

const N = 10
const BUY = '/api/trade/virtual/buy'

const EMAIL = arg('email')
const PASSWORD = arg('password')

// 매수 요청 본문 — 실제 주문 형태를 유지하되 pin 을 의도적으로 제외한다.
// 서명 검증을 통과하면 컨트롤러의 필수 파라미터 검사에서 400 으로 멈추므로,
// 계좌 잔고·보유 종목에 부수효과 없이 "미들웨어 통과 여부"만 관측할 수 있다.
function orderBody(quantity: number): string {
  return JSON.stringify({ stockId: 1, stockCode: '005930', quantity, orderType: 'market' })
}

type Verdict =
  | { kind: 'HMAC_BLOCK'; reason: string }   // hmacMiddleware 가 차단
  | { kind: 'IP_BLOCK' }                     // ipBlockMiddleware 가 차단(반복 실패 에스컬레이션)
  | { kind: 'PASSED' }                       // 서명 검증 통과 → 컨트롤러 도달
  | { kind: 'OTHER'; note: string }          // 판정 불가

function classify(res: Res): Verdict {
  if (res.status === 403 && res.data?.reason) return { kind: 'HMAC_BLOCK', reason: String(res.data.reason) }
  if (res.status === 403 && typeof res.data?.message === 'string' && res.data.message.includes('접근이 차단')) {
    return { kind: 'IP_BLOCK' }
  }
  if (res.status === 400 && typeof res.data?.message === 'string' && res.data.message.includes('필수 파라미터')) {
    return { kind: 'PASSED' }
  }
  return { kind: 'OTHER', note: `${res.status} ${JSON.stringify(res.data)?.slice(0, 120)}` }
}

async function main(): Promise<void> {
  if (!EMAIL || !PASSWORD) {
    die('사용법: npx ts-node src/test/security/hmacSignature.e2e.test.ts --email=... --password=...')
  }

  await sequelize.authenticate().catch(() => die('DB 연결 실패 — .env 의 DB 설정을 확인하세요.'))
  const startedAt = new Date()

  const { cookie, signingSecret, userId } = await loginAsTestUser(EMAIL, PASSWORD)

  const sign = (body: string, tsOffsetMs = 0) => {
    const ts = (Date.now() + tsOffsetMs).toString()
    const nonce = crypto.randomUUID()
    return { ts, nonce, sig: computeSignature(signingSecret, ts, nonce, body) }
  }

  // 사전 점검 — 정상 서명 1건이 실제로 컨트롤러까지 도달하는지 확인(경로 유효성)
  const probeBody = orderBody(1)
  const probe = classify(await post(BUY, probeBody, { ip: IP.NORMAL, cookie, sign: sign(probeBody) }))
  if (probe.kind !== 'PASSED') {
    die(`사전 점검 실패 — 정상 서명 요청이 컨트롤러에 도달하지 못했습니다: ${JSON.stringify(probe)}`)
  }

  const result = { normalPass: 0, tamperBlock: 0, expireBlock: 0, replayBlock: 0, escalated: false }
  const unexpected: string[] = []
  const note = (scenario: string, v: Verdict) => unexpected.push(`${scenario}: ${JSON.stringify(v)}`)

  // ── S1) 정상 서명 10회 — 통과해야 정상 (오탐률 측정)
  const validReqs: { body: string; sign: { ts: string; nonce: string; sig: string } }[] = []
  for (let i = 0; i < N; i++) {
    const body = orderBody(i + 1)
    const s = sign(body)
    validReqs.push({ body, sign: s })
    const v = classify(await post(BUY, body, { ip: IP.NORMAL, cookie, sign: s }))
    if (v.kind === 'PASSED') result.normalPass++
    else note('S1 정상', v)
  }

  // ── S2) 재전송 10회 — S1 에서 통과한 요청을 그대로 재사용 (논스 중복으로 차단)
  //   타임스탬프 창(±30초)을 넘기지 않도록 정상 요청 직후에 수행한다.
  for (const r of validReqs) {
    const v = classify(await post(BUY, r.body, { ip: IP.REPLAY, cookie, sign: r.sign }))
    if (v.kind === 'HMAC_BLOCK' && v.reason === 'REPLAY') result.replayBlock++
    else note('S2 재전송', v)
  }

  // ── S3) 본문 변조 10회 — 서명은 원본, 수량만 100배로 위조
  for (let i = 0; i < N; i++) {
    const original = orderBody(i + 1)
    const s = sign(original)
    const tampered = orderBody((i + 1) * 100)
    const v = classify(await post(BUY, tampered, { ip: IP.TAMPER, cookie, sign: s }))
    if (v.kind === 'HMAC_BLOCK' && v.reason === 'BAD_SIGNATURE') result.tamperBlock++
    else note('S3 변조', v)
  }

  // ── S4) 서명 만료 10회 — 타임스탬프를 40초 전으로 (허용 창 ±30초 초과)
  for (let i = 0; i < N; i++) {
    const body = orderBody(i + 1)
    const s = sign(body, -40_000)
    const v = classify(await post(BUY, body, { ip: IP.EXPIRE, cookie, sign: s }))
    if (v.kind === 'HMAC_BLOCK' && v.reason === 'EXPIRED') result.expireBlock++
    else note('S4 만료', v)
  }

  // ── S5) 대응 검증 — 변조 IP 는 반복 실패로 차단 목록에 올라가야 한다.
  //   탐지 기록은 응답 이후 비동기로 처리되므로 잠시 대기한 뒤 확인한다.
  await new Promise((r) => setTimeout(r, 2000))
  const afterBody = orderBody(1)
  const after = classify(await post(BUY, afterBody, { ip: IP.TAMPER, cookie, sign: sign(afterBody) }))
  result.escalated = after.kind === 'IP_BLOCK'
  if (!result.escalated) note('S5 에스컬레이션', after)

  // ── DB 교차 확인 — 탐지가 anomaly_logs 에 기록되었는지
  const logs = await AnomalyLog.findAll({
    where: {
      user_id: userId,
      anomaly_type: { [Op.in]: ['REQUEST_TAMPERING', 'REPLAY_ATTACK'] },
      created_at: { [Op.gte]: startedAt },
    },
  })
  const byType = logs.reduce<Record<string, number>>((acc, l) => {
    acc[l.anomaly_type] = (acc[l.anomaly_type] ?? 0) + 1
    return acc
  }, {})

  const maliciousTotal = N * 3
  const totalAttempts = N * 4 + 1                                              // 시나리오 40회 + 에스컬레이션 확인 1회
  const detected = result.tamperBlock + result.expireBlock + result.replayBlock
  const detectRate = ((detected / maliciousTotal) * 100).toFixed(0)
  const fpr = (((N - result.normalPass) / N) * 100).toFixed(0)

  console.log('')
  console.log('[보안 테스트] HMAC 요청서명 (E2E — 실제 HTTP·인증·DB 경로)')
  console.log(`총 시도: ${totalAttempts}회 | 탐지: ${detected}회 | 차단: ${detected}회 | 탐지율: ${detectRate}%`)
  console.log(`- 정상 서명       : ${result.normalPass}/${N} 통과 (오탐률 ${fpr}%)`)
  console.log(`- 요청 본문 변조  : ${result.tamperBlock}/${N} 차단 (BAD_SIGNATURE)`)
  console.log(`- 서명 만료       : ${result.expireBlock}/${N} 차단 (EXPIRED)`)
  console.log(`- 논스 재사용     : ${result.replayBlock}/${N} 차단 (REPLAY)`)
  console.log(`- 반복 실패 대응  : ${result.escalated ? 'IP 차단 확인' : '미확인'} (${IP.TAMPER})`)
  console.log(`- anomaly_logs    : 요청 위·변조 ${byType.REQUEST_TAMPERING ?? 0}건 / 재전송 ${byType.REPLAY_ATTACK ?? 0}건 기록`)
  console.log(`- 공격 출처 IP    : ${IP.TAMPER} / ${IP.EXPIRE} / ${IP.REPLAY} (외부 IP로 위조 전송)`)

  if (unexpected.length > 0) {
    console.log('\n[예상과 다른 응답]')
    for (const u of unexpected) console.log(`  · ${u}`)
  }

  if (!hasFlag('keep-device')) await revokeAllTrustedDevices(userId)
  await sequelize.close()

  const passed =
    result.normalPass === N &&
    result.tamperBlock === N &&
    result.expireBlock === N &&
    result.replayBlock === N &&
    result.escalated &&
    logs.length >= maliciousTotal

  console.log(`\n판정: ${passed ? 'PASS' : 'FAIL'}`)
  process.exit(passed ? 0 : 1)
}

main().catch((err) => {
  console.error('[E2E 테스트 오류]', err?.message ?? err)
  process.exit(2)
})
