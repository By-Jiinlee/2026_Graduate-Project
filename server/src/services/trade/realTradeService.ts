import axios from 'axios'
import crypto from 'crypto'
import RealAccount from '../../models/trade/RealAccount'
import RealOrder from '../../models/trade/RealOrder'
import { getUserKisToken, clearUserToken } from '../market/KisUserAuth'
import { verifyPin } from './virtualTradeService'

const KIS_BASE_URL = 'https://openapi.koreainvestment.com:9443'

// ─── 암호화 ───────────────────────────────────────────────────────
// .env에 KIS_ENCRYPT_KEY=<64자리 hex 문자열> 추가 필요
// ex) node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

const getEncryptKey = () => {
  const key = process.env.KIS_ENCRYPT_KEY
  if (!key || key.length < 64) throw new Error('KIS_ENCRYPT_KEY가 설정되지 않았습니다 (.env 확인)')
  return Buffer.from(key.slice(0, 64), 'hex')
}

const encrypt = (text: string): string => {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-cbc', getEncryptKey(), iv)
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return iv.toString('hex') + ':' + encrypted.toString('hex')
}

const decrypt = (text: string): string => {
  const [ivHex, encHex] = text.split(':')
  const iv = Buffer.from(ivHex, 'hex')
  const enc = Buffer.from(encHex, 'hex')
  const decipher = crypto.createDecipheriv('aes-256-cbc', getEncryptKey(), iv)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8')
}

// ─── KIS API 헬퍼 ────────────────────────────────────────────────

const kisHeaders = (token: string, appKey: string, appSecret: string, trId: string) => ({
  authorization: `Bearer ${token}`,
  appkey: appKey,
  appsecret: appSecret,
  tr_id: trId,
  custtype: 'P',
  'content-type': 'application/json; charset=utf-8',
})

// ─── 계좌 등록 ────────────────────────────────────────────────────

export const registerAccount = async (
  userId: number,
  appKey: string,
  appSecret: string,
  cano: string,
  acntPrdtCd: string,
): Promise<void> => {
  if (!/^\d{8}$/.test(cano)) throw new Error('계좌번호는 숫자 8자리여야 합니다')
  if (!/^\d{2}$/.test(acntPrdtCd)) throw new Error('계좌상품코드는 숫자 2자리여야 합니다')
  if (!appKey || appKey.length < 10) throw new Error('유효하지 않은 APP KEY입니다')
  if (!appSecret || appSecret.length < 10) throw new Error('유효하지 않은 APP SECRET입니다')

  // KIS 토큰 발급으로 키 유효성 검증
  try {
    await getUserKisToken(userId, appKey, appSecret)
  } catch {
    clearUserToken(userId)
    throw new Error('KIS API 키 인증 실패: APP KEY / APP SECRET을 확인해주세요')
  }

  const existing = await RealAccount.findOne({ where: { user_id: userId } })
  if (existing) {
    await existing.update({
      app_key: encrypt(appKey),
      app_secret: encrypt(appSecret),
      cano: encrypt(cano),
      acnt_prdt_cd: acntPrdtCd,
      is_active: true,
    })
  } else {
    await RealAccount.create({
      user_id: userId,
      app_key: encrypt(appKey),
      app_secret: encrypt(appSecret),
      cano: encrypt(cano),
      acnt_prdt_cd: acntPrdtCd,
      is_active: true,
    })
  }
}

// ─── 계좌 상태 조회 ───────────────────────────────────────────────

export const getAccountStatus = async (
  userId: number,
): Promise<{ isRegistered: boolean; buyableAmount?: number; maskedCano?: string }> => {
  const account = await RealAccount.findOne({ where: { user_id: userId, is_active: true } })
  if (!account) return { isRegistered: false }

  const cano = decrypt(account.cano)
  const maskedCano = cano.slice(0, 2) + '******'

  try {
    const appKey = decrypt(account.app_key)
    const appSecret = decrypt(account.app_secret)
    const token = await getUserKisToken(userId, appKey, appSecret)
    const res = await axios.get(`${KIS_BASE_URL}/uapi/domestic-stock/v1/trading/inquire-balance`, {
      params: {
        CANO: cano,
        ACNT_PRDT_CD: account.acnt_prdt_cd,
        AFHR_FLPR_YN: 'N',
        OFL_YN: '',
        INQR_DVSN: '02',
        UNPR_DVSN: '01',
        FUND_STTL_ICLD_YN: 'N',
        FNCG_AMT_AUTO_RDPT_YN: 'N',
        PRCS_DVSN: '01',
        CTX_AREA_FK100: '',
        CTX_AREA_NK100: '',
      },
      headers: kisHeaders(token, appKey, appSecret, 'TTTC8434R'),
    })
    const buyableAmount = Number(res.data.output2?.[0]?.ord_psbl_cash ?? 0)
    return { isRegistered: true, buyableAmount, maskedCano }
  } catch {
    // KIS API 실패해도 계좌 등록 상태는 true 반환
    return { isRegistered: true, maskedCano }
  }
}

// ─── 계좌 삭제 ────────────────────────────────────────────────────

export const removeAccount = async (userId: number): Promise<void> => {
  const account = await RealAccount.findOne({ where: { user_id: userId } })
  if (!account) throw new Error('등록된 실거래 계좌가 없습니다')
  clearUserToken(userId)
  await account.destroy()
}

// ─── KIS 잔고 상세 조회 ───────────────────────────────────────────

export const getBalance = async (userId: number) => {
  const account = await RealAccount.findOne({ where: { user_id: userId, is_active: true } })
  if (!account) throw new Error('실거래 계좌가 등록되지 않았습니다')

  const appKey = decrypt(account.app_key)
  const appSecret = decrypt(account.app_secret)
  const cano = decrypt(account.cano)
  const token = await getUserKisToken(userId, appKey, appSecret)

  const res = await axios.get(`${KIS_BASE_URL}/uapi/domestic-stock/v1/trading/inquire-balance`, {
    params: {
      CANO: cano,
      ACNT_PRDT_CD: account.acnt_prdt_cd,
      AFHR_FLPR_YN: 'N',
      OFL_YN: '',
      INQR_DVSN: '02',
      UNPR_DVSN: '01',
      FUND_STTL_ICLD_YN: 'N',
      FNCG_AMT_AUTO_RDPT_YN: 'N',
      PRCS_DVSN: '01',
      CTX_AREA_FK100: '',
      CTX_AREA_NK100: '',
    },
    headers: kisHeaders(token, appKey, appSecret, 'TTTC8434R'),
  })

  const summary = res.data.output2?.[0] ?? {}
  const holdings = (res.data.output1 ?? []).map((h: any) => ({
    stockCode: h.pdno,
    stockName: h.prdt_name,
    quantity: Number(h.hldg_qty),
    avgPrice: Number(h.pchs_avg_pric),
    currentPrice: Number(h.prpr),
    evalAmount: Number(h.evlu_amt),
    profitLoss: Number(h.evlu_pfls_amt),
    profitRate: Number(h.evlu_pfls_rt),
  }))

  return {
    buyableAmount: Number(summary.ord_psbl_cash ?? 0),
    totalEvalAmount: Number(summary.tot_evlu_amt ?? 0),
    totalPurchaseAmount: Number(summary.pchs_amt_smtl_amt ?? 0),
    totalProfitLoss: Number(summary.evlu_pfls_smtl_amt ?? 0),
    holdings,
  }
}

// ─── 주문 공통 ────────────────────────────────────────────────────

interface OrderParams {
  userId: number
  stockId: number
  stockCode: string
  side: 'buy' | 'sell'
  orderType: 'market' | 'limit'
  quantity: number
  price: number
  pin: string
  ipAddress: string
  country?: string
  region?: string
  city?: string
  userAgent?: string
}

const placeKisOrder = async (params: OrderParams) => {
  await verifyPin(params.userId, params.pin)

  const account = await RealAccount.findOne({ where: { user_id: params.userId, is_active: true } })
  if (!account) throw new Error('실거래 계좌가 등록되지 않았습니다')

  const appKey = decrypt(account.app_key)
  const appSecret = decrypt(account.app_secret)
  const cano = decrypt(account.cano)
  const token = await getUserKisToken(params.userId, appKey, appSecret)

  // 매수: TTTC0802U, 매도: TTTC0801U
  const trId = params.side === 'buy' ? 'TTTC0802U' : 'TTTC0801U'
  const ordDvsn = params.orderType === 'market' ? '01' : '00'
  const ordUnpr = params.orderType === 'market' ? '0' : String(Math.round(params.price))

  const kisRes = await axios.post(
    `${KIS_BASE_URL}/uapi/domestic-stock/v1/trading/order-cash`,
    {
      CANO: cano,
      ACNT_PRDT_CD: account.acnt_prdt_cd,
      PDNO: params.stockCode,
      ORD_DVSN: ordDvsn,
      ORD_QTY: String(params.quantity),
      ORD_UNPR: ordUnpr,
    },
    { headers: kisHeaders(token, appKey, appSecret, trId) },
  )

  if (kisRes.data.rt_cd !== '0') {
    throw new Error(kisRes.data.msg1 || 'KIS 주문 실패')
  }

  const kisOrderId: string = kisRes.data.output?.ODNO ?? ''
  const totalAmount = params.price * params.quantity

  const order = await RealOrder.create({
    user_id: params.userId,
    real_account_id: account.id,
    stock_id: params.stockId,
    kis_order_id: kisOrderId,
    order_type: params.orderType,
    side: params.side,
    quantity: params.quantity,
    price: params.price,
    total_amount: totalAmount,
    status: 'pending',
    ip_address: params.ipAddress,
    country: params.country,
    region: params.region,
    city: params.city,
    user_agent: params.userAgent,
    ordered_at: new Date(),
  })

  return { order, kisOrderId }
}

export const buyStock = (params: Omit<OrderParams, 'side'>) =>
  placeKisOrder({ ...params, side: 'buy' })

export const sellStock = (params: Omit<OrderParams, 'side'>) =>
  placeKisOrder({ ...params, side: 'sell' })

// ─── 거래내역 조회 (우리 DB) ─────────────────────────────────────

export const getOrders = async (userId: number) => {
  return RealOrder.findAll({
    where: { user_id: userId },
    order: [['ordered_at', 'DESC']],
    limit: 50,
  })
}
