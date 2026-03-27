import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import * as authService from '../../services/auth/authService'
import User from '../../models/user/User'

// 로그인 확인 미들웨어
export const isAuthenticated = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const token = req.cookies.accessToken
    if (!token) return res.status(401).json({ message: '로그인이 필요합니다' })

    const decoded = authService.verifyAccessToken(token) as any

    const user = await User.findByPk(decoded.id)
    if (!user) return res.status(401).json({ message: '유저를 찾을 수 없습니다' })
    if (user.status === 'withdrawn') return res.status(401).json({ message: '탈퇴한 계정입니다' })
    if (user.is_locked) return res.status(403).json({ message: '계정이 잠겼습니다' })

    ;(req as any).user = user
    next()
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return res.status(401).json({ message: '토큰이 만료되었습니다' })
    }
    return res.status(401).json({ message: '유효하지 않은 토큰입니다' })
  }
}

// 관리자 확인 미들웨어
export const isAdmin = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const user = (req as any).user
    if (!user) return res.status(401).json({ message: '로그인이 필요합니다' })
    if (user.role !== 'admin') return res.status(403).json({ message: '관리자 권한이 필요합니다' })
    next()
  } catch (error) {
    return res.status(403).json({ message: '접근 권한이 없습니다' })
  }
}

// IDOR 방어 미들웨어
export const isSameUser = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const user = (req as any).user
    const targetId = Number(req.params.userId)

    if (user.id !== targetId && user.role !== 'admin') {
      return res.status(403).json({ message: '접근 권한이 없습니다' })
    }
    next()
  } catch (error) {
    return res.status(403).json({ message: '접근 권한이 없습니다' })
  }
}