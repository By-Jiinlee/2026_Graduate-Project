import bcrypt from 'bcryptjs'
import { Transaction } from 'sequelize'
import sequelize from '../../config/database'
import VirtualAccount from '../../models/trade/VirtualAccount'
import VirtualHolding from '../../models/trade/VirtualHolding'
import VirtualOrder from '../../models/trade/VirtualOrder'
import User from '../../models/user/User'
import { priceMap } from '../market/KisRealtime'
import { QueryTypes } from 'sequelize'
import { recordSeed, logTrade, getTradeNonce, verifyTradeSignature } from '../web3/contractService'
import Wallet from '../../models/user/Wallet'

export const INITIAL_BALANCE = 10_000_000

const FEE_RATE = 0.00015

// ─── PIN 잠금 (in-memory) ────────────────────────────────────

const PIN_MAX_FAIL = 5
const PIN_LOCK_MIN = 30

interface PinLockState { count: number; lockedUntil: Date | null }
const pinLockMap = new Map<number, PinLockState>()

export const setPin = async (userId: number, pin: string): Promise<void> => {
  if (!/^\d{6}$/.test(pin)) throw new Error('PIN은 숫자 6자리여야 합니다')
  const hash = await bcrypt.hash(pin, 10)
  await User.update({ pin_hash: hash }, { where: { id: userId } })
  pinLockMap.delete(userId)
}

export const verifyPin = async (userId: number, pin: string): Promise<void> => {
  const state = pinLockMap.get(userId)

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

  pinLockMap.delete(userId)
}

export const changePin = async (userId: number, oldPin: string, newPin: string): Promise<void> => {
  await verifyPin(userId, oldPin)
  await setPin(userId, newPin)
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

// ─── 계좌 리셋 ────────────────────────────────────────────────

export const resetAccount = async (userId: number): Promise<void> => {
  const t: Transaction = await sequelize.transaction()
  try {
    const account = await VirtualAccount.findOne({ where: { user_id: userId }, transaction: t, lock: true })
    if (!account) throw new Error('모의투자 계좌가 없습니다')

    // 미체결 매수 주문 예약금 환불 없이 계좌 초기화 (전액 initial_seed로 리셋)
    await VirtualOrder.update(
      { status: 'cancelled' },
      { where: { user_id: userId, status: 'pending' }, transaction: t }
    )
    await VirtualHolding.destroy({ where: { user_id: userId }, transaction: t })
    await account.update({ seed_balance: account.initial_seed }, { transaction: t })

    await t.commit()
  } catch (err) {
    await t.rollback()
    throw err
  }
}

// ─── 현재가 조회 ──────────────────────────────────────────────

const getCurrentPrice = async (stockCode: string, stockId: number): Promise<number> => {
  const cached = priceMap.get(stockCode)
  if (cached) return cached

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
  stockCode?: string,
  quantity?: number
): Promise<boolean> => {
  const account = await VirtualAccount.findOne({ where: { user_id: userId } })
  if (!account) throw new Error('모의투자 계좌가 없습니다')

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

    // 시장가/지정가 모두 즉시 잔고 차감 (지정가는 예약금)
    await account.update({ seed_balance: Number(account.seed_balance) - totalCost }, { transaction: t })

    if (orderType === 'market') {
      // 시장가: 즉시 보유 종목 생성
      const [holding] = await VirtualHolding.findOrCreate({
        where: { user_id: userId, stock_id: stockId },
        defaults: { user_id: userId, stock_id: stockId, quantity: 0, avg_price: 0 },
        transaction: t,
      })
      const newQty = holding.quantity + quantity
      const newAvg = (Number(holding.avg_price) * holding.quantity + price * quantity) / newQty
      await holding.update({ quantity: newQty, avg_price: newAvg }, { transaction: t })
    }
    // 지정가: 보유 종목은 스케줄러가 체결 시 생성

    const order = await VirtualOrder.create({
      user_id: userId,
      stock_id: stockId,
      order_type: orderType,
      side: 'buy',
      quantity,
      price,
      total_amount: totalCost,
      status: orderType === 'market' ? 'filled' : 'pending',
      ip_address: ipAddress,
      country,
      region,
      city,
      user_agent: userAgent,
      ordered_at: new Date(),
      filled_at: orderType === 'market' ? new Date() : undefined,
    }, { transaction: t })

    await t.commit()

    if (tradeSignature && wallet) {
      try {
        const nonce = await getTradeNonce(wallet.address)
        await logTrade(wallet.address, stockCode, 'buy', BigInt(Math.round(totalCost)), nonce)
      } catch (err) {
        console.error('[MockTrade] logTrade 실패:', err)
      }
    }

    return { order, remainingBalance: Number(account.seed_balance) }
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
    if (!holding) throw new Error('보유 수량이 부족합니다')

    if (orderType === 'market') {
      if (holding.quantity < quantity) throw new Error('보유 수량이 부족합니다')
    } else {
      // 지정가: 미체결 매도 수량 제외한 가용 수량 확인
      const pendingRows = await sequelize.query<{ pending: string }>(
        `SELECT COALESCE(SUM(quantity), 0) AS pending FROM virtual_orders
         WHERE user_id = :userId AND stock_id = :stockId AND side = 'sell' AND status = 'pending'`,
        { replacements: { userId, stockId }, type: QueryTypes.SELECT, transaction: t }
      )
      const pendingQty = Number(pendingRows[0]?.pending ?? 0)
      if (holding.quantity - pendingQty < quantity) {
        throw new Error('보유 수량이 부족합니다 (미체결 주문 포함)')
      }
    }

    const account = await VirtualAccount.findOne({ where: { user_id: userId }, transaction: t, lock: true })
    if (!account) throw new Error('모의투자 계좌가 없습니다')

    if (orderType === 'market') {
      const newQty = holding.quantity - quantity
      if (newQty === 0) {
        await holding.destroy({ transaction: t })
      } else {
        await holding.update({ quantity: newQty }, { transaction: t })
      }
      await account.update({ seed_balance: Number(account.seed_balance) + proceeds }, { transaction: t })
    }
    // 지정가: 보유/잔고 변경 없이 pending 주문만 생성

    const order = await VirtualOrder.create({
      user_id: userId,
      stock_id: stockId,
      order_type: orderType,
      side: 'sell',
      quantity,
      price,
      total_amount: totalAmount,
      status: orderType === 'market' ? 'filled' : 'pending',
      ip_address: ipAddress,
      country,
      region,
      city,
      user_agent: userAgent,
      ordered_at: new Date(),
      filled_at: orderType === 'market' ? new Date() : undefined,
    }, { transaction: t })

    await t.commit()

    if (tradeSignature && wallet) {
      try {
        const nonce = await getTradeNonce(wallet.address)
        await logTrade(wallet.address, stockCode, 'sell', BigInt(Math.round(totalAmount)), nonce)
      } catch (err) {
        console.error('[MockTrade] logTrade 실패:', err)
      }
    }

    return {
      order,
      remainingBalance: Number(account.seed_balance) + (orderType === 'market' ? proceeds : 0),
    }
  } catch (err) {
    await t.rollback()
    throw err
  }
}

// ─── 미체결 주문 조회 ─────────────────────────────────────────

export const getPendingOrders = async (userId: number) => {
  return sequelize.query<{
    id: number
    side: string
    stock_name: string
    stock_code: string
    quantity: number
    price: number
    total_amount: number
    ordered_at: string
  }>(
    `SELECT vo.id, vo.side, s.name AS stock_name, s.code AS stock_code,
            vo.quantity, vo.price, vo.total_amount,
            DATE_FORMAT(vo.ordered_at, '%Y-%m-%d %H:%i') AS ordered_at
     FROM virtual_orders vo
     JOIN stocks s ON s.id = vo.stock_id
     WHERE vo.user_id = :userId AND vo.status = 'pending'
     ORDER BY vo.ordered_at DESC`,
    { replacements: { userId }, type: QueryTypes.SELECT }
  )
}

// ─── 미체결 주문 취소 ─────────────────────────────────────────

export const cancelOrder = async (userId: number, orderId: number): Promise<void> => {
  const t: Transaction = await sequelize.transaction()
  try {
    const order = await VirtualOrder.findOne({
      where: { id: orderId, user_id: userId },
      transaction: t,
      lock: true,
    })
    if (!order) throw new Error('주문을 찾을 수 없습니다')
    if (order.status !== 'pending') throw new Error('미체결 주문만 취소할 수 있습니다')

    if (order.side === 'buy') {
      // 매수 예약금 환불
      const account = await VirtualAccount.findOne({ where: { user_id: userId }, transaction: t, lock: true })
      if (account) {
        await account.update(
          { seed_balance: Number(account.seed_balance) + Number(order.total_amount) },
          { transaction: t }
        )
      }
    }
    // 매도 취소: 보유 수량은 변동 없으므로 그냥 cancelled로만 변경

    await order.update({ status: 'cancelled' }, { transaction: t })
    await t.commit()
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
    db_close: number
    pending_sell: number
  }>(
    `SELECT vh.stock_id, s.code, s.name, vh.quantity, vh.avg_price,
            (SELECT sp.close FROM stock_prices sp WHERE sp.stock_id = vh.stock_id ORDER BY sp.price_date DESC LIMIT 1) AS db_close,
            COALESCE((SELECT SUM(vo.quantity) FROM virtual_orders vo
                      WHERE vo.user_id = vh.user_id AND vo.stock_id = vh.stock_id
                        AND vo.side = 'sell' AND vo.status = 'pending'), 0) AS pending_sell
     FROM virtual_holdings vh
     JOIN stocks s ON s.id = vh.stock_id
     WHERE vh.user_id = :userId`,
    { replacements: { userId }, type: QueryTypes.SELECT }
  )

  const holdingsWithPnl = holdings.map(h => {
    const currentPrice = priceMap.get(h.code) ?? Number(h.db_close) ?? Number(h.avg_price)
    const evalAmount = currentPrice * h.quantity
    const costAmount = Number(h.avg_price) * h.quantity
    const pnl = evalAmount - costAmount
    const pnlRate = costAmount > 0 ? (pnl / costAmount) * 100 : 0
    return { ...h, currentPrice, evalAmount, pnl, pnlRate }
  })

  const totalEval = holdingsWithPnl.reduce((sum, h) => sum + h.evalAmount, 0)
  const totalCost = holdingsWithPnl.reduce((sum, h) => sum + Number(h.avg_price) * h.quantity, 0)

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
