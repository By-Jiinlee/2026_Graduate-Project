import { Request } from 'express'

export const getClientIp = (req: Request): string => {
  const forwarded = req.headers['x-forwarded-for']
  if (forwarded) {
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0]
    return first.trim()
  }
  return req.socket.remoteAddress ?? '0.0.0.0'
}
