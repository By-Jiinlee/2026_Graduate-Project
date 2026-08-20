import { Op, QueryTypes } from 'sequelize'
import sequelize from '../../config/database'
import AnomalyLog from '../../models/auth/AnomalyLog'
import InferenceLog from '../../models/ai/InferenceLog'
import { POLICY } from '../../services/ai/inferenceSecurityService'
import { revokeAllTrustedDevices } from '../../services/auth/trustedDeviceService'
import { IP, Res, arg, die, hasFlag, loginAsTestUser, post } from './testClient'

// ─────────────────────────────────────────────────────────────
// [보안 검증] AI 추론 파이프라인 — E2E 공격 시뮬레이션 (배치 서빙 구조)
//
// v9.7 모델은 "그날 전 종목 중 확신도 상위 X%"를 추천하므로 종목 단건 추론이 불가능하다.
// 따라서 서빙은 배치(stock_predictions 적재) → 조회(table 어댑터) 구조다. 이 스크립트는
// 실제 서비스 경로(HTTP → JWT 인증 → inferenceGuard → table 어댑터 → 응답 최소화 →
// 감사 로그) 전 구간을 통과시켜, 다음을 검증한다.
//
//   [정상]   추천 종목  → 200, 방향·양자화 확률 노출 + 응답 최소화 준수
//            미추천 종목 → 200, 방향·확신도 비노출(자산 보호) — recommended=false
//            미산출 종목 → 404 NOT_PREDICTED (1d/1w/1m 은 상위 500 종목만 산출)
//   [공격]   적대적 입력 → 400(스키마 위반), 인증 우회 → 401, 호출 한도 → 429
//
// 실행 전제
//   1) 서버가 AI_ADAPTER=table 로 실행 중 (배치 조회 경로)
//   2) 마이그레이션 적용 (20260730_inference_logs.sql, 20260730_stock_predictions.sql)
//   3) 배치 예측 적재 (src/test/security/_genBatch.ts → importPredictions.ts)
//   4) 전용 테스트 계정 (신뢰 기기 우회 — 실사용 계정 금지)
//
// 실행
//   npx ts-node src/test/security/aiInference.e2e.test.ts \
//       --email=... --password=... --batch-meta=<batch_e2e_meta.json 경로>
// ─────────────────────────────────────────────────────────────

const PREDICT = '/api/ai/predict'
const EMAIL = arg('email')
const PASSWORD = arg('password')
const HORIZON = '1d' // 배치가 적재된 구간

const ALLOWED_RECOMMENDED_KEYS = ['code', 'horizon', 'predictDate', 'recommended', 'direction', 'confidence', 'disclaimer']
const ALLOWED_NOTREC_KEYS = ['code', 'horizon', 'predictDate', 'recommended', 'message', 'disclaimer']
// 추천 응답에도 절대 나타나면 안 되는 내부 정보 키 — 모델 역공학·순위표 복원 단서
const FORBIDDEN_KEYS = ['prob', 'probability', 'logit', 'score', 'threshold', 'model', 'model_version', 'adapter', 'features', 'label', 'conf_rank']

interface Counter { attempted: number; blocked: number; passed: number }
const counter = (): Counter => ({ attempted: 0, blocked: 0, passed: 0 })
const unexpected: string[] = []

function body(o: unknown): string {
  return typeof o === 'string' ? o : JSON.stringify(o)
}

// 호출 한도는 "사용자당 분당 POLICY.RATE.MAX 회"다. 정상 요청(스키마·화이트리스트를
// 통과해 어댑터에 도달하는 요청)만 예산을 소비하므로, 예산 소비 단계는 분당 창으로
// 나눠 실행한다. 적대적 입력·인증 우회는 예산 소비 전에 거부되어 창에 영향을 주지 않는다.
const WINDOW_MS = POLICY.RATE.WINDOW_MS + 3000
async function freshWindow(label: string): Promise<void> {
  console.log(`  · [${label}] 호출 한도 창 초기화 대기 ${Math.round(WINDOW_MS / 1000)}s...`)
  await new Promise((r) => setTimeout(r, WINDOW_MS))
}

interface BatchClassification {
  date: string
  recommendedCodes: string[]
  notRecommendedCodes: string[]
  excludedCodes: string[]
}

// 어댑터가 실제로 서빙하는 배치(stock_predictions)를 직접 조회해 분류한다.
// 외부 메타 파일에 의존하지 않으므로 테스트 기대값과 DB·서버 응답이 드리프트할 수 없다.
async function loadBatchClassification(): Promise<BatchClassification> {
  const latest = await sequelize.query<{ d: string }>(
    'SELECT MAX(predict_date) AS d FROM stock_predictions WHERE horizon = :h',
    { replacements: { h: HORIZON }, type: QueryTypes.SELECT },
  )
  const date = latest[0]?.d
  if (!date) die(`stock_predictions 에 ${HORIZON} 배치가 없습니다. generateTestBatch.ts → importPredictions.ts 로 적재하세요.`)

  const rows = await sequelize.query<{ ticker: string; recommended: number }>(
    'SELECT ticker, recommended FROM stock_predictions WHERE predict_date = :d AND horizon = :h ORDER BY conf_rank ASC',
    { replacements: { d: date, h: HORIZON }, type: QueryTypes.SELECT },
  )
  const recommendedCodes = rows.filter((r) => Number(r.recommended) === 1).map((r) => r.ticker)
  const notRecommendedCodes = rows.filter((r) => Number(r.recommended) === 0).map((r) => r.ticker)

  // 미산출 종목 = 학습 대상(is_ml_target)이지만 이 배치에 없는 종목
  const excludedRows = await sequelize.query<{ code: string }>(
    `SELECT s.code FROM stocks s
      WHERE s.is_active = 1 AND s.is_ml_target = 1 AND s.code REGEXP '^[0-9]{6}$'
        AND s.code NOT IN (SELECT ticker FROM stock_predictions WHERE predict_date = :d AND horizon = :h)
      ORDER BY s.code LIMIT 10`,
    { replacements: { d: date, h: HORIZON }, type: QueryTypes.SELECT },
  )
  const excludedCodes = excludedRows.map((r) => r.code)

  return { date: String(date), recommendedCodes, notRecommendedCodes, excludedCodes }
}

async function findUnlistedCode(): Promise<string> {
  for (let n = 999999; n > 990000; n--) {
    const code = String(n)
    const rows = await sequelize.query<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM stocks WHERE code = :code',
      { replacements: { code }, type: QueryTypes.SELECT },
    )
    if (Number(rows[0]?.cnt ?? 0) === 0) return code
  }
  die('미상장 종목코드를 찾지 못했습니다.')
}

// 추천 응답의 최소화 검증 — 허용 키만, 내부 정보 없음, 확률 양자화, no-store
function checkRecommendedResponse(res: Res): string[] {
  const p: string[] = []
  const keys = Object.keys(res.data ?? {})
  for (const k of keys) if (!ALLOWED_RECOMMENDED_KEYS.includes(k)) p.push(`허용되지 않은 키: ${k}`)
  for (const k of FORBIDDEN_KEYS) if (keys.includes(k)) p.push(`내부 정보 노출: ${k}`)

  if (res.data?.recommended !== true) p.push('recommended=true 아님')
  const conf = res.data?.confidence
  if (typeof conf !== 'number') p.push('confidence 가 숫자가 아님')
  else {
    const onGrid = Math.abs(conf / POLICY.PROBABILITY_STEP - Math.round(conf / POLICY.PROBABILITY_STEP)) < 1e-9
    if (!onGrid) p.push(`confidence 양자화 안 됨: ${conf}`)
  }
  if (res.data?.direction !== 'UP' && res.data?.direction !== 'DOWN') p.push('direction 값 이상')
  if (typeof res.data?.disclaimer !== 'string') p.push('면책 고지 누락')
  const cc = String(res.headers?.['cache-control'] ?? '')
  if (!cc.includes('no-store')) p.push(`Cache-Control 미설정: ${cc || '없음'}`)
  return p
}

// 미추천 응답 검증 — 방향·확신도가 노출되면 안 된다(그날 순위표 복원 방지)
function checkNotRecommendedResponse(res: Res): string[] {
  const p: string[] = []
  const keys = Object.keys(res.data ?? {})
  for (const k of keys) if (!ALLOWED_NOTREC_KEYS.includes(k)) p.push(`허용되지 않은 키: ${k}`)
  if (res.data?.recommended !== false) p.push('recommended=false 아님')
  if ('direction' in (res.data ?? {})) p.push('미추천인데 direction 노출')
  if ('confidence' in (res.data ?? {})) p.push('미추천인데 confidence 노출')
  const cc = String(res.headers?.['cache-control'] ?? '')
  if (!cc.includes('no-store')) p.push(`Cache-Control 미설정: ${cc || '없음'}`)
  return p
}

async function main(): Promise<void> {
  if (!EMAIL || !PASSWORD) die('사용법: --email=... --password=...')

  await sequelize.authenticate().catch(() => die('DB 연결 실패'))
  const startedAt = new Date()

  const meta = await loadBatchClassification()
  if (meta.recommendedCodes.length < 5 || meta.notRecommendedCodes.length < 12 || meta.excludedCodes.length < 5) {
    die(`배치 분류 부족 (추천 ${meta.recommendedCodes.length}/미추천 ${meta.notRecommendedCodes.length}/제외 ${meta.excludedCodes.length}). generateTestBatch.ts 파라미터(50 10 0.3) 확인.`)
  }
  console.log(`  · 배치 기준일 ${meta.date} — 추천 ${meta.recommendedCodes.length} / 미추천 ${meta.notRecommendedCodes.length} / 미산출표본 ${meta.excludedCodes.length}`)

  const unlisted = await findUnlistedCode()
  const { cookie, userId } = await loginAsTestUser(EMAIL, PASSWORD, false)

  // 어댑터 확인 — table 이 아니면 이 테스트의 전제(배치 조회)가 성립하지 않는다
  const probeCode = meta.recommendedCodes[0]
  let ready = false
  for (let i = 0; i < 15; i++) {
    const res = await post(PREDICT, body({ code: probeCode, horizon: '1d' }), { ip: IP.NORMAL, cookie })
    if (res.status === 200) { ready = true; break }
    if (res.status === 404) die(`사전 점검 실패 — 추천 종목(${probeCode})이 404. 배치 적재/AI_ADAPTER=table 여부 확인.`)
    if (res.status !== 429) die(`사전 점검 실패: ${res.status} ${JSON.stringify(res.data)}`)
    console.log(`  · 호출 한도 창 대기... (${i + 1}/15)`)
    await new Promise((r) => setTimeout(r, 5000))
  }
  if (!ready) die('호출 한도 창이 비워지지 않았습니다. 1분 후 재실행.')

  // ── S1) 정상 — 추천 종목 (200 + 응답 최소화 준수)
  const recCounter = counter()
  const minProblems: string[] = []
  const recSample = meta.recommendedCodes.slice(0, 5)
  for (const code of recSample) {
    recCounter.attempted++
    const res = await post(PREDICT, body({ code, horizon: '1d' }), { ip: IP.NORMAL, cookie })
    if (res.status === 200 && res.data?.recommended === true) {
      recCounter.passed++
      minProblems.push(...checkRecommendedResponse(res))
    } else {
      recCounter.blocked++
      unexpected.push(`S1 추천 ${code}: ${res.status} ${JSON.stringify(res.data)?.slice(0, 100)}`)
    }
  }

  // ── S2) 정상 — 미추천 종목 (200 + 방향·확신도 비노출)
  const notRecCounter = counter()
  const notRecProblems: string[] = []
  const notRecSample = meta.notRecommendedCodes.slice(0, 10)
  for (const code of notRecSample) {
    notRecCounter.attempted++
    const res = await post(PREDICT, body({ code, horizon: '1d' }), { ip: IP.NORMAL, cookie })
    if (res.status === 200 && res.data?.recommended === false) {
      notRecCounter.passed++
      notRecProblems.push(...checkNotRecommendedResponse(res))
    } else {
      notRecCounter.blocked++
      unexpected.push(`S2 미추천 ${code}: ${res.status} ${JSON.stringify(res.data)?.slice(0, 100)}`)
    }
  }

  // ── S4) 적대적 입력 — 모델(배치) 도달 전 스키마 단계에서 차단
  const inBatch = meta.recommendedCodes[0]
  const adversarial: { name: string; payload: unknown; expect: string }[] = [
    { name: '허용 외 필드(피처 주입)', payload: { code: inBatch, horizon: '1d', features: [1, 2, 3] }, expect: 'UNKNOWN_FIELD' },
    { name: '임계값 파라미터 주입',    payload: { code: inBatch, horizon: '1d', threshold: 0.01 },     expect: 'UNKNOWN_FIELD' },
    { name: '프로토타입 오염',        payload: '{"__proto__":{"admin":true},"code":"' + inBatch + '","horizon":"1d"}', expect: 'UNKNOWN_FIELD' },
    { name: 'code 형식 위반(문자)',   payload: { code: 'AAPL', horizon: '1d' },                        expect: 'INVALID_CODE' },
    { name: 'code SQL 주입',          payload: { code: "005930' OR '1'='1", horizon: '1d' },            expect: 'INVALID_CODE' },
    { name: 'code 초장문(10KB)',      payload: { code: '0'.repeat(10000), horizon: '1d' },             expect: 'INVALID_CODE' },
    { name: 'code 타입 위반(숫자)',   payload: { code: 5930, horizon: '1d' },                          expect: 'INVALID_SHAPE' },
    { name: 'code NoSQL 연산자',      payload: { code: { $ne: null }, horizon: '1d' },                 expect: 'INVALID_SHAPE' },
    { name: '본문이 배열',            payload: [{ code: inBatch, horizon: '1d' }],                     expect: 'INVALID_SHAPE' },
    { name: 'horizon 미지원 값',      payload: { code: inBatch, horizon: '3d' },                       expect: 'INVALID_HORIZON' },
    { name: 'horizon 명령 주입',      payload: { code: inBatch, horizon: '1d; rm -rf /' },             expect: 'INVALID_HORIZON' },
    { name: 'horizon XSS',            payload: { code: inBatch, horizon: '<script>alert(1)</script>' }, expect: 'INVALID_HORIZON' },
    { name: '미상장 종목코드',        payload: { code: unlisted, horizon: '1d' },                      expect: 'UNKNOWN_CODE' },
  ]
  const adv = counter()
  let advReasonMatched = 0
  for (const a of adversarial) {
    adv.attempted++
    const res = await post(PREDICT, body(a.payload), { ip: IP.MALFORMED, cookie })
    if ((res.status === 400 || res.status === 404) && res.data?.reason) {
      adv.blocked++
      if (res.data.reason === a.expect) advReasonMatched++
      else unexpected.push(`S4 ${a.name}: 사유 불일치 기대 ${a.expect} / 실제 ${res.data.reason}`)
    } else {
      adv.passed++
      unexpected.push(`S4 ${a.name}: 차단 안 됨 (${res.status} ${JSON.stringify(res.data)?.slice(0, 80)})`)
    }
  }

  // 깨진 JSON — express 본문 파서에서 거부돼야 함
  const brokenJson = await post(PREDICT, '{"code":"005930","horizon":', { ip: IP.MALFORMED, cookie })
  const brokenBlocked = brokenJson.status >= 400 && brokenJson.status < 500
  if (!brokenBlocked) unexpected.push(`S4 깨진 JSON: 차단 안 됨 (${brokenJson.status})`)

  // ── S5) 인증 우회 — 추론 조회는 인증 없이 불가
  const authTests = [
    { name: '쿠키 없음', cookie: undefined },
    { name: '위조 토큰', cookie: 'accessToken=eyJhbGciOiJIUzI1NiJ9.fake.sig' },
  ]
  const auth = counter()
  for (const t of authTests) {
    auth.attempted++
    const res = await post(PREDICT, body({ code: inBatch, horizon: '1d' }), { ip: IP.ANON, cookie: t.cookie })
    if (res.status === 401) auth.blocked++
    else unexpected.push(`S5 ${t.name}: 401 아님 (${res.status})`)
  }

  // ── S3) 미산출 종목 — ml_target 이지만 배치에 없음 → 404 NOT_PREDICTED
  //   유효 요청이라 호출 예산을 소비하므로 새 분당 창에서 실행한다.
  await freshWindow('S3 미산출')
  const notPredCounter = counter()
  for (const code of meta.excludedCodes.slice(0, 5)) {
    notPredCounter.attempted++
    const res = await post(PREDICT, body({ code, horizon: '1d' }), { ip: IP.NORMAL, cookie })
    if (res.status === 404 && res.data?.reason === 'NOT_PREDICTED') notPredCounter.blocked++
    else unexpected.push(`S3 미산출 ${code}: ${res.status} ${JSON.stringify(res.data)?.slice(0, 100)}`)
  }

  // ── S6) 호출 한도 — 새 창에서 예산 소진 후 초과 요청이 429 로 차단되는지
  await freshWindow('S6 호출 한도')
  const quota = counter()
  let firstBlockAt = -1
  const QUOTA_PROBES = POLICY.RATE.MAX + 5
  for (let i = 0; i < QUOTA_PROBES; i++) {
    quota.attempted++
    const res = await post(PREDICT, body({ code: inBatch, horizon: '1d' }), { ip: IP.EXTRACTION, cookie })
    if (res.status === 429 && res.data?.reason === 'RATE_LIMIT') {
      quota.blocked++
      if (firstBlockAt < 0) firstBlockAt = i
    } else if (res.status === 200) {
      quota.passed++
      if (firstBlockAt >= 0) unexpected.push(`S6 한도 초과 후 통과 (#${i + 1})`)
    } else {
      unexpected.push(`S6 예상 외 (#${i + 1}): ${res.status}`)
    }
  }
  const quotaConsistent = firstBlockAt >= 0 && quota.passed <= POLICY.RATE.MAX

  // ── DB 교차 확인
  await new Promise((r) => setTimeout(r, 1500))
  const infLogs = await InferenceLog.findAll({ where: { user_id: userId, created_at: { [Op.gte]: startedAt } } })
  const allowLogs = infLogs.filter((l) => l.decision === 'ALLOW').length
  const denyLogs = infLogs.filter((l) => l.decision === 'DENY').length
  const denyByReason = infLogs.filter((l) => l.decision === 'DENY').reduce<Record<string, number>>((a, l) => {
    const r = l.deny_reason ?? 'null'; a[r] = (a[r] ?? 0) + 1; return a
  }, {})

  const anomalies = await AnomalyLog.findAll({
    where: { user_id: userId, anomaly_type: { [Op.in]: ['ADVERSARIAL_INPUT', 'INFERENCE_ABUSE'] }, created_at: { [Op.gte]: startedAt } },
  })
  const anomalyByType = anomalies.reduce<Record<string, number>>((a, x) => { a[x.anomaly_type] = (a[x.anomaly_type] ?? 0) + 1; return a }, {})

  // ── 집계
  const attackAttempted = adv.attempted + 1 + auth.attempted + quota.blocked
  const attackBlocked = adv.blocked + (brokenBlocked ? 1 : 0) + auth.blocked + quota.blocked
  const detectRate = attackAttempted > 0 ? ((attackBlocked / attackAttempted) * 100).toFixed(0) : '0'
  const normalTotal = recCounter.attempted + notRecCounter.attempted
  const normalPassed = recCounter.passed + notRecCounter.passed
  const fpr = normalTotal > 0 ? (((normalTotal - normalPassed) / normalTotal) * 100).toFixed(0) : '0'

  console.log('')
  console.log('[보안 테스트] AI 추론 파이프라인 보안 (E2E — 배치 서빙, 실제 HTTP·인증·DB)')
  console.log(`총 시도: ${normalTotal + notPredCounter.attempted + attackAttempted}회 | 탐지: ${attackBlocked}회 | 차단: ${attackBlocked}회 | 탐지율: ${detectRate}%`)
  console.log(`- 추천 종목 응답   : ${recCounter.passed}/${recCounter.attempted} (200, 응답 최소화 위반 ${minProblems.length}건)`)
  console.log(`- 미추천 종목 응답 : ${notRecCounter.passed}/${notRecCounter.attempted} (200, 방향·확신도 비노출 위반 ${notRecProblems.length}건)`)
  console.log(`- 미산출 종목      : ${notPredCounter.blocked}/${notPredCounter.attempted} (404 NOT_PREDICTED)`)
  console.log(`- 적대적 입력      : ${adv.blocked}/${adv.attempted} 차단 (사유 정확 ${advReasonMatched}/${adv.attempted})`)
  console.log(`- 깨진 JSON        : ${brokenBlocked ? '차단' : '통과(문제)'}`)
  console.log(`- 인증 우회        : ${auth.blocked}/${auth.attempted} 차단 (401)`)
  console.log(`- 호출 한도        : ${quota.passed}회 허용 후 ${quota.blocked}회 차단 (한도 ${POLICY.RATE.MAX}/분, 연속성 ${quotaConsistent ? 'OK' : '이상'})`)
  console.log(`- 정상 요청 오탐률 : ${fpr}% (정상 ${normalTotal}회 중 ${normalTotal - normalPassed}회 비정상 응답)`)
  console.log(`- inference_logs   : 허용 ${allowLogs}건 / 차단 ${denyLogs}건 ${JSON.stringify(denyByReason)}`)
  console.log(`- anomaly_logs     : 적대적 입력 ${anomalyByType.ADVERSARIAL_INPUT ?? 0}건 / 조회 남용 ${anomalyByType.INFERENCE_ABUSE ?? 0}건`)

  if (minProblems.length > 0) { console.log('\n[추천 응답 최소화 위반]'); for (const x of [...new Set(minProblems)]) console.log(`  · ${x}`) }
  if (notRecProblems.length > 0) { console.log('\n[미추천 응답 노출 위반]'); for (const x of [...new Set(notRecProblems)]) console.log(`  · ${x}`) }
  if (unexpected.length > 0) { console.log('\n[예상과 다른 응답]'); for (const x of unexpected) console.log(`  · ${x}`) }

  if (!hasFlag('keep-device')) await revokeAllTrustedDevices(userId)
  await sequelize.close()

  const passed =
    recCounter.passed === recCounter.attempted &&
    notRecCounter.passed === notRecCounter.attempted &&
    notPredCounter.blocked === notPredCounter.attempted &&
    minProblems.length === 0 &&
    notRecProblems.length === 0 &&
    adv.blocked === adv.attempted &&
    advReasonMatched === adv.attempted &&
    brokenBlocked &&
    auth.blocked === auth.attempted &&
    quotaConsistent &&
    allowLogs > 0 && denyLogs > 0

  console.log(`\n판정: ${passed ? 'PASS' : 'FAIL'}`)
  process.exit(passed ? 0 : 1)
}

main().catch((err) => { console.error('[E2E 오류]', err?.message ?? err); process.exit(2) })
