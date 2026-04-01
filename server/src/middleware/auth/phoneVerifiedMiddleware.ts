import { Request, Response, NextFunction } from 'express'
import User from '../../models/user/User'

export const requirePhoneVerified = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user.id
    const user = await User.findByPk(userId)

    if (!user || !user.is_phone_verified) {
      return res.status(403).json({
        message: '서비스 이용을 위해 휴대폰 인증이 필요합니다',
        code: 'PHONE_VERIFICATION_REQUIRED',
      })
    }

    next()
  } catch (error: any) {
    return res.status(500).json({ message: error.message })
  }
}