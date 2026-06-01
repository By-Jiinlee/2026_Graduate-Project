const API_KEY = process.env.ABUSEIPDB_API_KEY
const BLOCK_THRESHOLD = 80

function isPrivateIp(ip: string): boolean {
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  )
}

export interface AbuseCheckResult {
  isAbusive: boolean
  score: number
}

export async function checkIPAbuse(ip: string): Promise<AbuseCheckResult> {
  if (!API_KEY || isPrivateIp(ip)) return { isAbusive: false, score: 0 }

  try {
    const res = await fetch(
      `https://api.abuseipdb.com/api/v2/check?ipAddress=${encodeURIComponent(ip)}&maxAgeInDays=90`,
      {
        headers: {
          Key: API_KEY,
          Accept: 'application/json',
        },
      },
    )
    if (!res.ok) return { isAbusive: false, score: 0 }

    const json = (await res.json()) as { data: { abuseConfidenceScore: number } }
    const score = json.data.abuseConfidenceScore
    return { isAbusive: score >= BLOCK_THRESHOLD, score }
  } catch {
    return { isAbusive: false, score: 0 }
  }
}
