import { Request, Response, NextFunction } from 'express'

const isValidEmail = (email: string): boolean => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return emailRegex.test(email)
}

const isValidPassword = (password: string): boolean => {
  const passwordRegex = /^(?=.*[a-zA-Z])(?=.*[0-9])(?=.*[!@#$%^&*])[a-zA-Z0-9!@#$%^&*]{8,}$/
  return passwordRegex.test(password)
}

const isValidWalletAddress = (address: string): boolean => {
  const walletRegex = /^0x[a-fA-F0-9]{40}$/
  return walletRegex.test(address)
}

const isValidPhone = (phone: string): boolean => {
  const phoneRegex = /^01[016789][0-9]{7,8}$/
  return phoneRegex.test(phone)
}

const isValidSignature = (signature: string): boolean => {
  const sigRegex = /^0x[a-fA-F0-9]{130}$/
  return sigRegex.test(signature)
}

const hasXss = (...values: string[]): boolean => {
  const xssRegex = /<script|javascript:|on\w+=/i
  return values.some((v) => xssRegex.test(v))
}

const hasSqlInjection = (...values: string[]): boolean => {
  const sqlRegex = /('|"|;|--|\/\*|\*\/|xp_)/i
  return values.some((v) => sqlRegex.test(v))
}

// ─── 회원가입 ─────────────────────────────────────────────────

export const validateRegister = (req: Request, res: Response, next: NextFunction) => {
  const {
    email, password, name, phone, walletAddress, walletSignature,
    terms_agreed, privacy_agreed, location_agreed, age_agreed,
  } = req.body

  if (!email || !password || !name || !phone || !walletAddress || !walletSignature) {
    return res.status(400).json({ message: '필수 항목을 모두 입력해주세요' })
  }

  if (!terms_agreed) {
    return res.status(400).json({ message: '서비스 이용약관에 동의해주세요' })
  }
  if (!privacy_agreed) {
    return res.status(400).json({ message: '개인정보 수집 및 이용에 동의해주세요' })
  }
  if (!location_agreed) {
    return res.status(400).json({ message: '위치정보 수집에 동의해주세요' })
  }
  if (!age_agreed) {
    return res.status(400).json({ message: '만 14세 이상 확인에 동의해주세요' })
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({ message: '이메일 형식이 올바르지 않습니다' })
  }
  if (!isValidPassword(password)) {
    return res.status(400).json({ message: '비밀번호는 8자 이상, 영문+숫자+특수문자를 포함해야 합니다' })
  }
  if (name.length < 2 || name.length > 50) {
    return res.status(400).json({ message: '이름은 2자 이상 50자 이하로 입력해주세요' })
  }
  if (!isValidPhone(phone)) {
    return res.status(400).json({ message: '올바른 휴대폰 번호를 입력해주세요' })
  }
  if (!isValidWalletAddress(walletAddress)) {
    return res.status(400).json({ message: '올바른 MetaMask 지갑 주소를 입력해주세요' })
  }
  if (!isValidSignature(walletSignature)) {
    return res.status(400).json({ message: '올바른 지갑 서명값이 아닙니다' })
  }
  if (hasXss(email, name)) {
    return res.status(400).json({ message: '올바르지 않은 입력값입니다' })
  }
  if (hasSqlInjection(email, password, name)) {
    return res.status(400).json({ message: '올바르지 않은 입력값입니다' })
  }

  next()
}

// ─── 로그인 1단계 ─────────────────────────────────────────────

export const validateLoginStep1 = (req: Request, res: Response, next: NextFunction) => {
  const { email, password } = req.body

  if (!email || !password) {
    return res.status(400).json({ message: '이메일과 비밀번호를 입력해주세요' })
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ message: '이메일 형식이 올바르지 않습니다' })
  }
  if (hasSqlInjection(email, password)) {
    return res.status(400).json({ message: '올바르지 않은 입력값입니다' })
  }
  if (hasXss(email)) {
    return res.status(400).json({ message: '올바르지 않은 입력값입니다' })
  }

  next()
}

// ─── 로그인 2단계 ─────────────────────────────────────────────

export const validateLoginStep2 = (req: Request, res: Response, next: NextFunction) => {
  const { userId, walletAddress, signature } = req.body

  if (!userId || !walletAddress || !signature) {
    return res.status(400).json({ message: '필수 항목을 모두 입력해주세요' })
  }
  if (typeof userId !== 'number' || userId <= 0) {
    return res.status(400).json({ message: '올바르지 않은 사용자 정보입니다' })
  }
  if (!isValidWalletAddress(walletAddress)) {
    return res.status(400).json({ message: '올바른 지갑 주소를 입력해주세요' })
  }
  if (!isValidSignature(signature)) {
    return res.status(400).json({ message: '올바른 서명값이 아닙니다' })
  }

  next()
}

// ─── 이메일 인증 ──────────────────────────────────────────────

export const validateEmailCode = (req: Request, res: Response, next: NextFunction) => {
  const { email, code } = req.body

  if (!email) {
    return res.status(400).json({ message: '이메일을 입력해주세요' })
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ message: '이메일 형식이 올바르지 않습니다' })
  }
  if (req.path.includes('verify')) {
    if (!code) {
      return res.status(400).json({ message: '인증코드를 입력해주세요' })
    }
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ message: '인증코드는 6자리 숫자입니다' })
    }
  }
  if (hasXss(email)) {
    return res.status(400).json({ message: '올바르지 않은 입력값입니다' })
  }

  next()
}

// ─── SMS 인증 ─────────────────────────────────────────────────

export const validateSmsCode = (req: Request, res: Response, next: NextFunction) => {
  const { phone, code } = req.body

  if (!phone) {
    return res.status(400).json({ message: '휴대폰 번호를 입력해주세요' })
  }
  if (!isValidPhone(phone)) {
    return res.status(400).json({ message: '올바른 휴대폰 번호를 입력해주세요' })
  }
  if (req.path.includes('verify')) {
    if (!code) {
      return res.status(400).json({ message: '인증코드를 입력해주세요' })
    }
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ message: '인증코드는 6자리 숫자입니다' })
    }
  }

  next()
}