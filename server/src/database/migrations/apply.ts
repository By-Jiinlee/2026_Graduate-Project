import fs from 'fs'
import path from 'path'
import sequelize from '../../config/database'

// ─────────────────────────────────────────────────────────────
// 마이그레이션 SQL 적용기 (mysql CLI 없이 .env 설정 그대로 사용)
// 실행: cd server && npx ts-node src/database/migrations/apply.ts 20260730_anomaly_type_hmac.sql
// ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const file = process.argv[2]
  if (!file) {
    console.error('사용법: npx ts-node src/database/migrations/apply.ts <파일명.sql>')
    process.exit(2)
  }

  const full = path.resolve(__dirname, file)
  if (!fs.existsSync(full)) {
    console.error(`파일을 찾을 수 없습니다: ${full}`)
    process.exit(2)
  }

  // 주석 제거 후 세미콜론 단위로 분리 — 단순 DDL 스크립트 전용(문자열 리터럴 내 ; 은 가정하지 않음)
  const statements = fs
    .readFileSync(full, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)

  await sequelize.authenticate()
  for (const [i, sql] of statements.entries()) {
    await sequelize.query(sql)
    console.log(`  [${i + 1}/${statements.length}] 적용 완료: ${sql.split('\n')[0].slice(0, 60)}...`)
  }
  await sequelize.close()
  console.log(`마이그레이션 적용 완료: ${file}`)
}

main().catch((err) => {
  console.error('마이그레이션 실패:', err?.message ?? err)
  process.exit(1)
})
