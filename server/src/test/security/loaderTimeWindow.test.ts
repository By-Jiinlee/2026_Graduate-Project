import sequelize from '../../config/database'
import {
  loadCancelPattern,
  loadDailyTotals,
  loadOrderIntervals,
  loadSameIpOrders,
  loadSelfChurn,
} from '../../services/auth/tradeAnomalyService'

// ─────────────────────────────────────────────────────────────
// [보안 검증] 거래 이상탐지 조회 창의 시간대 일관성 (M-6·M-7·S10~S12)
//
// 배경: raw 쿼리(sequelize.query)의 replacements 에 JS Date 를 넣으면 Node 로컬 시각 문자열로
//   직렬화된다. ordered_at·NOW() 는 DB(UTC) 기준이므로 서버가 KST 로 돌면 창 하한이 9시간 뒤(미래)로
//   밀린다. 실측: 같은 데이터에서 3시간 창 조회가 DB 측 계산 7건 / JS Date 0건.
//     - M-7 동일 IP 다계정(10분 창) : 창 전체가 미래 → 항상 미탐
//     - M-6 빈도·S2 누적(24시간 창) : 최근 24시간이 15시간으로 축소, 베이스라인 경계도 이동
//   모델 조회(findAll where)는 Sequelize timezone(+00:00)으로 직렬화되어 영향이 없다.
//
// 확인하려는 것
//   (1) 창을 쓰는 raw 로더 5종이 Date 파라미터를 하나도 넘기지 않는다
//   (2) 모든 창 경계가 DB 측 계산(NOW() - INTERVAL n SECOND)이다
//   (3) 창 길이(초)가 정책값과 일치한다
//   (4) --live: 실제 DB 에서 JS Date 하한과 DB 측 하한의 조회 건수를 비교한다(읽기 전용)
//
// 실행: cd server && npx ts-node src/test/security/loaderTimeWindow.test.ts [--live]
// ─────────────────────────────────────────────────────────────

let pass = 0
let fail = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass++
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`) }
}

type Call = { sql: string; replacements: Record<string, unknown> }
const calls: Call[] = []
const realQuery = sequelize.query.bind(sequelize)

function capture(): void {
  ;(sequelize as any).query = async (sql: string, opts: any) => {
    calls.push({ sql, replacements: opts?.replacements ?? {} })
    return []
  }
}
function restore(): void {
  ;(sequelize as any).query = realQuery
}

const LOADERS: Array<{ name: string; run: () => Promise<unknown>; windows: number[] }> = [
  { name: 'M-6/S2 loadDailyTotals', run: () => loadDailyTotals(1, 'virtual'), windows: [90 * 86400, 86400] },
  { name: 'M-7 loadSameIpOrders', run: () => loadSameIpOrders('virtual', '203.0.113.7', '005930'), windows: [600] },
  { name: 'S10 loadCancelPattern', run: () => loadCancelPattern(1, 'virtual'), windows: [3600] },
  { name: 'S11 loadSelfChurn', run: () => loadSelfChurn(1, 'virtual', '005930'), windows: [600] },
  { name: 'S12 loadOrderIntervals', run: () => loadOrderIntervals(1, 'virtual'), windows: [3600] },
]

async function offline(): Promise<{ loaders: number; clean: number }> {
  let clean = 0
  for (const l of LOADERS) {
    calls.length = 0
    capture()
    try { await l.run() } finally { restore() }

    check(`${l.name}: 쿼리 실행됨`, calls.length > 0, `${calls.length}건`)
    const dates = calls.flatMap((c) =>
      Object.entries(c.replacements).filter(([, v]) => v instanceof Date).map(([k]) => k),
    )
    check(`${l.name}: Date 파라미터 없음`, dates.length === 0, dates.join(','))

    // ordered_at 비교가 모두 DB 측 계산이어야 한다 — :param 형태의 시각 비교가 남아 있으면 안 된다.
    const rawBound = calls.some((c) => /ordered_at\s*[<>]=?\s*:(?!\w*Sec\b)\w+/.test(c.sql))
    check(`${l.name}: ordered_at 경계에 시각 파라미터 없음`, !rawBound)
    const usesNow = calls.every((c) => /NOW\(\)\s*-\s*INTERVAL\s*:\w+\s*SECOND/.test(c.sql))
    check(`${l.name}: 경계 = NOW() - INTERVAL n SECOND`, usesNow)

    const secs = calls
      .flatMap((c) => Object.entries(c.replacements).filter(([k]) => /Sec$/.test(k)).map(([, v]) => Number(v)))
      .sort((a, b) => b - a)
    const want = [...l.windows].sort((a, b) => b - a)
    check(`${l.name}: 창 길이 = 정책값(${want.join('/')}초)`, JSON.stringify([...new Set(secs)]) === JSON.stringify(want), secs.join('/'))

    if (dates.length === 0 && !rawBound && usesNow) clean++
  }
  return { loaders: LOADERS.length, clean }
}

async function live(): Promise<void> {
  const offsetMin = new Date().getTimezoneOffset()
  console.log(`\n[실측] Node 시간대 오프셋 ${-offsetMin / 60}h (KST=+9, UTC=0)`)
  for (const [label, sec] of [['10분', 600], ['3시간', 10800], ['24시간', 86400]] as const) {
    const since = new Date(Date.now() - sec * 1000)
    const legacy: any = await realQuery('SELECT COUNT(*) n FROM virtual_orders WHERE ordered_at >= :since', { replacements: { since }, plain: true } as any)
    const fixed: any = await realQuery('SELECT COUNT(*) n FROM virtual_orders WHERE ordered_at >= (NOW() - INTERVAL :sec SECOND)', { replacements: { sec }, plain: true } as any)
    console.log(`  ${label} 창: 수정 전(JS Date) ${legacy.n}건 / 수정 후(DB 계산) ${fixed.n}건`)
    if (offsetMin !== 0) check(`실측 ${label}: 수정 후 ≥ 수정 전`, Number(fixed.n) >= Number(legacy.n))
  }
  const bound: any = await realQuery('SELECT :d AS bound, NOW() AS db_now', { replacements: { d: new Date() }, plain: true } as any)
  console.log(`  같은 순간의 직렬화: JS Date → '${bound.bound}', DB NOW() → ${new Date(bound.db_now).toISOString()}`)
}

async function main(): Promise<void> {
  const { loaders, clean } = await offline()
  if (process.argv.includes('--live')) await live()

  console.log('\n[보안 테스트] 거래 이상탐지 조회 창의 시간대 일관성')
  console.log(`총 시도: ${loaders}회 | 탐지: ${clean}회 | 차단: — | 탐지율: ${((clean / loaders) * 100).toFixed(0)}% (DB 측 경계로 고정된 로더 비율)`)
  console.log('- 대상 로더        : M-6/S2 일별·24h 누적, M-7 동일 IP 다계정, S10 허수주문, S11 자전거래, S12 주문 간격')
  console.log('- 수정 전 영향     : KST 서버에서 하한 +9h — M-7(10분) 항상 미탐, 24h 창 → 15h')

  console.log(`\n검증 항목: ${pass}건 통과 / ${fail}건 실패`)
  if (fail > 0) {
    console.log('\n실패 목록:')
    for (const f of failures) console.log(`  · ${f}`)
  }
  console.log(`판정: ${fail === 0 ? 'PASS' : 'FAIL'}`)
  await sequelize.close().catch(() => undefined)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error('실행 실패:', e); process.exit(2) })
