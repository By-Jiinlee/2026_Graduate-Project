import { QueryTypes } from 'sequelize'
import sequelize from '../../config/database'
import { revokeAllTrustedDevices } from '../../services/auth/trustedDeviceService'
import { arg, die, hasFlag, loginAsTestUser, post } from './testClient'
import { IP } from './testClient'

// ─────────────────────────────────────────────────────────────
// [그림용] AI 추론 조회 응답 3종 비교 — 추천 / 미추천 / 미산출
//
// 동일한 엔드포인트(POST /api/ai/predict)가 종목 분류에 따라 어떻게 다른 응답을 주는지
// 나란히 보여준다. 미추천 응답에 direction·confidence 가 없다는 점이 자산 보호(M1)의 근거.
//
// 실행(서버 AI_ADAPTER=table + 배치 적재 상태에서):
//   npx ts-node src/test/security/responseComparison.demo.ts --email=... --password=...
// ─────────────────────────────────────────────────────────────

const PREDICT = '/api/ai/predict'
const HORIZON = '1d'
const EMAIL = arg('email')
const PASSWORD = arg('password')

async function pickCode(where: string, replacements: Record<string, unknown>): Promise<string> {
  const rows = await sequelize.query<{ ticker: string }>(where, { replacements, type: QueryTypes.SELECT })
  return rows[0]?.ticker ?? ''
}

function box(title: string, code: string, res: { status: number; data: any }): void {
  console.log(`\n── ${title}  (종목 ${code})`)
  console.log(`   요청 : POST /api/ai/predict  { "code": "${code}", "horizon": "1d" }`)
  console.log(`   응답 : HTTP ${res.status}`)
  console.log(`   ${JSON.stringify(res.data)}`)
}

async function main(): Promise<void> {
  if (!EMAIL || !PASSWORD) die('사용법: --email=... --password=...')
  await sequelize.authenticate().catch(() => die('DB 연결 실패'))

  const latest = await sequelize.query<{ d: string }>(
    'SELECT MAX(predict_date) AS d FROM stock_predictions WHERE horizon = :h',
    { replacements: { h: HORIZON }, type: QueryTypes.SELECT },
  )
  const date = latest[0]?.d
  if (!date) die('stock_predictions 에 1d 배치가 없습니다. 배치를 먼저 적재하세요.')

  // 추천 중 경계 종목(확신도가 가장 낮은 추천 = conf_rank 최대)을 골라 확률값이
  // 극단(1.0)이 아닌 현실적인 값으로 보이게 한다.
  const recCode = await pickCode(
    'SELECT ticker FROM stock_predictions WHERE predict_date=:d AND horizon=:h AND recommended=1 ORDER BY conf_rank DESC LIMIT 1',
    { d: date, h: HORIZON },
  )
  const notRecCode = await pickCode(
    'SELECT ticker FROM stock_predictions WHERE predict_date=:d AND horizon=:h AND recommended=0 ORDER BY conf_rank ASC LIMIT 1',
    { d: date, h: HORIZON },
  )
  const excludedCode = await pickCode(
    `SELECT s.code AS ticker FROM stocks s
      WHERE s.is_active=1 AND s.is_ml_target=1 AND s.code REGEXP '^[0-9]{6}$'
        AND s.code NOT IN (SELECT ticker FROM stock_predictions WHERE predict_date=:d AND horizon=:h)
      ORDER BY s.code LIMIT 1`,
    { d: date, h: HORIZON },
  )

  const { cookie, userId } = await loginAsTestUser(EMAIL, PASSWORD, false)

  console.log('==================================================================')
  console.log(' AI 추론 조회 응답 3종 비교 (동일 엔드포인트, 종목 분류별)')
  console.log(` 배치 기준일 ${date}`)
  console.log('==================================================================')

  box('① 추천 종목 — 방향·양자화 확률 노출', recCode,
    await post(PREDICT, JSON.stringify({ code: recCode, horizon: HORIZON }), { ip: IP.NORMAL, cookie }))
  box('② 미추천 종목 — 방향·확신도 비노출(자산 보호)', notRecCode,
    await post(PREDICT, JSON.stringify({ code: notRecCode, horizon: HORIZON }), { ip: IP.NORMAL, cookie }))
  box('③ 미산출 종목 — 예측 대상 아님(404)', excludedCode,
    await post(PREDICT, JSON.stringify({ code: excludedCode, horizon: HORIZON }), { ip: IP.NORMAL, cookie }))

  console.log('\n※ ②에는 direction·confidence 필드가 없다 → 조회 반복으로 그날 순위표를 복원할 수 없음.')

  if (!hasFlag('keep-device')) await revokeAllTrustedDevices(userId)
  await sequelize.close()
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1) })
