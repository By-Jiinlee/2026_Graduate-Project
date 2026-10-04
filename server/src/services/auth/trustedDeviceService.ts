import crypto from 'crypto'
import { Op, WhereOperators, WhereOptions } from 'sequelize'
import TrustedDevice, { DeviceType } from '../../models/auth/TrustedDevice'
import LoginRecord from '../../models/auth/LoginRecord'
import { sendNewDeviceAlert, sendDeviceRegisteredAlert, sendDeviceRevokedAlert } from './emailService'
import User from '../../models/user/User'

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

// 클라이언트가 보낸 하드웨어 컴포넌트 조합 해시(캔버스·WebGL·오디오·폰트·타임존)를
// 서버에서 한 번 더 해시해 길이·형식(64자 hex)을 고정한다. 값이 없으면 null.
function buildComponentFingerprint(componentsHash?: string | null): string | null {
  if (!componentsHash || typeof componentsHash !== 'string') return null
  return crypto.createHash('sha256').update(componentsHash).digest('hex')
}

function detectDeviceType(userAgent: string): DeviceType {
  return /Mobile|Android|iPhone|iPad/i.test(userAgent) ? 'mobile' : 'pc'
}

export function buildLabel(userAgent: string): string {
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
export interface TrustedDeviceCheck {
  trusted: boolean
  /**
   * 하드웨어 컴포넌트 지문이 저장값과 달라졌는가. 신뢰 자체는 유지한다 —
   * GPU 드라이버 업데이트·브라우저 업그레이드 등으로 1~2개 컴포넌트가 바뀌는 일은 흔하므로
   * 불일치를 신뢰 파기(삭제) 트리거로 쓰지 않고 관측 위험 신호로만 올린다.
   */
  componentMismatch: boolean
}

export async function verifyTrustedDevice(
  userId: number,
  rawToken: string,
  userAgent: string,
  ip: string,
  componentsHash?: string | null,
): Promise<TrustedDeviceCheck> {
  if (!rawToken) return { trusted: false, componentMismatch: false }

  const hashedToken = hashToken(rawToken)
  const fingerprint = buildFingerprint(userAgent, ip)

  const device = await TrustedDevice.findOne({
    where: {
      user_id: userId,
      device_token: hashedToken,
      expires_at: { [Op.gt]: new Date() },
    },
  })

  if (!device) return { trusted: false, componentMismatch: false }

  // UA 핑거프린트 불일치 → 쿠키 탈취 가능성, 즉시 삭제(기존 정책 유지)
  if (device.device_fingerprint !== fingerprint) {
    await device.destroy()
    return { trusted: false, componentMismatch: false }
  }

  // 컴포넌트 지문 비교 — 저장값과 이번 값이 모두 있고 다를 때만 불일치로 본다.
  const incoming = buildComponentFingerprint(componentsHash)
  const componentMismatch =
    incoming != null && device.component_fingerprint != null && device.component_fingerprint !== incoming

  // 저장된 컴포넌트 지문이 없고(구 기기) 이번에 들어왔으면 점진적으로 채운다.
  const patch: Record<string, unknown> = { last_used_at: new Date(), ip }
  if (incoming != null && device.component_fingerprint == null) patch.component_fingerprint = incoming
  await device.update(patch)

  return { trusted: true, componentMismatch }
}

// ─────────────────────────────────────────────
// 신뢰 기기 등록
// 동일 device_type이 있으면 upsert로 덮어씀 (PC/모바일 각 1대 유지)
// ─────────────────────────────────────────────
export async function registerTrustedDevice(
  userId: number,
  userAgent: string,
  ip: string,
  componentsHash?: string | null,
): Promise<string> {
  const deviceType = detectDeviceType(userAgent)
  const rawToken = crypto.randomBytes(32).toString('hex')
  const hashedToken = hashToken(rawToken)
  const fingerprint = buildFingerprint(userAgent, ip)
  const componentFingerprint = buildComponentFingerprint(componentsHash)
  const expiresAt = new Date(Date.now() + TRUSTED_DAYS * 24 * 60 * 60 * 1000)
  const label = buildLabel(userAgent)

  // upsert 전에 기존 기기 존재 여부 확인
  const existing = await TrustedDevice.findOne({
    where: { user_id: userId, device_type: deviceType },
  })
  const isNewDevice = !existing

  await TrustedDevice.upsert({
    user_id: userId,
    device_type: deviceType,
    device_token: hashedToken,
    device_fingerprint: fingerprint,
    component_fingerprint: componentFingerprint,
    user_agent: userAgent,
    ip,
    label,
    last_used_at: new Date(),
    expires_at: expiresAt,
    created_at: new Date(),
  })

  // 신규 기기면 이메일 알림
  if (isNewDevice) {
    const user = await User.findByPk(userId)
    if (user) {
      sendNewDeviceAlert(user.email, label, ip, new Date()).catch(console.error)
    }
  }
  // 기기 등록 알림
  const user = await User.findByPk(userId)
  if (user) {
    sendDeviceRegisteredAlert(user.email, label, ip).catch(console.error)
  }

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
  const device = await TrustedDevice.findOne({ where: { id: deviceId, user_id: userId } })
  if (!device) return

  // 기기 해제 메일 전송
  const user = await User.findByPk(userId)
  if (user && device.label) {
    sendDeviceRevokedAlert(user.email, device.label).catch(console.error)
  }

  await device.destroy()
}
// ─────────────────────────────────────────────
// 전체 기기 해제 (탈퇴 시)
// ─────────────────────────────────────────────
export async function revokeAllTrustedDevices(userId: number): Promise<void> {
  await TrustedDevice.destroy({ where: { user_id: userId } })
}
