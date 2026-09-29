/**
 * [보안 검증] 봇 행동 신호의 강제 지점 반영 (로그인 1단계 안내 ↔ 2단계 강제 일치)
 *
 * 봇 신호(BOT_BEHAVIOR_MOUSE / TYPING)는 1단계 요청의 behaviorData 로만 판정할 수 있다.
 * 수정 전에는 2단계가 behaviorData 없이 위험 점수를 재계산했고 봇 신호를 기록하지도 않아,
 * 1단계 안내값(requiredAuth)은 지갑 서명인데 2단계 강제는 통과인 조합이 존재했다.
 * 스크립트는 안내값을 무시하고 서명 없이 2단계를 보낼 수 있으므로 그 조합이 곧 우회 경로다.
 *
 *   1) 입력 검증 — 조작·비정상 behaviorData 는 판정·기록하지 않는다
 *   2) 판정 경계 — 500ms / 50ms 임계의 경계값
 *   3) ★ 1단계·2단계 판정 일치 — 수정 전(대조군) 우회 조합 수 vs 수정 후 0
 *   4) 관측 원칙 — 봇 신호만으로는 재인증이 발생하지 않는다
 *
 * anomaly_logs 기록·조회만 메모리 저장소로 대체하고, 판정·기록·재수집은 실제 서비스 코드를 그대로 호출한다.
 * 공유 DB 에 아무것도 쓰지 않으므로 반복 실행해도 다른 검증(e2e)의 위험 점수를 오염시키지 않는다.
 *
 * 실행: cd server && npx ts-node src/test/security/botSignalEnforcement.test.ts
 */
import { Op } from 'sequelize'
import sequelize from '../../config/database'
import AnomalyLog from '../../models/auth/AnomalyLog'
import { recordBotBehavior } from '../../services/auth/anomalyService'
import {
  assessRisk,
  collectRiskSignals,
  decideAuthRequirement,
  detectBotBehavior,
  parseBehaviorData,
  type RiskSignal,
} from '../../services/auth/riskEngine'

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

// ── 메모리 anomaly_logs ─────────────────────────────────────────
interface Row { user_id: number | null; ip: string; anomaly_type: string; action: string; detail: string; created_at: Date }
let store: Row[] = []

function matches(row: Row, where: Record<string, any>): boolean {
  for (const [key, cond] of Object.entries(where)) {
    const v = (row as any)[key]
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      if (Op.in in cond && !(cond[Op.in] as unknown[]).includes(v)) return false
      if (Op.gte in cond && !(v >= cond[Op.gte])) return false
    } else if (v !== cond) return false
  }
  return true
}
const M = AnomalyLog as any
M.create = async (v: any) => {
  store.push({ user_id: v.user_id ?? null, ip: v.ip, anomaly_type: v.anomaly_type, action: v.action, detail: v.detail, created_at: new Date() })
  return v
}
M.findAll = async (opts: any) => store.filter((r) => matches(r, opts.where)).map((r) => ({ anomaly_type: r.anomaly_type }))
M.findOne = async (opts: any) => store.find((r) => matches(r, opts.where)) ?? null

const USER = 9001
const IP = '198.51.100.77'
const BOTS = ['BOT_BEHAVIOR_MOUSE', 'BOT_BEHAVIOR_TYPING']

async function main() {
  console.log('\n[보안 테스트] 봇 행동 신호의 강제 지점 반영')

  // ── 1) 입력 검증 ────────────────────────────────────────────
  const invalid: [string, unknown][] = [
    ['미전송(undefined)', undefined],
    ['null', null],
    ['배열', [0, 0, 800]],
    ['문자열', 'mouseMoveCount=0'],
    ['숫자 대신 문자열', { mouseMoveCount: '0', avgTypingInterval: 2, timeOnPage: 800 }],
    ['NaN', { mouseMoveCount: 0, avgTypingInterval: NaN, timeOnPage: 800 }],
    ['Infinity', { mouseMoveCount: 0, avgTypingInterval: 2, timeOnPage: Infinity }],
    ['음수', { mouseMoveCount: -1, avgTypingInterval: 2, timeOnPage: 800 }],
    ['소수 이동 횟수', { mouseMoveCount: 0.5, avgTypingInterval: 2, timeOnPage: 800 }],
    ['비현실적으로 큰 값', { mouseMoveCount: 0, avgTypingInterval: 2, timeOnPage: 1e12 }],
    ['필드 누락', { mouseMoveCount: 0, timeOnPage: 800 }],
    ['로그 주입 시도', { mouseMoveCount: 0, avgTypingInterval: '2\n[관리자] 정상 사용자', timeOnPage: 800 }],
  ]
  let rejected = 0
  for (const [name, raw] of invalid) {
    const ok = parseBehaviorData(raw) === null
    if (ok) rejected++
    check(`입력 거부: ${name}`, ok)
  }
  check('정상 입력 수용', parseBehaviorData({ mouseMoveCount: 42, avgTypingInterval: 220, timeOnPage: 5000 }) !== null)

  // ── 2) 판정 경계 ────────────────────────────────────────────
  const d = (m: number, t: number, p: number) => detectBotBehavior({ mouseMoveCount: m, avgTypingInterval: t, timeOnPage: p })
  check('체류 500ms 정확히 — MOUSE 아님', !d(0, 0, 500).includes('BOT_BEHAVIOR_MOUSE'))
  check('체류 501ms·이동 0 — MOUSE', d(0, 0, 501).includes('BOT_BEHAVIOR_MOUSE'))
  check('이동 1회 — MOUSE 아님', !d(1, 0, 5000).includes('BOT_BEHAVIOR_MOUSE'))
  check('타자 간격 0(키 입력 없음) — TYPING 아님', !d(5, 0, 1000).includes('BOT_BEHAVIOR_TYPING'))
  check('타자 간격 49.9ms — TYPING', d(5, 49.9, 1000).includes('BOT_BEHAVIOR_TYPING'))
  check('타자 간격 50ms 정확히 — TYPING 아님', !d(5, 50, 1000).includes('BOT_BEHAVIOR_TYPING'))

  // ── 3) ★ 1단계·2단계 판정 일치 ─────────────────────────────────
  // 로그인 시점 맥락 신호(1단계에서 탐지되어 anomaly_logs 에 남는 것들)의 모든 부분집합 × 봇 행동 4종
  const CONTEXT: RiskSignal[] = ['ABNORMAL_TIME', 'CONCURRENT_SESSION', 'ABNORMAL_COUNTRY', 'TRADE_FREQUENCY_SPIKE']
  const BEHAVIORS = [
    { name: '사람', data: { mouseMoveCount: 42, avgTypingInterval: 220, timeOnPage: 5000 } },
    { name: '마우스 없음', data: { mouseMoveCount: 0, avgTypingInterval: 190, timeOnPage: 3000 } },
    { name: '초고속 타자', data: { mouseMoveCount: 3, avgTypingInterval: 5, timeOnPage: 900 } },
    { name: '둘 다', data: { mouseMoveCount: 0, avgTypingInterval: 2, timeOnPage: 600 } },
  ]

  async function run(recordBots: boolean) {
    let total = 0
    let bypass = 0          // 1단계 안내는 WALLET 인데 2단계 강제는 NONE — 서명 없이 통과
    let mismatch = 0        // 판정이 어느 방향으로든 갈린 경우
    const examples: string[] = []
    for (let mask = 0; mask < 1 << CONTEXT.length; mask++) {
      const ctx = CONTEXT.filter((_, i) => mask & (1 << i))
      for (const b of BEHAVIORS) {
        store = []
        total++
        // 1단계: 맥락 신호는 이 시점에 탐지·기록된다(analyzeLoginAttempt 와 같은 흐름)
        for (const t of ctx) store.push({ user_id: USER, ip: IP, anomaly_type: t, action: 'ALERT', detail: '', created_at: new Date() })
        const c1 = await collectRiskSignals({ userId: USER, ip: IP, loginAnomalies: ctx, behaviorData: b.data })
        const r1 = decideAuthRequirement({ isTrustedDevice: true, risk: assessRisk(c1.signals), degraded: c1.degraded }).requirement
        if (recordBots) {
          const m = parseBehaviorData(b.data)!
          const sig = detectBotBehavior(m)
          if (sig.length) await recordBotBehavior({ userId: USER, email: 'test@example.com', ip: IP, signals: sig, metrics: m })
        }
        // 2단계: authController 와 동일하게 behaviorData·loginAnomalies 없이 재수집
        const c2 = await collectRiskSignals({ userId: USER, ip: IP })
        const r2 = decideAuthRequirement({ isTrustedDevice: true, risk: assessRisk(c2.signals), degraded: c2.degraded }).requirement
        if (r1 !== r2) {
          mismatch++
          if (r1 === 'WALLET' && r2 === 'NONE') {
            bypass++
            if (examples.length < 3) examples.push(`[${[...ctx, b.name].join(' + ')}] 1단계 ${r1} / 2단계 ${r2}`)
          }
        }
      }
    }
    return { total, bypass, mismatch, examples }
  }

  const before = await run(false)
  const after = await run(true)
  check('대조군(수정 전)에서 우회 조합이 실제로 존재', before.bypass > 0, `${before.bypass}`)
  check('수정 후 우회 조합 0', after.bypass === 0, `${after.bypass}/${after.total}`)
  check('수정 후 1·2단계 판정 불일치 0', after.mismatch === 0, `${after.mismatch}/${after.total}`)

  // 기록 내용
  store = []
  await recordBotBehavior({ userId: USER, email: 'test@example.com', ip: IP, signals: ['BOT_BEHAVIOR_MOUSE', 'BOT_BEHAVIOR_TYPING'], metrics: { mouseMoveCount: 0, avgTypingInterval: 2, timeOnPage: 600 } })
  check('봇 신호 유형별 1건씩 기록', store.length === 2 && BOTS.every((t) => store.some((r) => r.anomaly_type === t)))
  check('관측 신호라 ALERT 로 기록(차단 아님)', store.every((r) => r.action === 'ALERT'))
  check('기록 문구에 판정 근거 수치 포함', store.some((r) => r.detail.includes('600ms')) && store.some((r) => r.detail.includes('2ms')))

  // ── 4) 관측 원칙 ────────────────────────────────────────────
  const botsOnly = assessRisk(['BOT_BEHAVIOR_MOUSE', 'BOT_BEHAVIOR_TYPING'])
  check('봇 신호 2종 동시 — 20점(상한)', botsOnly.score === 20, `${botsOnly.score}`)
  check('봇 신호만으로는 재인증 없음', decideAuthRequirement({ isTrustedDevice: true, risk: botsOnly }).requirement === 'NONE')

  console.log('\n' + '='.repeat(64))
  console.log('[보안 테스트] 봇 행동 신호의 강제 지점 반영')
  console.log(
    `총 시도: ${after.total}회 | 탐지: ${before.bypass}회 | 차단: ${before.bypass - after.bypass}회 | ` +
      `탐지율: ${before.bypass ? (((before.bypass - after.bypass) / before.bypass) * 100).toFixed(0) : '—'}%`,
  )
  console.log(`- 수정 전(대조군) : 맥락 신호 ${CONTEXT.length}종의 조합 ${1 << CONTEXT.length}가지 × 행동 ${BEHAVIORS.length}종 = ${before.total}조합 중 ` +
    `1단계 WALLET·2단계 NONE(서명 없이 통과) ${before.bypass}조합`)
  for (const e of before.examples) console.log(`                    예) ${e}`)
  console.log(`- 수정 후         : 우회 ${after.bypass}조합 · 1·2단계 판정 불일치 ${after.mismatch}조합`)
  console.log(`- 입력 검증       : 조작·비정상 behaviorData ${rejected}/${invalid.length}종 거부(판정·기록 안 함)`)
  console.log(`- 관측 원칙       : 봇 신호만으로는 최대 ${botsOnly.score}점 → 재인증 없음`)
  console.log('※ \'차단\' = 수정 전 우회 가능했던 조합 중 수정 후 2단계에서 지갑 서명이 강제되는 조합 수')
  console.log('='.repeat(64))

  console.log(`\n검증 항목: ${pass}건 통과 / ${fail}건 실패`)
  if (fail > 0) {
    console.log('\n실패 목록:')
    for (const f of failures) console.log(`  - ${f}`)
  }
  console.log(`판정: ${fail === 0 ? 'PASS' : 'FAIL'}`)
  await sequelize.close()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error('\n실행 실패:', e.message)
  await sequelize.close().catch(() => {})
  process.exit(2)
})
