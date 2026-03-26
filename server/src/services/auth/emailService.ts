import nodemailer from 'nodemailer'
import dotenv from 'dotenv'
dotenv.config()

// 이메일 발송 설정
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
})

// 6자리 인증번호 생성
export const generateVerificationCode = (): string => {
  return Math.floor(100000 + Math.random() * 900000).toString()
}

// 인증번호 발송
export const sendVerificationEmail = async (
  to: string,
  code: string,
): Promise<void> => {
  const mailOptions = {
    from: `UpTick <${process.env.EMAIL_USER}>`,
    to,
    subject: '[UpTick] 이메일 인증번호',
    html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #333;">UpTick 이메일 인증</h2>
                <p>아래 인증번호를 입력해주세요.</p>
                <div style="background-color: #f4f4f4; padding: 20px; text-align: center; border-radius: 8px;">
                    <h1 style="color: #4CAF50; letter-spacing: 8px;">${code}</h1>
                </div>
                <p style="color: #999; font-size: 12px;">인증번호는 5분간 유효합니다.</p>
                <p style="color: #999; font-size: 12px;">본인이 요청하지 않은 경우 이 이메일을 무시하세요.</p>
            </div>
        `,
  }

  await transporter.sendMail(mailOptions)
}
