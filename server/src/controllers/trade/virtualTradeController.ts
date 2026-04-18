import { Request, Response } from 'express'
import * as tradeService from '../../services/trade/virtualTradeService'
import { getClientIp } from '../../utils/getClientIp'
import { getLocationFromIp } from '../../utils/getLocationFromIp'

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

    await tradeService.verifyPin(userId, pin)
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

    await tradeService.verifyPin(userId, pin)
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

    await tradeService.verifyPin(userId, pin)

    const tradeAmount = orderType === 'limit' ? Number(limitPrice) * Number(quantity) : 0
    const large = await tradeService.isLargeOrder(userId, tradeAmount, stockCode, Number(quantity))
    if (large && !tradeSignature) {
      return res.status(403).json({ message: 'LARGE_ORDER', detail: '고액 거래입니다. MetaMask 서명이 필요합니다' })
    }

    const ip = getClientIp(req)
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

    await tradeService.verifyPin(userId, pin)

    const tradeAmount = orderType === 'limit' ? Number(limitPrice) * Number(quantity) : 0
    const large = await tradeService.isLargeOrder(userId, tradeAmount, stockCode, Number(quantity))
    if (large && !tradeSignature) {
      return res.status(403).json({ message: 'LARGE_ORDER', detail: '고액 거래입니다. MetaMask 서명이 필요합니다' })
    }

    const ip = getClientIp(req)
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
