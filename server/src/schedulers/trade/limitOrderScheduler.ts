import { Transaction } from 'sequelize'
import sequelize from '../../config/database'
import { QueryTypes } from 'sequelize'
import VirtualOrder from '../../models/trade/VirtualOrder'
import VirtualAccount from '../../models/trade/VirtualAccount'
import VirtualHolding from '../../models/trade/VirtualHolding'
import { priceMap } from '../../services/market/KisRealtime'
import { emitOrderFilled, emitToUser } from '../../services/socket/userChannel'
import cron from 'node-cron'
import {
    getMarketSessionCached,
    isMarketHoursEnforced,
    warmCalendar,
    type MarketSession,
} from '../../services/market/marketCalendar'

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
    ordered_at: Date | string
}

// 지정가 주문은 당일 유효 — 실제 증권사의 일반 지정가 주문과 같다. 이 주문이 이미 끝난 장에서
// 들어온 것인가: 지금 장이 닫혀 있으면 모든 미체결이, 장 중이면 오늘 개장 전에 들어온 주문이 해당한다.
// (장 외 주문 접수는 막혀 있으므로, 장 중에 개장 전 주문이 남아 있다면 서버 중단 등으로 만료를 놓친 것이다.)
export const isExpiredDayOrder = (orderedAt: Date | string, session: MarketSession): boolean =>
    !session.open || new Date(orderedAt).getTime() < session.todayOpen.getTime()

export const processPendingOrders = async (now = new Date()): Promise<void> => {
    let pendingOrders: PendingOrderRow[]
    try {
        pendingOrders = await sequelize.query<PendingOrderRow>(
            `SELECT vo.id, vo.user_id, vo.stock_id, s.code AS stock_code,
                    vo.side, vo.quantity, vo.price, vo.total_amount, vo.ordered_at
             FROM virtual_orders vo
             JOIN stocks s ON s.id = vo.stock_id
             WHERE vo.status = 'pending' AND vo.order_type = 'limit'`,
            { type: QueryTypes.SELECT }
        )
    } catch {
        return
    }

    const enforce = isMarketHoursEnforced()
    const session = getMarketSessionCached(now)
    if (enforce) {
        const expired = pendingOrders.filter(o => isExpiredDayOrder(o.ordered_at, session))
        for (const order of expired) {
            expireDayOrder(order).catch(err =>
                console.error(`[LimitScheduler] 주문 ${order.id} 만료 처리 오류:`, (err as Error).message)
            )
        }
        // 장이 닫혀 있으면 체결하지 않는다
        if (!session.open) return
        pendingOrders = pendingOrders.filter(o => !isExpiredDayOrder(o.ordered_at, session))
    }
    if (priceMap.size === 0) return

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

        const filledAt = new Date()
        await dbOrder.update({ status: 'filled', filled_at: filledAt }, { transaction: t })
        await t.commit()

        // 커밋 이후에 알린다 — 롤백된 거래를 체결로 알리면 안 된다.
        // 개인 데이터이므로 브로드캐스트가 아니라 주문자 채널로만 보낸다.
        emitOrderFilled(order.user_id, {
            orderId: order.id,
            stockCode: order.stock_code,
            side: order.side,
            quantity: order.quantity,
            price: Number(order.price),
            totalAmount: Number(order.total_amount),
            filledAt: filledAt.toISOString(),
        })

        console.log(
            `[LimitScheduler] 주문 ${order.id} 체결 — ${order.side} ${order.quantity}주 @ ₩${Number(order.price).toLocaleString()}`
        )
    } catch (err) {
        await t.rollback()
        throw err
    }
}

// ─── 장 마감 후 미체결 만료 ───────────────────────────────────
// 매수는 주문 때 차감한 예약금(수수료 포함)을 돌려주고, 매도는 보유 수량을 건드린 적이 없으므로 상태만 바꾼다.
// 사용자 취소(cancelOrder)와 같은 회계 규칙이다.
const expireDayOrder = async (order: PendingOrderRow): Promise<void> => {
    const t: Transaction = await sequelize.transaction()
    try {
        const dbOrder = await VirtualOrder.findByPk(order.id, { transaction: t, lock: true })
        if (!dbOrder || dbOrder.status !== 'pending') {
            await t.rollback()
            return
        }
        if (dbOrder.side === 'buy') {
            const account = await VirtualAccount.findOne({
                where: { user_id: dbOrder.user_id },
                transaction: t,
                lock: true,
            })
            if (account) {
                await account.update(
                    { seed_balance: Number(account.seed_balance) + Number(dbOrder.total_amount) },
                    { transaction: t }
                )
            }
        }
        await dbOrder.update({ status: 'cancelled' }, { transaction: t })
        await t.commit()

        emitToUser(order.user_id, 'order:expired', {
            orderId: order.id,
            stockCode: order.stock_code,
            side: order.side,
            quantity: order.quantity,
            price: Number(order.price),
            refunded: order.side === 'buy' ? Number(order.total_amount) : 0,
        })
        console.log(`[LimitScheduler] 주문 ${order.id} 장 마감 미체결 만료${order.side === 'buy' ? ' — 예약금 환불' : ''}`)
    } catch (err) {
        await t.rollback()
        throw err
    }
}

export const startLimitOrderScheduler = (): void => {
    // 휴장일 캐시 — 기동 시 1회, 매일 00:05 갱신(체결 루프는 이 캐시로 동기 판정한다)
    warmCalendar().catch(() => undefined)
    cron.schedule('5 0 * * *', () => { warmCalendar().catch(() => undefined) }, { timezone: 'Asia/Seoul' })
    console.log(`[LimitScheduler] 지정가 주문 체결 스케줄러 시작 (5초 주기, 장 운영 시간 ${isMarketHoursEnforced() ? '적용 — 정규장 09:00~15:30, 당일 유효' : '미적용(MOCK_MARKET_HOURS=off)'})`)
    setInterval(() => {
        processPendingOrders().catch(err =>
            console.error('[LimitScheduler] 처리 오류:', (err as Error).message)
        )
    }, INTERVAL_MS)
}
