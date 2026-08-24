import { Request, Response } from 'express'
import User from '../../models/user/User'
import { getClientIp } from '../../utils/getClientIp'
import * as tradeService from '../../services/trade/virtualTradeService'

// ─────────────────────────────────────────────────────────────
// 거래 PIN — 모의투자와 실거래가 공유하는 단일 인증 수단
//
// PIN 은 `User.pin_hash` 에 저장되는 **계정 단위** 수단이다. 그런데 설정·변경 경로만
// 모의투자 라우터(`/api/trade/virtual/pin`)에 얹혀 있어서, 실거래만 쓰려는 사용자도
// 모의투자 화면을 거쳐야 PIN 을 만들 수 있는 역전이 있었다. 그 경로를 여기로 옮긴다.
//
// 검증(verifyPin)은 실거래·모의투자 컨트롤러가 각자 호출한다 — 거래 종류마다
// 잠금·감사 로그 맥락이 달라서 한 곳으로 합치지 않는다.
// ─────────────────────────────────────────────────────────────

async function hasPin(userId: number): Promise<boolean> {
  const row = (await User.findByPk(userId, {
    attributes: ['pin_hash'],
    raw: true,
  })) as unknown as { pin_hash: string | null } | null
  return !!row?.pin_hash
}

/** PIN 설정 여부 — 프론트가 '설정'과 '변경' 화면을 가르는 데 쓴다. */
export const getPinStatus = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    res.json({ hasPin: await hasPin(userId) })
  } catch (err: any) {
    res.status(400).json({ message: err.message })
  }
}

/**
 * PIN 최초 설정.
 *
 * 이미 설정돼 있으면 거부한다. 예전 경로는 기존 PIN 확인 없이 덮어썼는데, 그러면
 * 세션을 탈취한 공격자가 PIN 을 자기 값으로 갈아치우고 거래를 승인할 수 있다.
 * 즉 PIN 이 거래 인증 수단으로서 아무 의미가 없어진다. 변경은 반드시 현재 PIN 을
 * 아는 사람만 할 수 있도록 changePin 으로만 허용한다.
 */
export const setPin = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const { pin } = req.body
    if (!pin) return res.status(400).json({ message: 'PIN을 입력해주세요' })

    if (await hasPin(userId)) {
      return res.status(400).json({
        message: '이미 PIN이 설정되어 있습니다. 변경하려면 현재 PIN을 입력해주세요.',
        code: 'PIN_ALREADY_SET',
      })
    }

    await tradeService.setPin(userId, pin)
    res.json({ message: 'PIN이 설정되었습니다' })
  } catch (err: any) {
    res.status(400).json({ message: err.message })
  }
}

/** PIN 변경 — 현재 PIN 검증을 거친다(서비스의 changePin 이 verifyPin 을 호출). */
export const changePin = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const { oldPin, newPin } = req.body
    if (!oldPin || !newPin) {
      return res.status(400).json({ message: '현재 PIN과 새 PIN을 입력해주세요' })
    }

    await tradeService.changePin(userId, oldPin, newPin)
    res.json({ message: 'PIN이 변경되었습니다' })
  } catch (err: any) {
    res.status(400).json({ message: err.message })
  }
}

/**
 * PIN 검증만 수행 — 변경 흐름의 첫 단계에서 현재 PIN을 즉시 확인하는 용도.
 *
 * 이 엔드포인트가 없으면 사용자는 틀린 현재 PIN으로도 새 PIN을 두 번 입력한 뒤에야
 * 실패를 알게 된다. 입력을 다 시키고 마지막에 거절하는 건 그 자체로 결함이다.
 *
 * 브루트포스 표면이 넓어지지 않는다 — verifyPin 이 5회 실패 잠금과 감사 로그
 * (recordTradeAuthAttempt)를 이미 수행하고, 이 경로도 인증·HMAC 서명을 거친다.
 */
export const verifyPinOnly = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const { pin } = req.body
    if (!pin) return res.status(400).json({ message: 'PIN을 입력해주세요' })

    await tradeService.verifyPin(userId, pin, {
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'],
      email: (req as any).user?.email,
    })
    res.json({ ok: true })
  } catch (err: any) {
    res.status(400).json({ message: err.message })
  }
}
