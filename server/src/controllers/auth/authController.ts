import { Request, Response } from 'express'
import * as authService from '../../services/auth/authService'

// 회원가입
export const register = async (req: Request, res: Response) => {
  try {
    const { email, password, name, phone, walletAddress } = req.body

    // 지갑 주소 필수 확인
    if (!walletAddress) {
      return res
        .status(400)
        .json({ message: 'MetaMask 지갑 연결이 필요합니다' })
    }

    const user = await authService.register(
      email,
      password,
      name,
      phone,
      walletAddress,
    )

    return res.status(201).json({
      message: '회원가입이 완료되었습니다',
      userId: user.id,
    })
  } catch (error: any) {
    return res.status(400).json({ message: error.message })
  }
}

// 로그인
export const login = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body

    const { user, accessToken, refreshToken, walletAddress } =
      await authService.login(email, password)

    // 쿠키에 토큰 저장
    res.cookie('accessToken', accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 1000 * 60 * 60, // 1시간
    })

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7일
    })

    return res.status(200).json({
      message: '로그인 성공',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        walletAddress,
      },
    })
  } catch (error: any) {
    return res.status(400).json({ message: error.message })
  }
}

// 로그아웃
export const logout = async (req: Request, res: Response) => {
  try {
    res.clearCookie('accessToken')
    res.clearCookie('refreshToken')

    return res.status(200).json({ message: '로그아웃 되었습니다' })
  } catch (error: any) {
    return res.status(500).json({ message: error.message })
  }
}

// 탈퇴
export const withdraw = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id

    await authService.withdraw(userId)

    res.clearCookie('accessToken')
    res.clearCookie('refreshToken')

    return res.status(200).json({ message: '탈퇴가 완료되었습니다' })
  } catch (error: any) {
    return res.status(400).json({ message: error.message })
  }
}

// 토큰 갱신
export const refreshToken = async (req: Request, res: Response) => {
  try {
    const token = req.cookies.refreshToken
    if (!token) return res.status(401).json({ message: '토큰이 없습니다' })

    const decoded = authService.verifyRefreshToken(token) as any

    const accessToken = require('jsonwebtoken').sign(
      { id: decoded.id },
      process.env.JWT_SECRET as string,
      { expiresIn: '1h' },
    )

    res.cookie('accessToken', accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 1000 * 60 * 60,
    })

    return res.status(200).json({ message: '토큰이 갱신되었습니다' })
  } catch (error: any) {
    return res.status(401).json({ message: '유효하지 않은 토큰입니다' })
  }
}
