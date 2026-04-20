import axios from 'axios'
import fs from 'fs'
import path from 'path'

const APP_KEY = process.env.KIS_REAL_APP_KEY!
const APP_SECRET = process.env.KIS_REAL_APP_SECRET!
const BASE_URL = 'https://openapi.koreainvestment.com:9443'
const TOKEN_CACHE_PATH = path.join(__dirname, '../../../cache/kisToken.json')

let cachedToken: string | null = null
let tokenExpiresAt: number = 0

const loadTokenFromFile = () => {
    try {
        if (!fs.existsSync(TOKEN_CACHE_PATH)) return
        const { token, expiresAt } = JSON.parse(fs.readFileSync(TOKEN_CACHE_PATH, 'utf-8'))
        if (token && expiresAt && Date.now() < expiresAt - 10 * 60 * 1000) {
            cachedToken = token
            tokenExpiresAt = expiresAt
            console.log('[KisAuth] 파일 캐시에서 토큰 복원')
        }
    } catch {}
}

const saveTokenToFile = (token: string, expiresAt: number) => {
    try {
        const dir = path.dirname(TOKEN_CACHE_PATH)
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(TOKEN_CACHE_PATH, JSON.stringify({ token, expiresAt }), 'utf-8')
    } catch {}
}

loadTokenFromFile()

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
    saveTokenToFile(cachedToken!, tokenExpiresAt)
    console.log('[KisAuth] OAuth 토큰 발급 완료')
    return cachedToken!
}