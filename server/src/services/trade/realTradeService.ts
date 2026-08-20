import axios from 'axios'
import crypto from 'crypto'
import RealAccount from '../../models/trade/RealAccount'
import RealOrder from '../../models/trade/RealOrder'
import { getUserKisToken, clearUserToken } from '../market/KisUserAuth'
import { verifyPin } from './virtualTradeService'
import { evaluateTradeRequest } from '../auth/tradeAnomalyService'
import { decryptField, encryptField } from '../auth/fieldCrypto'

const KIS_BASE_URL = 'https://openapi.koreainvestment.com:9443'

// ─── 암호화 ───────────────────────────────────────────────────────
// 실제 암복호는 fieldCrypto(AES-256-GCM)가 담당한다. 여기서는 "어느 행의 어느 컬럼"
// 인지를 AAD 로 묶어 넘기는 얇은 래퍼만 둔다 — 암호문을 다른 컬럼이나 다른 사용자
// 행으로 옮겨 붙이는 재배치 공격을 복호 단계에서 실패시키기 위함이다.
// 레거시(CBC) 암호문은 fieldCrypto 가 하위호환으로 읽는다.

export const REAL_ACCOUNT_TABLE = 'real_accounts'
export type RealAccountSecret = 'app_key' | 'app_secret' | 'cano'

const ctxOf = (userId: number, column: RealAccountSecret) => ({
  table: REAL_ACCOUNT_TABLE,
  column,
  ownerId: userId,
})

const encrypt = (userId: number, column: RealAccountSecret, text: string): string =>
  encryptField(text, ctxOf(userId, column))

const decrypt = (userId: number, column: RealAccountSecret, text: string): string =>
  decryptField(text, ctxOf(userId, column))

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
      app_key: encrypt(userId, 'app_key', appKey),
      app_secret: encrypt(userId, 'app_secret', appSecret),
      cano: encrypt(userId, 'cano', cano),
      acnt_prdt_cd: acntPrdtCd,
      is_active: true,
    })
  } else {
    await RealAccount.create({
      user_id: userId,
      app_key: encrypt(userId, 'app_key', appKey),
      app_secret: encrypt(userId, 'app_secret', appSecret),
      cano: encrypt(userId, 'cano', cano),
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

  const cano = decrypt(userId, 'cano', account.cano)
  const maskedCano = cano.slice(0, 2) + '******'

  try {
    const appKey = decrypt(userId, 'app_key', account.app_key)
    const appSecret = decrypt(userId, 'app_secret', account.app_secret)
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

  const appKey = decrypt(userId, 'app_key', account.app_key)
  const appSecret = decrypt(userId, 'app_secret', account.app_secret)
  const cano = decrypt(userId, 'cano', account.cano)
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
  // PIN 검증 결과를 기록해야 "반복 실패 후 성공"(M-5)을 판정할 수 있으므로 문맥을 넘긴다.
  await verifyPin(params.userId, params.pin, {
    ip: params.ipAddress,
    userAgent: params.userAgent,
  })

  // M-1 거래 이상탐지 — PIN 확인 직후, 외부(KIS) 주문 전송 전에 판정한다.
  // 실계좌는 지갑 서명 재인증 경로가 없어(stepUpAvailable=false) 통계 이탈은
  // 기록·경보로 남기고, 정상 클라이언트가 만들 수 없는 무결성 위반만 중단시킨다.
  // 평가액은 KIS 잔고 조회 비용 때문에 넘기지 않는다 → 비율 규칙 대신 개인 베이스라인만 사용.
  const assessment = await evaluateTradeRequest({
    userId: params.userId,
    ip: params.ipAddress,
    userAgent: params.userAgent,
    market: 'real',
    side: params.side,
    stockCode: params.stockCode,
    quantity: params.quantity,
    price: params.price,
    hasSignature: false,
    stepUpAvailable: false,
  })
  if (assessment.verdict === 'BLOCK') throw new Error(assessment.userMessage)

  const account = await RealAccount.findOne({ where: { user_id: params.userId, is_active: true } })
  if (!account) throw new Error('실거래 계좌가 등록되지 않았습니다')

  const appKey = decrypt(params.userId, 'app_key', account.app_key)
  const appSecret = decrypt(params.userId, 'app_secret', account.app_secret)
  const cano = decrypt(params.userId, 'cano', account.cano)
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
