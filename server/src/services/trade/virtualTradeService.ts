import bcrypt from 'bcryptjs'
import { Transaction } from 'sequelize'
import sequelize from '../../config/database'
import VirtualAccount from '../../models/trade/VirtualAccount'
import VirtualHolding from '../../models/trade/VirtualHolding'
import VirtualOrder from '../../models/trade/VirtualOrder'
import User from '../../models/user/User'
import { priceMap } from '../market/KisRealtime'
import { QueryTypes } from 'sequelize'
import { recordSeed, logTrade, getTradeNonce, verifyTradeSignature, buildTradeMessage } from '../web3/contractService'
import Wallet from '../../models/user/Wallet'

export const INITIAL_BALANCE = 10_000_000 // 1000만 원

const FEE_RATE = 0.00015 // 0.015%

// ─── PIN 잠금 (in-memory) ────────────────────────────────────

const PIN_MAX_FAIL = 5
const PIN_LOCK_MIN = 30

interface PinLockState { count: number; lockedUntil: Date | null }
const pinLockMap = new Map<number, PinLockState>()

export const setPin = async (userId: number, pin: string): Promise<void> => {
  if (!/^\d{6}$/.test(pin)) throw new Error('PIN은 숫자 6자리여야 합니다')
  const hash = await bcrypt.hash(pin, 10)
  await User.update({ pin_hash: hash }, { where: { id: userId } })
  pinLockMap.delete(userId) // PIN 변경 시 잠금 해제
}

export const verifyPin = async (userId: number, pin: string): Promise<void> => {
  const state = pinLockMap.get(userId)

  // 잠금 확인
  if (state?.lockedUntil && new Date() < state.lockedUntil) {
    const remain = Math.ceil((state.lockedUntil.getTime() - Date.now()) / 60000)
    throw new Error(`PIN이 ${PIN_MAX_FAIL}회 틀려 ${remain}분간 잠금 상태입니다`)
  }

  const user = await User.findByPk(userId)
  if (!user?.pin_hash) throw new Error('PIN이 설정되지 않았습니다')
  const ok = await bcrypt.compare(pin, user.pin_hash)

  if (!ok) {
    const current = pinLockMap.get(userId) ?? { count: 0, lockedUntil: null }
    const newCount = current.count + 1
    if (newCount >= PIN_MAX_FAIL) {
      const lockedUntil = new Date(Date.now() + PIN_LOCK_MIN * 60 * 1000)
      pinLockMap.set(userId, { count: newCount, lockedUntil })
      throw new Error(`PIN 오류 ${PIN_MAX_FAIL}회 초과. ${PIN_LOCK_MIN}분간 잠금됩니다`)
    }
    pinLockMap.set(userId, { count: newCount, lockedUntil: null })
    throw new Error(`PIN이 올바르지 않습니다 (${newCount}/${PIN_MAX_FAIL})`)
  }

  // 성공 시 초기화
  pinLockMap.delete(userId)
}

// ─── 계좌 개설 ────────────────────────────────────────────────

export const openAccount = async (userId: number): Promise<VirtualAccount> => {
  const existing = await VirtualAccount.findOne({ where: { user_id: userId } })
  if (existing) throw new Error('이미 모의투자 계좌가 존재합니다')

  const account = await VirtualAccount.create({
    user_id: userId,
    seed_balance: INITIAL_BALANCE,
    initial_seed: INITIAL_BALANCE,
    is_active: true,
    activated_at: new Date(),
  })

  // 온체인 버짓 지급 기록 (실패해도 계좌 개설은 유지)
  try {
    const wallet = await Wallet.findOne({ where: { user_id: userId } })
    if (wallet) {
      await recordSeed(wallet.address, BigInt(INITIAL_BALANCE))
    }
  } catch (err) {
    console.error('[MockTrade] recordSeed 실패:', err)
  }

  return account
}

// ─── 현재가 조회 (스냅샷 → DB 폴백) ──────────────────────────

const getCurrentPrice = async (stockCode: string, stockId: number): Promise<number> => {
  const cached = priceMap.get(stockCode)
  if (cached) return cached

  // WebSocket 미수신 시 DB 최근 종가 폴백
  const rows = await sequelize.query<{ close: number }>(
    `SELECT close FROM stock_prices WHERE stock_id = :stockId ORDER BY price_date DESC LIMIT 1`,
    { replacements: { stockId }, type: QueryTypes.SELECT }
  )
  if (!rows.length) throw new Error('현재가를 조회할 수 없습니다')
  return rows[0].close
}

// ─── 고액 거래 판정 ───────────────────────────────────────────

export const isLargeOrder = async (
  userId: number,
  tradeAmount: number,
  stockCode?: string,  // 시장가 주문 시 현재가 조회용
  quantity?: number
): Promise<boolean> => {
  const account = await VirtualAccount.findOne({ where: { user_id: userId } })
  if (!account) throw new Error('모의투자 계좌가 없습니다')

  // 시장가 주문: priceMap에서 실제 금액 계산
  let actualAmount = tradeAmount
  if (actualAmount === 0 && stockCode && quantity) {
    const currentPrice = priceMap.get(stockCode)
    if (currentPrice) actualAmount = currentPrice * quantity
  }

  const holdings = await VirtualHolding.findAll({ where: { user_id: userId } })

  let stockValue = 0
  for (const h of holdings) {
    const rows = await sequelize.query<{ code: string }>(
      `SELECT code FROM stocks WHERE id = :stockId LIMIT 1`,
      { replacements: { stockId: h.stock_id }, type: QueryTypes.SELECT }
    )
    if (rows.length) {
      const price = priceMap.get(rows[0].code) ?? Number(h.avg_price)
      stockValue += price * h.quantity
    }
  }

  const totalPortfolio = Number(account.seed_balance) + stockValue
  const threshold = totalPortfolio > 0 ? totalPortfolio : INITIAL_BALANCE
  return actualAmount > threshold * 0.2
}

// ─── 매수 ─────────────────────────────────────────────────────

interface BuyParams {
  userId: number
  stockId: number
  stockCode: string
  quantity: number
  orderType: 'market' | 'limit'
  limitPrice?: number
  tradeSignature?: string
  signedAmount?: bigint
  ipAddress: string
  country?: string
  region?: string
  city?: string
  userAgent?: string
}

export const buyStock = async (params: BuyParams) => {
  const { userId, stockId, stockCode, quantity, orderType, limitPrice, tradeSignature, signedAmount, ipAddress, country, region, city, userAgent } = params

  const price = orderType === 'market'
    ? await getCurrentPrice(stockCode, stockId)
    : limitPrice!

  const totalAmount = price * quantity
  const fee = Math.floor(totalAmount * FEE_RATE)
  const totalCost = totalAmount + fee

  // 고액 거래: MetaMask 서명 검증 (클라이언트가 서명한 amount 그대로 사용)
  const wallet = await Wallet.findOne({ where: { user_id: userId } })
  if (tradeSignature && wallet) {
    const nonce = await getTradeNonce(wallet.address)
    const verifyAmount = signedAmount ?? BigInt(Math.round(totalAmount))
    await verifyTradeSignature(wallet.address, nonce, verifyAmount, stockCode, tradeSignature)
  }

  const t: Transaction = await sequelize.transaction()
  try {
    const account = await VirtualAccount.findOne({ where: { user_id: userId }, transaction: t, lock: true })
    if (!account) throw new Error('모의투자 계좌가 없습니다')
    if (Number(account.seed_balance) < totalCost) throw new Error('잔고가 부족합니다')

    await account.update({ seed_balance: Number(account.seed_balance) - totalCost }, { transaction: t })

    const [holding] = await VirtualHolding.findOrCreate({
      where: { user_id: userId, stock_id: stockId },
      defaults: { user_id: userId, stock_id: stockId, quantity: 0, avg_price: 0 },
      transaction: t,
    })

    const newQty = holding.quantity + quantity
    const newAvg = (holding.avg_price * holding.quantity + price * quantity) / newQty
    await holding.update({ quantity: newQty, avg_price: newAvg }, { transaction: t })

    const order = await VirtualOrder.create({
      user_id: userId,
      stock_id: stockId,
      order_type: orderType,
      side: 'buy',
      quantity,
      price,
      total_amount: totalCost,
      status: 'filled',
      ip_address: ipAddress,
      country,
      region,
      city,
      user_agent: userAgent,
      ordered_at: new Date(),
      filled_at: orderType === 'market' ? new Date() : undefined,
    }, { transaction: t })

    await t.commit()

    // 고액 거래 온체인 감사 로그 (비동기, 실패해도 거래 유지)
    if (tradeSignature && wallet) {
      try {
        const nonce = await getTradeNonce(wallet.address)
        await logTrade(wallet.address, stockCode, 'buy', BigInt(Math.round(totalCost)), nonce)
      } catch (err) {
        console.error('[MockTrade] logTrade 실패:', err)
      }
    }

    return { order, remainingBalance: Number(account.seed_balance) - totalCost }
  } catch (err) {
    await t.rollback()
    throw err
  }
}

// ─── 매도 ─────────────────────────────────────────────────────

interface SellParams {
  userId: number
  stockId: number
  stockCode: string
  quantity: number
  orderType: 'market' | 'limit'
  limitPrice?: number
  tradeSignature?: string
  signedAmount?: bigint
  ipAddress: string
  country?: string
  region?: string
  city?: string
  userAgent?: string
}

export const sellStock = async (params: SellParams) => {
  const { userId, stockId, stockCode, quantity, orderType, limitPrice, tradeSignature, signedAmount, ipAddress, country, region, city, userAgent } = params

  const price = orderType === 'market'
    ? await getCurrentPrice(stockCode, stockId)
    : limitPrice!

  const totalAmount = price * quantity
  const fee = Math.floor(totalAmount * FEE_RATE)
  const proceeds = totalAmount - fee

  // 고액 거래: MetaMask 서명 검증 (클라이언트가 서명한 amount 그대로 사용)
  const wallet = await Wallet.findOne({ where: { user_id: userId } })
  if (tradeSignature && wallet) {
    const nonce = await getTradeNonce(wallet.address)
    const verifyAmount = signedAmount ?? BigInt(Math.round(totalAmount))
    await verifyTradeSignature(wallet.address, nonce, verifyAmount, stockCode, tradeSignature)
  }

  const t: Transaction = await sequelize.transaction()
  try {
    const holding = await VirtualHolding.findOne({
      where: { user_id: userId, stock_id: stockId },
      transaction: t,
      lock: true,
    })
    if (!holding || holding.quantity < quantity) throw new Error('보유 수량이 부족합니다')

    const account = await VirtualAccount.findOne({ where: { user_id: userId }, transaction: t, lock: true })
    if (!account) throw new Error('모의투자 계좌가 없습니다')

    const newQty = holding.quantity - quantity
    if (newQty === 0) {
      await holding.destroy({ transaction: t })
    } else {
      await holding.update({ quantity: newQty }, { transaction: t })
    }

    await account.update({ seed_balance: Number(account.seed_balance) + proceeds }, { transaction: t })

    const order = await VirtualOrder.create({
      user_id: userId,
      stock_id: stockId,
      order_type: orderType,
      side: 'sell',
      quantity,
      price,
      total_amount: totalAmount,
      status: 'filled',
      ip_address: ipAddress,
      country,
      region,
      city,
      user_agent: userAgent,
      ordered_at: new Date(),
      filled_at: orderType === 'market' ? new Date() : undefined,
    }, { transaction: t })

    await t.commit()

    // 고액 거래 온체인 감사 로그 (비동기, 실패해도 거래 유지)
    if (tradeSignature && wallet) {
      try {
        const nonce = await getTradeNonce(wallet.address)
        await logTrade(wallet.address, stockCode, 'sell', BigInt(Math.round(totalAmount)), nonce)
      } catch (err) {
        console.error('[MockTrade] logTrade 실패:', err)
      }
    }

    return { order, remainingBalance: Number(account.seed_balance) + proceeds }
  } catch (err) {
    await t.rollback()
    throw err
  }
}

// ─── 거래내역 조회 ────────────────────────────────────────────

export const getOrders = async (userId: number) => {
  return sequelize.query<{
    id: number; side: string; order_type: string; stock_name: string; stock_code: string;
    quantity: number; price: number; total_amount: number; status: string;
    ordered_at: string; filled_at: string | null;
  }>(
    `SELECT vo.id, vo.side, vo.order_type, s.name AS stock_name, s.code AS stock_code,
            vo.quantity, vo.price, vo.total_amount, vo.status,
            DATE_FORMAT(vo.ordered_at, '%Y-%m-%d %H:%i') AS ordered_at,
            DATE_FORMAT(vo.filled_at,  '%Y-%m-%d %H:%i') AS filled_at
     FROM virtual_orders vo
     JOIN stocks s ON s.id = vo.stock_id
     WHERE vo.user_id = :userId
     ORDER BY vo.ordered_at DESC
     LIMIT 50`,
    { replacements: { userId }, type: QueryTypes.SELECT }
  )
}

// ─── 포트폴리오 조회 ──────────────────────────────────────────

export const getPortfolio = async (userId: number) => {
  const account = await VirtualAccount.findOne({ where: { user_id: userId } })
  if (!account) return null

  const holdings = await sequelize.query<{
    stock_id: number
    code: string
    name: string
    quantity: number
    avg_price: number
  }>(
    `SELECT vh.stock_id, s.code, s.name, vh.quantity, vh.avg_price
     FROM virtual_holdings vh
     JOIN stocks s ON s.id = vh.stock_id
     WHERE vh.user_id = :userId`,
    { replacements: { userId }, type: QueryTypes.SELECT }
  )

  const holdingsWithPnl = holdings.map(h => {
    const currentPrice = priceMap.get(h.code) ?? h.avg_price
    const evalAmount = currentPrice * h.quantity
    const costAmount = h.avg_price * h.quantity
    const pnl = evalAmount - costAmount
    const pnlRate = costAmount > 0 ? (pnl / costAmount) * 100 : 0
    return { ...h, currentPrice, evalAmount, pnl, pnlRate }
  })

  const totalEval = holdingsWithPnl.reduce((sum, h) => sum + h.evalAmount, 0)
  const totalCost = holdingsWithPnl.reduce((sum, h) => sum + h.avg_price * h.quantity, 0)

  return {
    balance: Number(account.seed_balance),
    initialBalance: Number(account.initial_seed),
    totalEval,
    totalAsset: Number(account.seed_balance) + totalEval,
    totalPnl: totalEval - totalCost,
    totalPnlRate: totalCost > 0 ? ((totalEval - totalCost) / totalCost) * 100 : 0,
    holdings: holdingsWithPnl,
  }
}
