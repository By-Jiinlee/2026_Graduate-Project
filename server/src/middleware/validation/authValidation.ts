import { Request, Response, NextFunction } from 'express'

// 이메일 형식 검사
const isValidEmail = (email: string): boolean => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return emailRegex.test(email)
}

// 비밀번호 형식 검사 (8자 이상, 영문+숫자+특수문자)
const isValidPassword = (password: string): boolean => {
  const passwordRegex =
    /^(?=.*[a-zA-Z])(?=.*[0-9])(?=.*[!@#$%^&*])[a-zA-Z0-9!@#$%^&*]{8,}$/
  return passwordRegex.test(password)
}

// 지갑 주소 형식 검사
const isValidWalletAddress = (address: string): boolean => {
  const walletRegex = /^0x[a-fA-F0-9]{40}$/
  return walletRegex.test(address)
}

// 회원가입 유효성 검사
export const validateRegister = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const { email, password, name, phone, walletAddress } = req.body

  if (!email || !password || !name || !walletAddress) {
    return res.status(400).json({ message: '필수 항목을 모두 입력해주세요' })
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({ message: '이메일 형식이 올바르지 않습니다' })
  }

  if (!isValidPassword(password)) {
    return res
      .status(400)
      .json({
        message: '비밀번호는 8자 이상, 영문+숫자+특수문자를 포함해야 합니다',
      })
  }

  if (name.length < 2 || name.length > 50) {
    return res
      .status(400)
      .json({ message: '이름은 2자 이상 50자 이하로 입력해주세요' })
  }

  if (!isValidWalletAddress(walletAddress)) {
    return res
      .status(400)
      .json({ message: '올바른 MetaMask 지갑 주소를 입력해주세요' })
  }

  // XSS 방어 - 공격 문자열 탐지
  const xssRegex = /<script|javascript:|on\w+=/i
  if (xssRegex.test(email) || xssRegex.test(name)) {
    return res.status(400).json({ message: '올바르지 않은 입력값입니다' })
  }

  next()
}

// 로그인 유효성 검사
export const validateLogin = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const { email, password } = req.body

  if (!email || !password) {
    return res.status(400).json({ message: '이메일과 비밀번호를 입력해주세요' })
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({ message: '이메일 형식이 올바르지 않습니다' })
  }

  // SQL Injection 방어
  const sqlRegex = /('|"|;|--|\/\*|\*\/|xp_)/i
  if (sqlRegex.test(email) || sqlRegex.test(password)) {
    return res.status(400).json({ message: '올바르지 않은 입력값입니다' })
  }

  next()
}
