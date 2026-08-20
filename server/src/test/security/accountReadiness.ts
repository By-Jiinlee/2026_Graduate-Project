import sequelize from '../../config/database'
import { QueryTypes } from 'sequelize'

// ─────────────────────────────────────────────────────────────
// E2E 실행 전 계정 상태 점검기 — 어떤 계정이 거래 E2E 를 돌릴 수 있는 상태인지 본다.
// 비밀번호·PIN 은 해시라 표시하지 않고 "설정 여부"만 확인한다.
// 실행: cd server && npx ts-node src/test/security/accountReadiness.ts
// ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await sequelize.authenticate()

  const cols = await sequelize.query<{ TABLE_NAME: string; COLUMN_NAME: string }>(
    `SELECT table_name AS TABLE_NAME, column_name AS COLUMN_NAME
       FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name IN ('users', 'virtual_accounts', 'wallets')
      ORDER BY table_name, ordinal_position`,
    { type: QueryTypes.SELECT },
  )
  const byTable = new Map<string, string[]>()
  for (const c of cols) {
    if (!byTable.has(c.TABLE_NAME)) byTable.set(c.TABLE_NAME, [])
    byTable.get(c.TABLE_NAME)!.push(c.COLUMN_NAME)
  }
  for (const [t, list] of byTable) console.log(`[${t}] ${list.join(', ')}`)
  console.log('')

  const rows = await sequelize.query<Record<string, unknown>>(
    `SELECT u.id, u.email, u.is_phone_verified, u.is_locked, u.role,
            (w.address IS NOT NULL) AS has_wallet,
            (va.id IS NOT NULL)     AS has_account,
            (u.pin_hash IS NOT NULL AND u.pin_hash <> '') AS has_pin,
            va.seed_balance,
            (SELECT COUNT(*) FROM virtual_orders o WHERE o.user_id = u.id) AS orders
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
       LEFT JOIN virtual_accounts va ON va.user_id = u.id
      ORDER BY u.id`,
    { type: QueryTypes.SELECT },
  )

  console.log('id  | email                          | 폰인증 | 지갑 | 계좌 | PIN | 잔고        | 주문')
  for (const r of rows) {
    const yn = (v: unknown) => (Number(v) === 1 ? ' O  ' : ' -  ')
    console.log(
      `${String(r.id).padEnd(3)} | ${String(r.email).padEnd(30)} |  ${yn(r.is_phone_verified)}  |` +
      `${yn(r.has_wallet)}|${yn(r.has_account)}|${yn(r.has_pin)}| ` +
      `${String(r.seed_balance ?? '-').padStart(11)} | ${String(r.orders)}`,
    )
  }

  await sequelize.close()
}

main().catch((err) => {
  console.error('점검 실패:', err?.message ?? err)
  process.exit(1)
})
