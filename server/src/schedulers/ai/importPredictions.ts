import fs from 'fs'
import path from 'path'
import sequelize from '../../config/database'
import StockPrediction from '../../models/ai/StockPrediction'
import { HORIZONS, Horizon } from '../../services/ai/predictionAdapter'

// ─────────────────────────────────────────────────────────────
// AI 예측 배치 결과 적재 (predict_v97.py 출력 CSV → stock_predictions)
//
// v9.7 모델은 "그날 전 종목 중 확신도 상위 X%"를 추천하므로 종목 단건 추론이 불가능하다.
// 따라서 AI 측이 하루 1회 전 종목 예측을 산출하고(CSV), 웹 서버는 그 결과만 적재·조회한다.
//
// 입력 CSV 헤더 (predict_v97.py 스펙)
//   date, ticker, horizon, prob, confidence, direction, recommended, conf_rank
//
// 보안 원칙: 외부에서 생성된 파일을 신뢰하지 않는다.
//   · 모든 행을 형식·범위·상호 일관성까지 검증하고, 위반이 있으면 한 건도 적재하지 않는다
//     (부분 적재로 예측이 섞이는 것을 막기 위한 fail-closed)
//   · ticker 는 6자리 숫자만 허용하여 임의 문자열이 조회 키로 들어오는 것을 차단한다
//   · 같은 (기준일, 종목, 구간)은 upsert 로 덮어써 중복 적재를 방지한다
//
// 실행
//   cd server
//   npx ts-node src/schedulers/ai/importPredictions.ts --file=../pred_1d.csv --version=v9.7
//   (옵션) --dry-run : 검증만 수행하고 적재하지 않음
// ─────────────────────────────────────────────────────────────

const CODE_PATTERN = /^\d{6}$/
const CHUNK = 1000
// prob/confidence 는 소수 4자리로 반올림되어 오므로 상호 검증에 여유를 둔다
const TOLERANCE = 0.0002

export interface PredictionRow {
  predict_date: string
  ticker: string
  horizon: Horizon
  prob: number
  confidence: number
  direction: 'UP' | 'DOWN'
  recommended: boolean
  conf_rank: number
  model_version: string
}

export interface ParseResult {
  rows: PredictionRow[]
  errors: string[]
  stats: { total: number; recommended: number; byHorizon: Record<string, number> }
}

function normalizeHorizon(raw: string): Horizon | null {
  const v = raw.trim().replace(/^label_/, '')
  return (HORIZONS as readonly string[]).includes(v) ? (v as Horizon) : null
}

function normalizeDirection(raw: string): 'UP' | 'DOWN' | null {
  const v = raw.trim().toUpperCase()
  if (v === 'UP' || v === '상승' || v === '1') return 'UP'
  if (v === 'DOWN' || v === '하락' || v === '0') return 'DOWN'
  return null
}

/** CSV 문자열을 검증된 행 목록으로 변환한다. 값에 쉼표가 없는 단순 CSV 전용. */
export function parsePredictionCsv(text: string, modelVersion: string): ParseResult {
  const errors: string[] = []
  const rows: PredictionRow[] = []

  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length < 2) {
    return { rows, errors: ['CSV 에 데이터 행이 없습니다'], stats: { total: 0, recommended: 0, byHorizon: {} } }
  }

  const header = lines[0].split(',').map((h) => h.trim())
  const required = ['date', 'ticker', 'horizon', 'prob', 'confidence', 'direction', 'recommended', 'conf_rank']
  const idx: Record<string, number> = {}
  for (const key of required) {
    const i = header.indexOf(key)
    if (i < 0) errors.push(`필수 컬럼 누락: ${key}`)
    idx[key] = i
  }
  if (errors.length > 0) return { rows, errors, stats: { total: 0, recommended: 0, byHorizon: {} } }

  const seen = new Set<string>()
  const rankByHorizon = new Map<string, Set<number>>()
  const byHorizon: Record<string, number> = {}
  let recommendedCount = 0

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',')
    const at = (k: string) => (cells[idx[k]] ?? '').trim()
    const lineNo = i + 1
    const fail = (msg: string) => errors.push(`${lineNo}행: ${msg}`)

    const dateRaw = at('date')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) { fail(`날짜 형식 오류(${dateRaw})`); continue }
    const parsed = new Date(`${dateRaw}T00:00:00Z`)
    if (Number.isNaN(parsed.getTime())) { fail(`존재하지 않는 날짜(${dateRaw})`); continue }

    const ticker = at('ticker')
    if (!CODE_PATTERN.test(ticker)) { fail(`종목코드 형식 오류(${ticker})`); continue }

    const horizon = normalizeHorizon(at('horizon'))
    if (!horizon) { fail(`예측 구간 값 오류(${at('horizon')})`); continue }

    const prob = Number(at('prob'))
    if (!Number.isFinite(prob) || prob < 0 || prob > 1) { fail(`확률 범위 오류(${at('prob')})`); continue }

    const confidence = Number(at('confidence'))
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 0.5) {
      fail(`확신도 범위 오류(${at('confidence')})`); continue
    }
    if (Math.abs(confidence - Math.abs(prob - 0.5)) > TOLERANCE) {
      fail(`확신도 불일치(prob=${prob}, confidence=${confidence})`); continue
    }

    const direction = normalizeDirection(at('direction'))
    if (!direction) { fail(`방향 값 오류(${at('direction')})`); continue }
    if ((prob >= 0.5 ? 'UP' : 'DOWN') !== direction) {
      fail(`방향-확률 불일치(prob=${prob}, direction=${at('direction')})`); continue
    }

    const recRaw = at('recommended')
    if (recRaw !== '0' && recRaw !== '1') { fail(`추천 여부 값 오류(${recRaw})`); continue }

    const confRank = Number(at('conf_rank'))
    if (!Number.isInteger(confRank) || confRank < 1) { fail(`순위 값 오류(${at('conf_rank')})`); continue }

    const key = `${dateRaw}|${ticker}|${horizon}`
    if (seen.has(key)) { fail(`중복 행(${key})`); continue }
    seen.add(key)

    const rankKey = `${dateRaw}|${horizon}`
    if (!rankByHorizon.has(rankKey)) rankByHorizon.set(rankKey, new Set())
    const rankSet = rankByHorizon.get(rankKey)!
    if (rankSet.has(confRank)) { fail(`확신도 순위 중복(${rankKey} rank=${confRank})`); continue }
    rankSet.add(confRank)

    if (recRaw === '1') recommendedCount++
    byHorizon[horizon] = (byHorizon[horizon] ?? 0) + 1

    rows.push({
      predict_date: dateRaw,
      ticker,
      horizon,
      prob,
      confidence,
      direction,
      recommended: recRaw === '1',
      conf_rank: confRank,
      model_version: modelVersion,
    })
  }

  return { rows, errors, stats: { total: rows.length, recommended: recommendedCount, byHorizon } }
}

export async function importPredictionFile(
  filePath: string,
  modelVersion: string,
  dryRun = false,
): Promise<ParseResult> {
  const text = fs.readFileSync(filePath, 'utf8')
  const result = parsePredictionCsv(text, modelVersion)

  if (result.errors.length > 0) return result
  if (dryRun || result.rows.length === 0) return result

  for (let i = 0; i < result.rows.length; i += CHUNK) {
    const slice = result.rows.slice(i, i + CHUNK)
    await StockPrediction.bulkCreate(slice, {
      updateOnDuplicate: ['prob', 'confidence', 'direction', 'recommended', 'conf_rank', 'model_version'],
    })
  }

  return result
}

// ── CLI ──────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const arg = (name: string, fallback = '') => {
    const hit = args.find((a) => a.startsWith(`--${name}=`))
    return hit ? hit.slice(name.length + 3) : fallback
  }

  const file = arg('file')
  const version = arg('version', 'v9.7')
  const dryRun = args.includes('--dry-run')

  if (!file) {
    console.error('사용법: npx ts-node src/schedulers/ai/importPredictions.ts --file=<CSV경로> [--version=v9.7] [--dry-run]')
    process.exit(2)
  }

  const full = path.resolve(process.cwd(), file)
  if (!fs.existsSync(full)) {
    console.error(`파일을 찾을 수 없습니다: ${full}`)
    process.exit(2)
  }

  await sequelize.authenticate().catch(() => {
    console.error('DB 연결 실패 — .env 의 DB 설정을 확인하세요.')
    process.exit(2)
  })

  const result = await importPredictionFile(full, version, dryRun)

  console.log('')
  console.log(`[AI 예측 적재] ${path.basename(full)} (모델 ${version}${dryRun ? ', dry-run' : ''})`)

  if (result.errors.length > 0) {
    console.log(`검증 실패 — ${result.errors.length}건. 한 건도 적재하지 않았습니다.`)
    for (const e of result.errors.slice(0, 20)) console.log(`  · ${e}`)
    if (result.errors.length > 20) console.log(`  · ... 외 ${result.errors.length - 20}건`)
    await sequelize.close()
    process.exit(1)
  }

  const cov = result.stats.total > 0 ? (result.stats.recommended / result.stats.total) * 100 : 0
  console.log(`검증 통과: ${result.stats.total.toLocaleString()}행`)
  console.log(`구간별: ${Object.entries(result.stats.byHorizon).map(([h, n]) => `${h} ${n.toLocaleString()}`).join(' / ')}`)
  console.log(`추천: ${result.stats.recommended.toLocaleString()}건 (coverage ${cov.toFixed(1)}%)`)
  console.log(dryRun ? '적재 생략(dry-run)' : '적재 완료')

  await sequelize.close()
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[AI 예측 적재 오류]', err?.message ?? err)
    process.exit(1)
  })
}
