import { revokeAllTrustedDevices } from '../../services/auth/trustedDeviceService'
import { arg, die, hasFlag, loginAsTestUser } from './testClient'
import axios from 'axios'
import { UA, IP } from './testClient'

// ─────────────────────────────────────────────────────────────
// [그림 6-3용] 관리자 대시보드 데이터 캡처
//
// 관리자 계정으로 실제 로그인(신뢰 기기 우회 — MetaMask 불필요)한 뒤, AdminDashboard.tsx
// 가 호출하는 관리자 보안 엔드포인트를 그대로 호출해 응답(대시보드에 렌더링되는 데이터)을
// 출력한다. 이로써 "인증된 관리자 API 경로가 실제로 동작하고 통계가 채워짐"을 보인다.
//
// 실행(서버 실행 상태에서):
//   npx ts-node src/test/security/adminDashboardCapture.ts --email=관리자 --password=...
// ─────────────────────────────────────────────────────────────

const BASE = arg('url', 'http://localhost:3000').replace(/\/$/, '')
const EMAIL = arg('email')
const PASSWORD = arg('password')

async function getJson(path: string, cookie: string): Promise<{ status: number; data: any }> {
  const res = await axios.get(`${BASE}${path}`, {
    headers: { Cookie: cookie, 'User-Agent': UA, 'X-Forwarded-For': IP.LOGIN },
    validateStatus: () => true,
  } as any)
  return { status: res.status, data: res.data }
}

function line(): void { console.log('─'.repeat(67)) }

async function main(): Promise<void> {
  if (!EMAIL || !PASSWORD) die('사용법: --email=관리자이메일 --password=...')

  const { cookie, userId } = await loginAsTestUser(EMAIL, PASSWORD, false)

  console.log('====================================================================')
  console.log(' [그림 6-6] 관리자 대시보드 데이터 (인증된 관리자 API 응답)')
  console.log(` 관리자 userId=${userId} 로 로그인 성공 → 관리자 보안 API 호출`)
  console.log('====================================================================')

  const stats = await getJson('/api/admin/security/stats', cookie)
  if (stats.status !== 200) die(`stats 조회 실패(${stats.status}) — 관리자 권한 확인. ${JSON.stringify(stats.data)}`)

  line()
  console.log('[상단 통계 카드]  GET /api/admin/security/stats')
  const s = stats.data
  console.log(`  전체 이상탐지 ${s.total} · 오늘 ${s.today} · 허니팟 ${s.honeypotHits} · ` +
    `요청 무결성 위반 ${s.integrityViolations} · 거래 이상탐지 ${s.tradeAnomalies}(주문 거절 ${s.tradeBlocked}) · ` +
    `잠긴 계정 ${s.locked} · 차단 IP ${s.blockedIPs}`)

  line()
  console.log('[유형별 탐지]  GET /api/admin/security/chart/by-type')
  const byType = (await getJson('/api/admin/security/chart/by-type', cookie)).data
  for (const r of byType) console.log(`  ${r.anomaly_type} : ${r.count}건`)

  line()
  console.log('[AI 추론 감사 로그]  GET /api/admin/security/inference-logs')
  const inf = (await getJson('/api/admin/security/inference-logs', cookie)).data
  console.log(`  요약: 24시간 허용 ${inf.summary?.allowed24h} / 차단 ${inf.summary?.denied24h}`)
  console.log(`  차단 사유별: ${(inf.summary?.denyByReason ?? []).map((r: any) => `${r.deny_reason ?? 'null'} ${r.count}`).join(' · ')}`)
  console.log('  최근 로그(최대 8건):')
  for (const l of (inf.logs ?? []).slice(0, 8)) {
    const t = new Date(l.created_at).toLocaleTimeString('ko-KR')
    console.log(`    ${t} · u${l.user_id ?? '-'} · ${l.ip} · ${l.stock_code ?? '-'} ${l.horizon ?? ''} · ` +
      `${l.decision}${l.deny_reason ? '/' + l.deny_reason : ''}${l.latency_ms != null ? ' · ' + l.latency_ms + 'ms' : ''}`)
  }

  line()
  console.log('[이상탐지 로그]  GET /api/admin/security/anomaly-logs?limit=6')
  const anom = (await getJson('/api/admin/security/anomaly-logs?limit=6', cookie)).data
  console.log(`  총 ${anom.total}건, 최근 6건:`)
  for (const a of (anom.logs ?? []).slice(0, 6)) {
    const t = new Date(a.created_at).toLocaleTimeString('ko-KR')
    console.log(`    ${t} · ${a.anomaly_type}/${a.action} · ${a.ip} · ${a.detail?.slice(0, 48) ?? ''}`)
  }
  line()

  if (!hasFlag('keep-device')) await revokeAllTrustedDevices(userId)
  process.exit(0)
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1) })
