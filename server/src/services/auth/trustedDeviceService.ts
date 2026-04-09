import crypto from 'crypto'
import { Op, WhereOperators, WhereOptions } from 'sequelize'
import TrustedDevice, { DeviceType } from '../../models/auth/TrustedDevice'
import LoginRecord from '../../models/auth/LoginRecord'

// ─────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────
export const DEVICE_COOKIE_NAME = 'deviceToken'
const TRUSTED_DAYS = 30

// ─────────────────────────────────────────────
// 내부 유틸
// ─────────────────────────────────────────────

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function buildFingerprint(userAgent: string, ip: string): string {
  // [개발] IP 제외 (로컬 환경에서 ::1/127.0.0.1 혼용으로 불일치 발생)
  return crypto.createHash('sha256').update(userAgent).digest('hex')
  // [배포시 교체] IP 포함 핑거프린트
  // return crypto.createHash('sha256').update(`${userAgent}||${ip}`).digest('hex')
}

function detectDeviceType(userAgent: string): DeviceType {
  return /Mobile|Android|iPhone|iPad/i.test(userAgent) ? 'mobile' : 'pc'
}

function buildLabel(userAgent: string): string {
  const browser = /Edg\//i.test(userAgent)
    ? 'Edge'
    : /Chrome/i.test(userAgent)
    ? 'Chrome'
    : /Firefox/i.test(userAgent)
    ? 'Firefox'
    : /Safari/i.test(userAgent)
    ? 'Safari'
    : '기타'

  const os = /iPhone|iPad/i.test(userAgent)
    ? 'iOS'
    : /Android/i.test(userAgent)
    ? 'Android'
    : /Windows/i.test(userAgent)
    ? 'Windows'
    : /Mac/i.test(userAgent)
    ? 'Mac'
    : /Linux/i.test(userAgent)
    ? 'Linux'
    : '기타'

  return `${browser} · ${os}`
}

// ─────────────────────────────────────────────
// 신뢰 기기 검증
// loginStep1에서 호출 → true면 Step2 지갑 서명 스킵
// ─────────────────────────────────────────────
export async function verifyTrustedDevice(
  userId: number,
  rawToken: string,
  userAgent: string,
  ip: string,
): Promise<boolean> {
  if (!rawToken) return false

  const hashedToken = hashToken(rawToken)
  const fingerprint = buildFingerprint(userAgent, ip)

  const device = await TrustedDevice.findOne({
    where: {
      user_id: userId,
      device_token: hashedToken,
      expires_at: { [Op.gt]: new Date() },
    },
  })

  if (!device) return false

  // 핑거프린트 불일치 → 쿠키 탈취 가능성, 즉시 삭제
  if (device.device_fingerprint !== fingerprint) {
    await device.destroy()
    return false
  }

  await device.update({ last_used_at: new Date(), ip })
  return true
}

// ─────────────────────────────────────────────
// 신뢰 기기 등록
// loginStep2 성공 후 rememberDevice=true일 때 호출
// 동일 device_type이 있으면 upsert로 덮어씀 (PC/모바일 각 1대 유지)
// ─────────────────────────────────────────────
export async function registerTrustedDevice(
  userId: number,
  userAgent: string,
  ip: string,
): Promise<string> {
  const deviceType = detectDeviceType(userAgent)
  const rawToken = crypto.randomBytes(32).toString('hex')
  const hashedToken = hashToken(rawToken)
  const fingerprint = buildFingerprint(userAgent, ip)
  const expiresAt = new Date(Date.now() + TRUSTED_DAYS * 24 * 60 * 60 * 1000)

  await TrustedDevice.upsert({
    user_id: userId,
    device_type: deviceType,
    device_token: hashedToken,
    device_fingerprint: fingerprint,
    user_agent: userAgent,
    ip,
    label: buildLabel(userAgent),
    last_used_at: new Date(),
    expires_at: expiresAt,
    created_at: new Date(),
  })

  return rawToken
}

// ─────────────────────────────────────────────
// 기기 목록 조회 (마이페이지)
// ─────────────────────────────────────────────
export async function getTrustedDevices(userId: number) {
  return TrustedDevice.findAll({
    where: {
      user_id: userId,
      expires_at: { [Op.gt]: new Date() },
    },
    attributes: ['id', 'device_type', 'label', 'ip', 'last_used_at', 'expires_at'],
    order: [['last_used_at', 'DESC']],
  })
}

// ─────────────────────────────────────────────
// 특정 기기 신뢰 해제 (마이페이지)
// ─────────────────────────────────────────────
export async function revokeTrustedDevice(userId: number, deviceId: number): Promise<void> {
  await TrustedDevice.destroy({ where: { id: deviceId, user_id: userId } })
}

// ─────────────────────────────────────────────
// 전체 기기 해제 (탈퇴 시)
// ─────────────────────────────────────────────
export async function revokeAllTrustedDevices(userId: number): Promise<void> {
  await TrustedDevice.destroy({ where: { user_id: userId } })
}
