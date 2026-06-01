import { Request, Response, NextFunction } from 'express'

// 인메모리 IP 차단 목록 (서버 재시작 시 초기화됨)
export const blockedIPs = new Set<string>()

export function blockIP(ip: string): void {
  blockedIPs.add(ip)
  console.warn(`[Security] IP 차단 추가: ${ip}`)
}

function isPrivateIp(ip: string): boolean {
  return (
    ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' ||
    ip.startsWith('10.') || ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  )
}

export function ipBlockMiddleware(req: Request, res: Response, next: NextFunction): void {
  const ip =
    (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'unknown'

  if (!isPrivateIp(ip) && blockedIPs.has(ip)) {
    res.status(403).json({ message: '접근이 차단되었습니다.' })
    return
  }
  next()
}
