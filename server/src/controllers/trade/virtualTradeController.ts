import { Request, Response } from 'express'
import * as tradeService from '../../services/trade/virtualTradeService'
import { getClientIp } from '../../utils/getClientIp'
import { getLocationFromIp } from '../../utils/getLocationFromIp'
import { evaluateTradeRequest, TradeAssessment } from '../../services/auth/tradeAnomalyService'

// ─── 거래 이상탐지 게이트 (M-1) ───────────────────────────────
// 주문 실행 직전에 무결성·이상금액을 판정한다.
//  BLOCK   : 정상 클라이언트가 만들 수 없는 주문 → 400 으로 거절
//  STEP_UP : 지갑 서명이 없으면 403 LARGE_ORDER 로 재인증 요구(기존 고액거래 흐름)
// 판정 결과를 응답으로 바꿨으면 true 를 돌려준다(호출부는 즉시 반환).
const rejectByAssessment = (res: Response, a: TradeAssessment): boolean => {
  if (a.verdict === 'BLOCK') {
    res.status(400).json({ message: a.userMessage, code: 'INVALID_ORDER' })
    return true
  }
  return false
}

// ─── PIN 설정 ─────────────────────────────────────────────────

export const setPin = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const { pin } = req.body
    if (!pin) return res.status(400).json({ message: 'PIN을 입력해주세요' })

    await tradeService.setPin(userId, pin)
    res.json({ message: 'PIN이 설정되었습니다' })
  } catch (err: any) {
    res.status(400).json({ message: err.message })
  }
}

// ─── PIN 변경 ─────────────────────────────────────────────────

export const changePin = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const { oldPin, newPin } = req.body
    if (!oldPin || !newPin) return res.status(400).json({ message: '현재 PIN과 새 PIN을 입력해주세요' })

    await tradeService.changePin(userId, oldPin, newPin)
    res.json({ message: 'PIN이 변경되었습니다' })
  } catch (err: any) {
    res.status(400).json({ message: err.message })
  }
}

// ─── 계좌 개설 ────────────────────────────────────────────────

export const openAccount = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const { pin } = req.body
    if (!pin) return res.status(400).json({ message: 'PIN을 입력해주세요' })

    await tradeService.verifyPin(userId, pin, {
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'],
      email: (req as any).user?.email,
    })
    const account = await tradeService.openAccount(userId)
    res.status(201).json({
      message: '모의투자 계좌가 개설되었습니다',
      balance: Number(account.seed_balance),
    })
  } catch (err: any) {
    res.status(400).json({ message: err.message })
  }
}

// ─── 계좌 리셋 ────────────────────────────────────────────────

export const resetAccount = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const { pin } = req.body
    if (!pin) return res.status(400).json({ message: 'PIN을 입력해주세요' })

    await tradeService.verifyPin(userId, pin, {
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'],
      email: (req as any).user?.email,
    })
    await tradeService.resetAccount(userId)
    res.json({ message: '계좌가 초기화되었습니다' })
  } catch (err: any) {
    res.status(400).json({ message: err.message })
  }
}

// ─── 매수 ─────────────────────────────────────────────────────

export const buyStock = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const { stockId, stockCode, quantity, orderType, limitPrice, pin, tradeSignature, signedAmount } = req.body

    if (!stockId || !stockCode || !quantity || !orderType || !pin) {
      return res.status(400).json({ message: '필수 파라미터가 누락되었습니다' })
    }
    if (orderType === 'limit' && !limitPrice) {
      return res.status(400).json({ message: '지정가 주문에는 가격이 필요합니다' })
    }

    const ip = getClientIp(req)
    const userAgent = req.headers['user-agent']

    // PIN 검증 결과를 기록해야 "반복 실패 후 성공"(M-5)을 판정할 수 있으므로 문맥을 넘긴다.
    await tradeService.verifyPin(userId, pin, { ip, userAgent, email: (req as any).user?.email })

    const { price, portfolioValue } = await tradeService.getOrderValuation({
      userId,
      stockId: Number(stockId),
      stockCode,
      quantity: Number(quantity),
      orderType,
      limitPrice: limitPrice != null ? Number(limitPrice) : undefined,
    })

    const assessment = await evaluateTradeRequest({
      userId, ip, userAgent, market: 'virtual', side: 'buy', stockCode,
      quantity: Number(quantity), price, portfolioValue,
      hasSignature: Boolean(tradeSignature),
    })
    if (rejectByAssessment(res, assessment)) return
    if (assessment.verdict === 'STEP_UP' && !tradeSignature) {
      return res.status(403).json({ message: 'LARGE_ORDER', detail: assessment.userMessage })
    }

    const location = await getLocationFromIp(ip)

    const result = await tradeService.buyStock({
      userId,
      stockId: Number(stockId),
      stockCode,
      quantity: Number(quantity),
      orderType,
      limitPrice: limitPrice ? Number(limitPrice) : undefined,
      tradeSignature,
      signedAmount: signedAmount ? BigInt(signedAmount) : undefined,
      ipAddress: ip,
      ...location,
      userAgent: req.headers['user-agent'],
    })

    const msg = orderType === 'market' ? '매수가 완료되었습니다' : '매수 지정가 주문이 접수되었습니다'
    res.json({
      message: msg,
      orderId: result.order.id,
      remainingBalance: result.remainingBalance,
    })
  } catch (err: any) {
    res.status(400).json({ message: err.message })
  }
}

// ─── 매도 ─────────────────────────────────────────────────────

export const sellStock = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const { stockId, stockCode, quantity, orderType, limitPrice, pin, tradeSignature, signedAmount } = req.body

    if (!stockId || !stockCode || !quantity || !orderType || !pin) {
      return res.status(400).json({ message: '필수 파라미터가 누락되었습니다' })
    }
    if (orderType === 'limit' && !limitPrice) {
      return res.status(400).json({ message: '지정가 주문에는 가격이 필요합니다' })
    }

    const ip = getClientIp(req)
    const userAgent = req.headers['user-agent']

    // PIN 검증 결과를 기록해야 "반복 실패 후 성공"(M-5)을 판정할 수 있으므로 문맥을 넘긴다.
    await tradeService.verifyPin(userId, pin, { ip, userAgent, email: (req as any).user?.email })

    const { price, portfolioValue } = await tradeService.getOrderValuation({
      userId,
      stockId: Number(stockId),
      stockCode,
      quantity: Number(quantity),
      orderType,
      limitPrice: limitPrice != null ? Number(limitPrice) : undefined,
    })

    const assessment = await evaluateTradeRequest({
      userId, ip, userAgent, market: 'virtual', side: 'sell', stockCode,
      quantity: Number(quantity), price, portfolioValue,
      hasSignature: Boolean(tradeSignature),
    })
    if (rejectByAssessment(res, assessment)) return
    if (assessment.verdict === 'STEP_UP' && !tradeSignature) {
      return res.status(403).json({ message: 'LARGE_ORDER', detail: assessment.userMessage })
    }

    const location = await getLocationFromIp(ip)

    const result = await tradeService.sellStock({
      userId,
      stockId: Number(stockId),
      stockCode,
      quantity: Number(quantity),
      orderType,
      limitPrice: limitPrice ? Number(limitPrice) : undefined,
      tradeSignature,
      signedAmount: signedAmount ? BigInt(signedAmount) : undefined,
      ipAddress: ip,
      ...location,
      userAgent: req.headers['user-agent'],
    })

    const msg = orderType === 'market' ? '매도가 완료되었습니다' : '매도 지정가 주문이 접수되었습니다'
    res.json({
      message: msg,
      orderId: result.order.id,
      remainingBalance: result.remainingBalance,
    })
  } catch (err: any) {
    res.status(400).json({ message: err.message })
  }
}

// ─── 미체결 주문 조회 ─────────────────────────────────────────

export const getPendingOrders = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const orders = await tradeService.getPendingOrders(userId)
    res.json(orders)
  } catch (err: any) {
    res.status(500).json({ message: err.message })
  }
}

// ─── 미체결 주문 취소 ─────────────────────────────────────────

export const cancelOrder = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const orderId = Number(req.params.orderId)
    if (!orderId) return res.status(400).json({ message: '유효하지 않은 주문 ID입니다' })

    await tradeService.cancelOrder(userId, orderId)
    res.json({ message: '주문이 취소되었습니다' })
  } catch (err: any) {
    res.status(400).json({ message: err.message })
  }
}

// ─── 거래내역 조회 ────────────────────────────────────────────

export const getOrders = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const orders = await tradeService.getOrders(userId)
    res.json(orders)
  } catch (err: any) {
    res.status(500).json({ message: err.message })
  }
}

// ─── 포트폴리오 조회 ──────────────────────────────────────────

export const getPortfolio = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const portfolio = await tradeService.getPortfolio(userId)
    if (!portfolio) return res.status(404).json({ message: '모의투자 계좌가 없습니다' })
    res.json(portfolio)
  } catch (err: any) {
    res.status(500).json({ message: err.message })
  }
}
