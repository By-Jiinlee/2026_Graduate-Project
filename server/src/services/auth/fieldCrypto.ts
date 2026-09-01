import crypto from 'crypto'

// ─────────────────────────────────────────────────────────────
// 필드 레벨 암호화 — AES-256-GCM (인증 암호)
//
// 무엇이 문제였나
//   기존 구현은 AES-256-CBC 였다. CBC 는 기밀성만 제공하고 암호문 무결성을 검증하지
//   않는다. 즉 DB 쓰기 권한을 얻은 공격자가 암호문의 특정 비트를 뒤집어 복호 결과를
//   임의로 바꿔도 애플리케이션은 이를 알아채지 못한다(비트 플리핑). 계좌번호처럼
//   구조가 알려진 짧은 평문에서는 원하는 값으로 유도하는 것이 특히 쉽다.
//
// 무엇을 바꿨나
//   1) AES-256-GCM 으로 전환한다. 복호 시 인증 태그를 검증하므로 1비트라도 변조되면
//      복호가 실패한다(fail-closed).
//   2) 추가 인증 데이터(AAD)로 "이 암호문이 어느 테이블·어느 컬럼·어느 사용자의
//      것인지"를 묶는다. 암호문을 다른 컬럼이나 다른 사용자 행으로 옮겨 붙이는
//      재배치(swap) 공격이 태그 검증 단계에서 실패한다. 암호화 자체는 값이 어디에
//      있어야 하는지를 모르므로, 이 결속이 없으면 "유효한 암호문을 엉뚱한 자리에
//      놓는" 조작은 막지 못한다.
//   3) 저장 포맷에 버전을 붙여 기존 CBC 암호문을 그대로 읽을 수 있게 한다(하위호환).
//      마이그레이션 도중에도 서비스가 멈추지 않으며, 재암호화가 끝나면 레거시 경로는
//      더 이상 사용되지 않는다.
//
// 저장 포맷
//   신규(GCM) : v2:<iv-hex(24)>:<tag-hex(32)>:<ciphertext-hex>
//   레거시(CBC): <iv-hex(32)>:<ciphertext-hex>          ← 읽기 전용
//
// IV 는 GCM 권고에 따라 96비트 난수를 쓴다(NIST SP 800-38D 8.2.2). 같은 키로 같은 IV 를
// 재사용하면 GCM 의 인증이 무너지므로, IV 는 레코드마다 새로 생성하며 재사용하지 않는다.
// ─────────────────────────────────────────────────────────────

const VERSION_TAG = 'v2'
const GCM_IV_BYTES = 12
const GCM_TAG_BYTES = 16
const CBC_IV_BYTES = 16

export class FieldDecryptError extends Error {
  constructor(public readonly reason: 'FORMAT' | 'AUTH' | 'KEY', message: string) {
    super(message)
    this.name = 'FieldDecryptError'
  }
}

/**
 * 암호문이 붙을 자리를 식별하는 문맥. AAD 로 묶여 암호문 재배치를 막는다.
 * 값이 하나라도 다르면 복호가 실패하므로, 저장 위치가 바뀌면 반드시 재암호화해야 한다.
 */
export interface FieldContext {
  table: string
  column: string
  ownerId: number | string
}

const aadOf = (ctx: FieldContext): Buffer =>
  Buffer.from(`${ctx.table}:${ctx.column}:${ctx.ownerId}`, 'utf8')

export const getFieldKey = (): Buffer => {
  const key = process.env.KIS_ENCRYPT_KEY
  if (!key) throw new FieldDecryptError('KEY', 'KIS_ENCRYPT_KEY가 설정되지 않았습니다 (.env 확인)')
  const hex = key.trim()
  if (!/^[0-9a-fA-F]{64}$/.test(hex.slice(0, 64)) || hex.length < 64) {
    throw new FieldDecryptError('KEY', 'KIS_ENCRYPT_KEY는 64자리 hex 문자열이어야 합니다')
  }
  return Buffer.from(hex.slice(0, 64), 'hex')
}

/** 평문 → v2 암호문. 같은 평문이라도 매 호출마다 다른 암호문이 나온다(IV 난수). */
export function encryptField(plaintext: string, ctx: FieldContext, key = getFieldKey()): string {
  const iv = crypto.randomBytes(GCM_IV_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aadOf(ctx))
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${VERSION_TAG}:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`
}

/** 저장된 값이 레거시(CBC) 포맷인지 — 마이그레이션 대상 판별용 */
export function isLegacyCiphertext(stored: string): boolean {
  return !stored.startsWith(`${VERSION_TAG}:`)
}

/**
 * 암호문 → 평문. v2 는 태그·AAD 를 검증하고, 레거시 CBC 는 검증 없이 복호한다.
 * 변조·재배치·키 불일치는 모두 예외로 끝난다(fail-closed) — 잘못된 평문을 돌려주지 않는다.
 */
export function decryptField(stored: string, ctx: FieldContext, key = getFieldKey()): string {
  if (!stored || typeof stored !== 'string') {
    throw new FieldDecryptError('FORMAT', '암호문이 비어 있습니다')
  }

  if (isLegacyCiphertext(stored)) {
    const parts = stored.split(':')
    if (parts.length !== 2) throw new FieldDecryptError('FORMAT', '레거시 암호문 형식이 아닙니다')
    const [ivHex, encHex] = parts
    if (ivHex.length !== CBC_IV_BYTES * 2) throw new FieldDecryptError('FORMAT', '레거시 IV 길이 오류')
    try {
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'))
      return Buffer.concat([
        decipher.update(Buffer.from(encHex, 'hex')),
        decipher.final(),
      ]).toString('utf8')
    } catch (err) {
      // CBC 는 인증이 없어 패딩 검사만 통과하면 복호가 "성공"한다. 여기 도달하는 실패는
      // 대부분 키 불일치이며, 변조 탐지 능력이 없다는 사실 자체가 전환 사유다.
      throw new FieldDecryptError('KEY', `레거시 복호 실패: ${(err as Error).message}`)
    }
  }

  const parts = stored.split(':')
  if (parts.length !== 4) throw new FieldDecryptError('FORMAT', 'v2 암호문 형식이 아닙니다')
  const [, ivHex, tagHex, encHex] = parts
  if (ivHex.length !== GCM_IV_BYTES * 2) throw new FieldDecryptError('FORMAT', 'IV 길이 오류')
  if (tagHex.length !== GCM_TAG_BYTES * 2) throw new FieldDecryptError('FORMAT', '인증 태그 길이 오류')

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'))
    decipher.setAAD(aadOf(ctx))
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
    return Buffer.concat([
      decipher.update(Buffer.from(encHex, 'hex')),
      decipher.final(),
    ]).toString('utf8')
  } catch (err) {
    // 태그 불일치 — 암호문 변조, 다른 자리로의 재배치, 키 불일치가 모두 여기로 온다.
    throw new FieldDecryptError('AUTH', `무결성 검증 실패: ${(err as Error).message}`)
  }
}

/**
 * 레거시 암호문을 v2 로 승격한다. 복호가 되지 않으면 예외를 던져
 * 잘못된 값을 덮어쓰지 않는다(마이그레이션 fail-closed).
 */
export function upgradeCiphertext(stored: string, ctx: FieldContext, key = getFieldKey()): string {
  const plain = decryptField(stored, ctx, key)
  const upgraded = encryptField(plain, ctx, key)
  if (decryptField(upgraded, ctx, key) !== plain) {
    throw new FieldDecryptError('AUTH', '재암호화 검증 실패')
  }
  return upgraded
}
