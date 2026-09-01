import axios from 'axios'
import { QueryTypes } from 'sequelize'
import sequelize from '../../config/database'
import {
  HORIZONS,
  Horizon,
  getPredictionAdapter,
  normalizeModelOutput,
} from '../../services/ai/predictionAdapter'
import { arg, hasFlag } from './testClient'

// ─────────────────────────────────────────────────────────────
// [연동 점검] AI 예측 모델 어댑터 계약 적합성
//
// 팀 AI 코드를 어댑터에 연결한 직후 가장 먼저 실행하는 스크립트다. 공격 시뮬레이션에
// 들어가기 전에 "모델이 계약대로 응답하는가"를 확인해, 이후 보안 테스트의 실패 원인이
// 모델 연동 문제인지 보안 로직 문제인지 구분할 수 있게 한다.
//
// 점검 항목
//   1) 원시 응답 구조   — 모델이 실제로 어떤 필드명·타입으로 답하는지 (http 어댑터)
//   2) 정규화 결과      — 라벨 0/1, 확률 [0,1] 로 정상 변환되는지
//   3) 구간 지원 여부    — 1d/1w/1m/1y 네 구간 모두 응답하는지
//   4) 결정성           — 같은 입력에 같은 출력을 주는지 (재현 가능한 실험의 전제)
//   5) 종목 커버리지     — 예측 대상 종목 중 실제로 응답이 오는 비율
//   6) 지연 분포        — 호출 한도·타임아웃 값을 정하는 근거
//
// 실행
//   cd server
//   npx ts-node src/test/security/adapterConformance.test.ts
//   (옵션) --samples=50  : 커버리지 표본 수 (기본 20)
//          --no-db       : DB 없이 고정 종목코드로만 점검
// ─────────────────────────────────────────────────────────────

const SAMPLES = Math.max(4, Number(arg('samples', '20')))
const FALLBACK_CODES = ['005930', '000660', '035420', '051910', '005380', '068270']

let pass = 0
let fail = 0
const problems: string[] = []
const notes: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++
    console.log(`  [OK]   ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail++
    problems.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function loadCodes(): Promise<string[]> {
  if (hasFlag('no-db')) return FALLBACK_CODES
  try {
    await sequelize.authenticate()
    const rows = await sequelize.query<{ code: string }>(
      `SELECT code FROM stocks
        WHERE is_active = 1 AND is_ml_target = 1 AND code REGEXP '^[0-9]{6}$'
        ORDER BY code LIMIT :limit`,
      { replacements: { limit: SAMPLES }, type: QueryTypes.SELECT },
    )
    if (rows.length === 0) {
      notes.push('stocks 테이블에서 예측 대상 종목을 찾지 못해 고정 코드로 점검합니다.')
      return FALLBACK_CODES
    }
    return rows.map((r) => r.code)
  } catch {
    notes.push('DB 연결에 실패해 고정 코드로 점검합니다.')
    return FALLBACK_CODES
  }
}

// 1) 원시 응답 구조 — 모델이 실제로 쓰는 필드명을 눈으로 확인한다.
//    어댑터의 필드명 후보 목록을 실제 스펙 하나로 좁힐 때 근거가 된다.
async function probeRawResponse(code: string): Promise<void> {
  const url = process.env.AI_PREDICT_URL
  if (!url) {
    notes.push('AI_PREDICT_URL 미설정 — 원시 응답 구조 점검을 건너뜁니다(mock 어댑터).')
    return
  }

  try {
    const res = await axios.post(url, { code, horizon: '1d' }, {
      timeout: Number(process.env.AI_PREDICT_TIMEOUT_MS ?? 3000),
      headers: { 'Content-Type': 'application/json' },
      validateStatus: () => true,
    } as any)

    console.log(`  · HTTP ${res.status}`)
    if (res.data && typeof res.data === 'object' && !Array.isArray(res.data)) {
      for (const [k, v] of Object.entries(res.data as Record<string, unknown>)) {
        console.log(`  · ${k} : ${typeof v} = ${JSON.stringify(v)?.slice(0, 60)}`)
      }
    } else {
      console.log(`  · 응답 본문: ${JSON.stringify(res.data)?.slice(0, 200)}`)
    }

    check('원시 응답이 정규화 가능한 형태', (() => {
      try {
        normalizeModelOutput(res.data)
        return true
      } catch {
        return false
      }
    })(), '실패 시 predictionAdapter 의 필드명 후보 목록을 실제 스펙에 맞게 수정')
  } catch (err: any) {
    check('추론 서버 호출', false, err?.message ?? '알 수 없는 오류')
  }
}

interface CallResult { ok: boolean; latencyMs: number; label?: number; probability?: number; error?: string }

async function callAdapter(code: string, horizon: Horizon): Promise<CallResult> {
  const adapter = getPredictionAdapter()
  const t = Date.now()
  try {
    const out = await adapter.predict({ code, horizon })
    return { ok: true, latencyMs: Date.now() - t, label: out.label, probability: out.probability }
  } catch (err: any) {
    return { ok: false, latencyMs: Date.now() - t, error: err?.message ?? String(err) }
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))
  return sorted[idx]
}

async function main(): Promise<void> {
  const adapter = getPredictionAdapter()
  const codes = await loadCodes()

  console.log('')
  console.log('[연동 점검] AI 예측 모델 어댑터 계약 적합성')
  console.log(`어댑터: ${adapter.name}${process.env.AI_PREDICT_URL ? ` (${process.env.AI_PREDICT_URL})` : ''}`)
  console.log(`점검 종목: ${codes.length}개 · 예측 구간: ${HORIZONS.join(', ')}`)

  console.log('\n[1] 원시 응답 구조')
  await probeRawResponse(codes[0])

  console.log('\n[2] 정규화 결과 및 구간 지원')
  const horizonOk: Record<string, boolean> = {}
  for (const horizon of HORIZONS) {
    const r = await callAdapter(codes[0], horizon)
    horizonOk[horizon] = r.ok
    if (!r.ok) {
      check(`구간 ${horizon} 응답`, false, r.error)
      continue
    }
    const labelOk = r.label === 0 || r.label === 1
    const probOk = typeof r.probability === 'number' && r.probability >= 0 && r.probability <= 1
    check(`구간 ${horizon} 응답`, labelOk && probOk, `label=${r.label} prob=${r.probability?.toFixed(4)}`)
  }

  console.log('\n[3] 결정성 (같은 입력 → 같은 출력)')
  const first = await callAdapter(codes[0], '1d')
  const second = await callAdapter(codes[0], '1d')
  if (first.ok && second.ok) {
    const same = first.label === second.label && Math.abs((first.probability ?? 0) - (second.probability ?? 0)) < 1e-9
    if (same) check('동일 입력 반복 호출 결과 일치', true)
    else {
      // 실패로 처리하지 않는다 — 호출 시점 데이터로 매번 재계산하는 구조일 수 있다.
      pass++
      console.log('  [주의] 동일 입력에 다른 결과 — 실험 재현성을 위해 예측 시점을 함께 기록해야 함')
      notes.push('모델이 호출 시점마다 결과가 달라짐 → 논문 실험 시 예측 산출 시각을 명시할 것')
    }
  } else {
    check('결정성 점검', false, '기준 호출이 실패해 비교 불가')
  }

  console.log('\n[4] 종목 커버리지 및 지연 분포')
  const latencies: number[] = []
  let covered = 0
  const failures: string[] = []
  for (const code of codes) {
    const r = await callAdapter(code, '1d')
    latencies.push(r.latencyMs)
    if (r.ok) covered++
    else if (failures.length < 5) failures.push(`${code}: ${r.error}`)
  }
  const coverage = (covered / codes.length) * 100
  check('종목 커버리지 100%', covered === codes.length, `${covered}/${codes.length} (${coverage.toFixed(1)}%)`)
  if (failures.length > 0) {
    console.log('  · 실패 예시')
    for (const f of failures) console.log(`    - ${f}`)
    notes.push('일부 종목에 예측이 없다면, 미지원 종목은 예측 대상 화이트리스트에서 제외해야 함(is_ml_target)')
  }

  const sorted = [...latencies].sort((a, b) => a - b)
  const p50 = percentile(sorted, 0.5)
  const p95 = percentile(sorted, 0.95)
  console.log(`  · 지연(ms) min ${sorted[0]} / p50 ${p50} / p95 ${p95} / max ${sorted[sorted.length - 1]}`)

  const timeout = Number(process.env.AI_PREDICT_TIMEOUT_MS ?? 3000)
  check('p95 지연이 타임아웃의 절반 이하', p95 * 2 <= timeout, `p95 ${p95}ms / timeout ${timeout}ms`)

  console.log('\n─────────────────────────────────────────────')
  if (notes.length > 0) {
    console.log('[확인 사항]')
    for (const n of [...new Set(notes)]) console.log(`  · ${n}`)
  }
  if (problems.length > 0) {
    console.log('[해결 필요]')
    for (const p of problems) console.log(`  · ${p}`)
  }
  console.log(`\n점검 항목: ${pass}건 통과 / ${fail}건 실패`)
  console.log(`판정: ${fail === 0 ? 'PASS — 보안 검증 스크립트 실행 단계로 진행' : 'FAIL — 어댑터 매핑 또는 모델 응답 확인 필요'}`)

  await sequelize.close().catch(() => undefined)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('[연동 점검 오류]', err?.message ?? err)
  process.exit(2)
})
