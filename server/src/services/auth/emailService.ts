import nodemailer from 'nodemailer'
import dotenv from 'dotenv'
dotenv.config()

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER as string,
    pass: process.env.EMAIL_APP_PASSWORD as string,
  },
})

export const sendVerificationEmail = async (
  email: string,
  code: string,
): Promise<void> => {
  await transporter.sendMail({
    from: `"UpTick" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: '[UpTick] 이메일 인증코드',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #1a1a2e;">UpTick 이메일 인증</h2>
        <p>아래 인증코드를 입력해주세요. 인증코드는 <strong>5분간</strong> 유효합니다.</p>
        <div style="
          font-size: 32px;
          font-weight: bold;
          letter-spacing: 8px;
          text-align: center;
          padding: 20px;
          background: #f4f4f4;
          border-radius: 8px;
          margin: 24px 0;
        ">
          ${code}
        </div>
        <p style="color: #888; font-size: 13px;">본인이 요청하지 않은 경우 이 이메일을 무시해주세요.</p>
      </div>
    `,
  })
}