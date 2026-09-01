import axios from 'axios'

const KIS_BASE_URL = 'https://openapi.koreainvestment.com:9443'

const tokenCache = new Map<number, { token: string; expiresAt: number }>()

export const getUserKisToken = async (
  userId: number,
  appKey: string,
  appSecret: string,
): Promise<string> => {
  const cached = tokenCache.get(userId)
  if (cached && Date.now() < cached.expiresAt - 10 * 60 * 1000) {
    return cached.token
  }

  const res = await axios.post(
    `${KIS_BASE_URL}/oauth2/tokenP`,
    { grant_type: 'client_credentials', appkey: appKey, appsecret: appSecret },
    { headers: { 'content-type': 'application/json' } },
  )

  const token: string = res.data.access_token
  const expiresAt = Date.now() + res.data.expires_in * 1000
  tokenCache.set(userId, { token, expiresAt })
  console.log(`[KisUserAuth] user ${userId} 토큰 발급 완료`)
  return token
}

export const clearUserToken = (userId: number) => {
  tokenCache.delete(userId)
}
