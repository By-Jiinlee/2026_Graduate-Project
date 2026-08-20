import sequelize from '../../config/database'
import { QueryTypes } from 'sequelize'
import {
  decryptField,
  isLegacyCiphertext,
  upgradeCiphertext,
  type FieldContext,
} from '../../services/auth/fieldCrypto'

// ─────────────────────────────────────────────────────────────
// real_accounts 민감 컬럼 재암호화 — AES-256-CBC(레거시) → AES-256-GCM(v2)
//
// fieldCrypto 가 레거시 포맷을 읽을 수 있으므로 이 작업 없이도 서비스는 동작한다.
// 다만 레거시 행은 무결성 검증을 받지 못하므로, 전환을 완료해야 방어가 실제로 적용된다.
//
// 안전 장치
//   · 기본은 점검 전용(dry-run)이다. 실제 쓰기는 --apply 를 줘야 한다.
//   · 행 단위로 세 컬럼을 모두 복호·재암호화·재복호 검증한 뒤에만 UPDATE 한다.
//     하나라도 실패하면 그 행은 건드리지 않는다(부분 갱신 금지).
//   · 이미 v2 인 값은 건너뛴다(재실행 안전).
//
// 실행
//   점검 : npx ts-node src/database/migrations/reencryptRealAccounts.ts
//   적용 : npx ts-node src/database/migrations/reencryptRealAccounts.ts --apply
// ─────────────────────────────────────────────────────────────

const APPLY = process.argv.includes('--apply')
const TABLE = 'real_accounts'
const COLUMNS = ['app_key', 'app_secret', 'cano'] as const
type Column = (typeof COLUMNS)[number]

interface Row {
  id: number
  user_id: number
  app_key: string
  app_secret: string
  cano: string
}

const ctxOf = (userId: number, column: Column): FieldContext => ({
  table: TABLE,
  column,
  ownerId: userId,
})

async function main(): Promise<void> {
  await sequelize.authenticate()

  const rows = await sequelize.query<Row>(
    `SELECT id, user_id, app_key, app_secret, cano FROM ${TABLE}`,
    { type: QueryTypes.SELECT },
  )
  console.log(`대상 행 ${rows.length}건 · 모드: ${APPLY ? '적용(--apply)' : '점검 전용(dry-run)'}`)

  let upgraded = 0
  let skipped = 0
  let failed = 0

  for (const row of rows) {
    const next: Partial<Record<Column, string>> = {}
    const legacyCols: Column[] = []
    let rowFailed = false

    for (const col of COLUMNS) {
      const stored = row[col]
      if (!stored) continue
      if (!isLegacyCiphertext(stored)) {
        // 이미 v2 — 읽히는지만 확인한다
        try { decryptField(stored, ctxOf(row.user_id, col)) }
        catch (err) {
          rowFailed = true
          console.error(`  [실패] id=${row.id} ${col}: v2 복호 불가 — ${(err as Error).message}`)
        }
        continue
      }
      legacyCols.push(col)
      try {
        next[col] = upgradeCiphertext(stored, ctxOf(row.user_id, col))
      } catch (err) {
        rowFailed = true
        console.error(`  [실패] id=${row.id} ${col}: 승격 불가 — ${(err as Error).message}`)
      }
    }

    if (rowFailed) { failed++; continue }
    if (legacyCols.length === 0) { skipped++; continue }

    console.log(`  id=${row.id} user_id=${row.user_id} · 승격 대상 [${legacyCols.join(', ')}]`)

    if (APPLY) {
      const sets = legacyCols.map((c) => `${c} = :${c}`).join(', ')
      await sequelize.query(`UPDATE ${TABLE} SET ${sets} WHERE id = :id`, {
        replacements: { ...next, id: row.id },
        type: QueryTypes.UPDATE,
      })

      // 쓰기 후 재검증 — 저장된 값이 실제로 복호되는지 DB 에서 다시 읽어 확인한다
      const [after] = await sequelize.query<Row>(
        `SELECT id, user_id, app_key, app_secret, cano FROM ${TABLE} WHERE id = :id`,
        { replacements: { id: row.id }, type: QueryTypes.SELECT },
      )
      for (const col of legacyCols) {
        decryptField(after[col], ctxOf(after.user_id, col))
      }
    }
    upgraded++
  }

  console.log('')
  console.log(`승격 ${APPLY ? '완료' : '예정'}: ${upgraded}건 · 이미 v2: ${skipped}건 · 실패: ${failed}건`)
  if (!APPLY && upgraded > 0) console.log('실제 적용하려면 --apply 를 붙여 다시 실행하세요.')
  if (failed > 0) process.exitCode = 1

  await sequelize.close()
}

main().catch(async (err) => {
  console.error('마이그레이션 실패:', err?.message ?? err)
  await sequelize.close().catch(() => undefined)
  process.exit(1)
})
