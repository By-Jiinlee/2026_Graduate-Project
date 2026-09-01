import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import sequelize from '../../config/database'
import { QueryTypes } from 'sequelize'

// ─────────────────────────────────────────────────────────────
// [AI 추론 E2E 준비] 실제 ml_target 종목으로 배치 예측 CSV 생성 (predict_v97 스펙)
//
// 팀 AI 의 실제 예측 CSV 를 받기 전, aiInference.e2e.test.ts 를 돌리기 위한 배치 데이터를
// 만든다. 확률은 종목코드 해시로 결정적으로 배정하고, 일부 종목은 의도적으로 배치에서
// 제외해 NOT_PREDICTED(404) 경로를 검증하게 한다. 팀 예측 CSV 가 오면 이 스크립트 대신
// 그 CSV 를 importPredictions.ts 로 적재하면 된다(스키마 동일).
//
// 사용: npx ts-node src/test/security/generateTestBatch.ts <출력경로> <포함종목수> <제외종목수> <coverage>
//       → importPredictions.ts --file=<출력경로> --version=e2e-test 로 적재
//       → 생성된 <출력경로>_meta.json 을 aiInference.e2e.test.ts --batch-meta 로 전달
// ─────────────────────────────────────────────────────────────
const OUT = process.argv[2] ?? 'batch_e2e.csv'
const N_IN = Number(process.argv[3] ?? 50)
const N_EXCLUDE = Number(process.argv[4] ?? 10)
const COVERAGE = Number(process.argv[5] ?? 0.3)
// 기준일은 실행 시점(KST)으로 잡는다. 날짜를 고정해 두면 논문 캡처에 오래된 예측이
// 현재 예측처럼 찍히고, 어댑터의 "최신 배치 고정"이 실제로 동작하는지도 확인할 수 없다.
// 필요하면 6번째 인자로 override 한다.
const DATE = process.argv[6] ??
  new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
const HORIZON = 'label_1d'

function detHash(code: string): number {
  const d = crypto.createHmac('sha256', 'uptick-e2e-batch').update(code).digest()
  return d.readUInt32BE(0) / 0xffffffff
}

async function main(): Promise<void> {
  const rows = await sequelize.query<{ code: string }>(
    "SELECT code FROM stocks WHERE is_active = 1 AND is_ml_target = 1 AND code REGEXP '^[0-9]{6}$' ORDER BY code LIMIT :lim",
    { replacements: { lim: N_IN + N_EXCLUDE }, type: QueryTypes.SELECT },
  )
  const all = rows.map((r) => r.code)
  const included = all.slice(0, N_IN)
  const excluded = all.slice(N_IN, N_IN + N_EXCLUDE)

  // prob 배정 → confidence → 순위 → 추천(상위 coverage)
  const scored = included.map((code) => {
    const prob = detHash(code)
    return { code, prob, confidence: Math.abs(prob - 0.5) }
  })
  scored.sort((a, b) => b.confidence - a.confidence)
  const k = Math.max(1, Math.round(scored.length * COVERAGE))

  const lines = ['date,ticker,horizon,prob,confidence,direction,recommended,conf_rank']
  scored.forEach((s, i) => {
    const direction = s.prob >= 0.5 ? '상승' : '하락'
    const recommended = i < k ? 1 : 0
    lines.push(`${DATE},${s.code},${HORIZON},${s.prob.toFixed(4)},${s.confidence.toFixed(4)},${direction},${recommended},${i + 1}`)
  })

  const outPath = path.resolve(process.cwd(), OUT)
  fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8')

  // 테스트가 참조할 종목 분류를 함께 출력 (recommended/not/excluded 대표 종목)
  const recommendedCodes = scored.slice(0, k).map((s) => s.code)
  const notRecommendedCodes = scored.slice(k).map((s) => s.code)
  fs.writeFileSync(
    path.resolve(process.cwd(), OUT.replace(/\.csv$/, '') + '_meta.json'),
    JSON.stringify({ date: DATE, recommendedCodes, notRecommendedCodes, excludedCodes: excluded }, null, 2),
    'utf8',
  )

  console.log(JSON.stringify({
    included: included.length, excluded: excluded.length, recommended: k,
    sampleRecommended: recommendedCodes[0], sampleNotRecommended: notRecommendedCodes[0], sampleExcluded: excluded[0],
    out: outPath,
  }))
  await sequelize.close()
}
main().catch((e) => { console.error(e?.message ?? e); process.exit(1) })
