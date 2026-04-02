import axios from 'axios'

const APP_KEY = process.env.KIS_REAL_APP_KEY!
const APP_SECRET = process.env.KIS_REAL_APP_SECRET!
const BASE_URL = 'https://openapi.koreainvestment.com:9443'

let cachedToken: string | null = null
let tokenExpiresAt: number = 0

export const getKisAccessToken = async (): Promise<string> => {
    if (cachedToken && Date.now() < tokenExpiresAt - 10 * 60 * 1000) {
        return cachedToken
    }

    const res = await axios.post(
        `${BASE_URL}/oauth2/tokenP`,
        {
            grant_type: 'client_credentials',
            appkey: APP_KEY,
            appsecret: APP_SECRET,
        },
        { headers: { 'content-type': 'application/json' } }
    )

    cachedToken = res.data.access_token
    tokenExpiresAt = Date.now() + res.data.expires_in * 1000
    console.log('[KisAuth] OAuth 토큰 발급 완료')
    return cachedToken!
}