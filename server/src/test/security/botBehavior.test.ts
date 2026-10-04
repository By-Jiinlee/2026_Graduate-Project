/**
 * [보안 검증] 행동 기반 봇 신호 (BOT_BEHAVIOR_MOUSE / BOT_BEHAVIOR_TYPING)
 *
 * riskEngine.collectRiskSignals() 에 다양한 behaviorData 시나리오를 직접 주입해
 *   (1) 자동화 스크립트 유형별 탐지율
 *   (2) 정상 사용자 유형별 오탐률
 * 을 함께 측정한다. HTTP 라운드트립 없이 엔진 함수를 직접 호출하므로 프론트엔드
 * 훅의 실측값 분포와는 별개로, "이 조건식이 주어진 입력에 대해 옳게 판정하는가"만 본다.
 *
 * 범위: 모바일/터치 디바이스는 이번 측정 대상에서 제외한다(useBehaviorTracker 가
 * touch 이벤트를 추적하지 않아 별도 처리가 필요한 사안이며, 이번 학기 범위 밖).
 *
 * 사전 조건: DB 접속 가능해야 함 (collectRiskSignals 가 HONEYPOT_HISTORY 조회를 함).
 * 실행: cd server && npx ts-node src/test/security/botBehavior.test.ts
 */
import sequelize from '../../config/database'
import { collectRiskSignals } from '../../services/auth/riskEngine'

interface Scenario {
  name: string
  behaviorData?: { mouseMoveCount: number; avgTypingInterval: number; timeOnPage: number; keyPressCount?: number }
}

// 테스트 오염 방지 — 기존 허니팟/카나리 이력이 없는 전용 IP 대역 사용
const IP_PREFIX = '203.0.113.'
let ipCounter = 100
function freshIp(): string {
  return IP_PREFIX + ipCounter++
}

// ── 공격 시나리오: 자동화 스크립트가 실제로 만들어낼 법한 behaviorData ──
const ATTACK_SCENARIOS: Scenario[] = [
  {
    name: '순수 HTTP 봇 (프론트 우회, behaviorData 미전송)',
    behaviorData: undefined,
  },
  {
    name: 'Playwright fill() — DOM 값 직접 대입, 키 이벤트 없음',
    behaviorData: { mouseMoveCount: 0, avgTypingInterval: 0, timeOnPage: 800, keyPressCount: 0 },
  },
  {
    name: 'Playwright type(delay:0) — 키 이벤트는 발생하나 초고속',
    behaviorData: { mouseMoveCount: 0, avgTypingInterval: 2, timeOnPage: 600, keyPressCount: 20 },
  },
  {
    name: 'Selenium send_keys — 마우스 소량 이동 + 초고속 타자',
    behaviorData: { mouseMoveCount: 3, avgTypingInterval: 5, timeOnPage: 900, keyPressCount: 20 },
  },
  {
    name: '사람처럼 딜레이를 넣은 회피형 봇',
    behaviorData: { mouseMoveCount: 15, avgTypingInterval: 180, timeOnPage: 4000, keyPressCount: 25 },
  },
]

// ── 정상 사용자 시나리오 ──
const NORMAL_SCENARIOS: Scenario[] = [
  {
    name: '일반 데스크톱 사용자 (마우스+키보드 정상 사용)',
    behaviorData: { mouseMoveCount: 42, avgTypingInterval: 220, timeOnPage: 5000, keyPressCount: 25 },
  },
  {
    // 배제 보조 조건 검증 — 마우스 0 이지만 키 입력이 충분해 키보드 사용자로 보고 MOUSE 억제.
    name: '키보드 전용/접근성 사용자 (Tab 이동, 마우스 미사용)',
    behaviorData: { mouseMoveCount: 0, avgTypingInterval: 190, timeOnPage: 3000, keyPressCount: 30 },
  },
  {
    name: '비밀번호 관리자 자동완성 사용자',
    behaviorData: { mouseMoveCount: 5, avgTypingInterval: 0, timeOnPage: 1200, keyPressCount: 0 },
  },
  {
    name: '빠른 타이피스트',
    behaviorData: { mouseMoveCount: 8, avgTypingInterval: 60, timeOnPage: 2500, keyPressCount: 30 },
  },
  {
    // 배제 보조 조건 검증 — 타자 간격은 빠르지만 키 입력 표본이 적어(자동완성) TYPING 억제.
    name: '단축 입력 사용자 (이메일 자동완성 후 비밀번호만 빠르게 입력)',
    behaviorData: { mouseMoveCount: 2, avgTypingInterval: 45, timeOnPage: 1800, keyPressCount: 2 },
  },
]

async function run(scenarios: Scenario[], label: string) {
  const rows: { name: string; mouse: boolean; typing: boolean; any: boolean }[] = []
  for (const s of scenarios) {
    const { signals } = await collectRiskSignals({
      ip: freshIp(),
      behaviorData: s.behaviorData,
    })
    const mouse = signals.includes('BOT_BEHAVIOR_MOUSE')
    const typing = signals.includes('BOT_BEHAVIOR_TYPING')
    rows.push({ name: s.name, mouse, typing, any: mouse || typing })
  }

  console.log(`\n── ${label} ──`)
  for (const r of rows) {
    const mark = r.any ? '[신호 발생]' : '[신호 없음]'
    console.log(`  ${mark}  MOUSE:${r.mouse ? 'O' : '-'} TYPING:${r.typing ? 'O' : '-'}  ${r.name}`)
  }
  return rows
}

async function main() {
  console.log('[보안 테스트] 행동 기반 봇 신호 (BOT_BEHAVIOR_MOUSE / BOT_BEHAVIOR_TYPING)')

  const attackRows = await run(ATTACK_SCENARIOS, '공격 시나리오')
  const normalRows = await run(NORMAL_SCENARIOS, '정상 사용자 시나리오')

  const detected = attackRows.filter((r) => r.any).length
  const falsePositive = normalRows.filter((r) => r.any).length
  const detectRate = ((detected / attackRows.length) * 100).toFixed(0)
  const fpRate = ((falsePositive / normalRows.length) * 100).toFixed(0)

  console.log('\n' + '='.repeat(64))
  console.log('[보안 테스트] 행동 기반 봇 신호 — 결과')
  console.log(`공격 시나리오 ${attackRows.length}건 중 탐지 ${detected}건 | 탐지율 ${detectRate}%`)
  console.log(`정상 시나리오 ${normalRows.length}건 중 오탐 ${falsePositive}건 | 오탐률 ${fpRate}%`)
  console.log('='.repeat(64))
  console.log(
    '\n※ 순수 HTTP 봇(behaviorData 미전송)과 회피형 봇(딜레이 삽입)은 탐지율 계산에는 "실패"로',
    '\n   집계되지만 원인이 다르다 — 전자는 신호 자체가 없는 커버리지 공백, 후자는 조건식의',
    '\n   임계값을 피해가는 회피다. 논문에는 두 실패를 구분해서 적는 것을 권장한다.',
  )

  await sequelize.close()
}

main().catch(async (e) => {
  console.error('\n실행 실패:', e.message)
  await sequelize.close().catch(() => {})
  process.exit(2)
})
