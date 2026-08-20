import { Request, Response } from 'express'
import * as svc from '../../services/trade/realTradeService'
import { verifyPin } from '../../services/trade/virtualTradeService'
import { getClientIp } from '../../utils/getClientIp'
import { getLocationFromIp } from '../../utils/getLocationFromIp'

// ─── 계좌 등록 ────────────────────────────────────────────────────

export const registerAccount = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const { appKey, appSecret, cano, acntPrdtCd, pin } = req.body
    if (!appKey || !appSecret || !cano || !acntPrdtCd || !pin) {
      return res.status(400).json({ message: '모든 항목을 입력해주세요' })
    }
    await verifyPin(userId, pin, {
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'],
      email: (req as any).user?.email,
    })
    await svc.registerAccount(userId, appKey, appSecret, cano, acntPrdtCd)
    res.json({ message: '실거래 계좌가 등록되었습니다' })
  } catch (err: any) {
    res.status(400).json({ message: err.message })
  }
}

// ─── 계좌 상태 조회 ───────────────────────────────────────────────

export const getAccountStatus = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const status = await svc.getAccountStatus(userId)
    res.json(status)
  } catch (err: any) {
    res.status(500).json({ message: err.message })
  }
}

// ─── 계좌 삭제 ────────────────────────────────────────────────────

export const removeAccount = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const { pin } = req.body
    if (!pin) return res.status(400).json({ message: 'PIN을 입력해주세요' })
    await verifyPin(userId, pin, {
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'],
      email: (req as any).user?.email,
    })
    await svc.removeAccount(userId)
    res.json({ message: '실거래 계좌가 해제되었습니다' })
  } catch (err: any) {
    res.status(400).json({ message: err.message })
  }
}

// ─── 잔고 조회 ────────────────────────────────────────────────────

export const getBalance = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const balance = await svc.getBalance(userId)
    res.json(balance)
  } catch (err: any) {
    res.status(400).json({ message: err.message })
  }
}

// ─── 매수 ─────────────────────────────────────────────────────────

export const buyStock = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const { stockId, stockCode, quantity, orderType, price, pin } = req.body
    if (!stockId || !stockCode || !quantity || !orderType || !price || !pin) {
      return res.status(400).json({ message: '필수 파라미터가 누락되었습니다' })
    }
    const ip = getClientIp(req)
    const location = await getLocationFromIp(ip)
    const result = await svc.buyStock({
      userId,
      stockId: Number(stockId),
      stockCode,
      orderType,
      quantity: Number(quantity),
      price: Number(price),
      pin,
      ipAddress: ip,
      ...location,
      userAgent: req.headers['user-agent'],
    })
    res.json({ message: '매수 주문이 접수되었습니다', orderId: result.order.id, kisOrderId: result.kisOrderId })
  } catch (err: any) {
    res.status(400).json({ message: err.message })
  }
}

// ─── 매도 ─────────────────────────────────────────────────────────

export const sellStock = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const { stockId, stockCode, quantity, orderType, price, pin } = req.body
    if (!stockId || !stockCode || !quantity || !orderType || !price || !pin) {
      return res.status(400).json({ message: '필수 파라미터가 누락되었습니다' })
    }
    const ip = getClientIp(req)
    const location = await getLocationFromIp(ip)
    const result = await svc.sellStock({
      userId,
      stockId: Number(stockId),
      stockCode,
      orderType,
      quantity: Number(quantity),
      price: Number(price),
      pin,
      ipAddress: ip,
      ...location,
      userAgent: req.headers['user-agent'],
    })
    res.json({ message: '매도 주문이 접수되었습니다', orderId: result.order.id, kisOrderId: result.kisOrderId })
  } catch (err: any) {
    res.status(400).json({ message: err.message })
  }
}

// ─── 거래내역 조회 ────────────────────────────────────────────────

export const getOrders = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const orders = await svc.getOrders(userId)
    res.json(orders)
  } catch (err: any) {
    res.status(500).json({ message: err.message })
  }
}
