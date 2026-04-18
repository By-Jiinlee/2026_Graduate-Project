import { Transaction } from 'sequelize'
import sequelize from '../../config/database'
import { QueryTypes } from 'sequelize'
import VirtualOrder from '../../models/trade/VirtualOrder'
import VirtualAccount from '../../models/trade/VirtualAccount'
import VirtualHolding from '../../models/trade/VirtualHolding'
import { priceMap } from '../../services/market/KisRealtime'

const FEE_RATE = 0.00015
const INTERVAL_MS = 5000

interface PendingOrderRow {
    id: number
    user_id: number
    stock_id: number
    stock_code: string
    side: 'buy' | 'sell'
    quantity: number
    price: number
    total_amount: number
}

export const processPendingOrders = async (): Promise<void> => {
    if (priceMap.size === 0) return

    let pendingOrders: PendingOrderRow[]
    try {
        pendingOrders = await sequelize.query<PendingOrderRow>(
            `SELECT vo.id, vo.user_id, vo.stock_id, s.code AS stock_code,
                    vo.side, vo.quantity, vo.price, vo.total_amount
             FROM virtual_orders vo
             JOIN stocks s ON s.id = vo.stock_id
             WHERE vo.status = 'pending' AND vo.order_type = 'limit'`,
            { type: QueryTypes.SELECT }
        )
    } catch {
        return
    }

    for (const order of pendingOrders) {
        const currentPrice = priceMap.get(order.stock_code)
        if (currentPrice === undefined) continue

        const shouldFill =
            order.side === 'buy'
                ? currentPrice <= Number(order.price)   // 매수: 현재가 ≤ 지정가
                : currentPrice >= Number(order.price)   // 매도: 현재가 ≥ 지정가

        if (!shouldFill) continue

        fillLimitOrder(order).catch(err =>
            console.error(`[LimitScheduler] 주문 ${order.id} 체결 오류:`, (err as Error).message)
        )
    }
}

const fillLimitOrder = async (order: PendingOrderRow): Promise<void> => {
    const t: Transaction = await sequelize.transaction()
    try {
        const dbOrder = await VirtualOrder.findByPk(order.id, { transaction: t, lock: true })
        if (!dbOrder || dbOrder.status !== 'pending') {
            await t.rollback()
            return
        }

        if (order.side === 'buy') {
            // 자금은 주문 시 이미 차감됨 → 보유 종목만 생성
            const [holding] = await VirtualHolding.findOrCreate({
                where: { user_id: order.user_id, stock_id: order.stock_id },
                defaults: { user_id: order.user_id, stock_id: order.stock_id, quantity: 0, avg_price: 0 },
                transaction: t,
            })
            const newQty = holding.quantity + order.quantity
            const newAvg =
                (Number(holding.avg_price) * holding.quantity + Number(order.price) * order.quantity) / newQty
            await holding.update({ quantity: newQty, avg_price: newAvg }, { transaction: t })
        } else {
            // 보유 종목 차감 + 잔고 입금
            const holding = await VirtualHolding.findOne({
                where: { user_id: order.user_id, stock_id: order.stock_id },
                transaction: t,
                lock: true,
            })
            if (!holding || holding.quantity < order.quantity) {
                await dbOrder.update({ status: 'cancelled' }, { transaction: t })
                await t.commit()
                console.log(`[LimitScheduler] 주문 ${order.id} 취소 (보유 수량 부족)`)
                return
            }
            const newQty = holding.quantity - order.quantity
            if (newQty === 0) {
                await holding.destroy({ transaction: t })
            } else {
                await holding.update({ quantity: newQty }, { transaction: t })
            }
            const fee = Math.floor(Number(order.total_amount) * FEE_RATE)
            const proceeds = Number(order.total_amount) - fee
            const account = await VirtualAccount.findOne({
                where: { user_id: order.user_id },
                transaction: t,
                lock: true,
            })
            if (!account) { await t.rollback(); return }
            await account.update({ seed_balance: Number(account.seed_balance) + proceeds }, { transaction: t })
        }

        await dbOrder.update({ status: 'filled', filled_at: new Date() }, { transaction: t })
        await t.commit()
        console.log(
            `[LimitScheduler] 주문 ${order.id} 체결 — ${order.side} ${order.quantity}주 @ ₩${Number(order.price).toLocaleString()}`
        )
    } catch (err) {
        await t.rollback()
        throw err
    }
}

export const startLimitOrderScheduler = (): void => {
    console.log('[LimitScheduler] 지정가 주문 체결 스케줄러 시작 (5초 주기)')
    setInterval(() => {
        processPendingOrders().catch(err =>
            console.error('[LimitScheduler] 처리 오류:', (err as Error).message)
        )
    }, INTERVAL_MS)
}
