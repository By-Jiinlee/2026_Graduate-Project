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

// 미등록 기기 로그인 알림
export const sendNewDeviceAlert = async (
  email: string,
  label: string,
  ip: string,
  loginAt: Date,
): Promise<void> => {
  const timeStr = loginAt.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
  await transporter.sendMail({
    from: `"UpTick" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: '[UpTick] 새로운 기기에서 로그인되었습니다',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #1a1a2e;">새로운 기기 로그인 감지</h2>
        <p>회원님의 계정에 새로운 기기에서 로그인이 감지되었습니다.</p>
        <div style="background: #f4f4f4; border-radius: 8px; padding: 16px; margin: 20px 0;">
          <p style="margin: 4px 0;"><strong>기기:</strong> ${label}</p>
          <p style="margin: 4px 0;"><strong>IP:</strong> ${ip}</p>
          <p style="margin: 4px 0;"><strong>시각:</strong> ${timeStr}</p>
        </div>
        <p style="color: #888; font-size: 13px;">본인이 로그인한 경우 이 메일을 무시해주세요. 본인이 아니라면 즉시 비밀번호를 변경해주세요.</p>
      </div>
    `,
  })
}

// 신뢰 기기 등록 알림
export const sendDeviceRegisteredAlert = async (
  email: string,
  label: string,
  ip: string,
): Promise<void> => {
  const timeStr = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
  await transporter.sendMail({
    from: `"UpTick" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: '[UpTick] 새로운 신뢰 기기가 등록되었습니다',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #1a1a2e;">신뢰 기기 등록</h2>
        <p>아래 기기가 신뢰 기기로 등록되었습니다.</p>
        <div style="background: #f4f4f4; border-radius: 8px; padding: 16px; margin: 20px 0;">
          <p style="margin: 4px 0;"><strong>기기:</strong> ${label}</p>
          <p style="margin: 4px 0;"><strong>IP:</strong> ${ip}</p>
          <p style="margin: 4px 0;"><strong>시각:</strong> ${timeStr}</p>
        </div>
        <p style="color: #888; font-size: 13px;">본인이 등록하지 않았다면 즉시 비밀번호를 변경하고 마이페이지에서 기기를 삭제해주세요.</p>
      </div>
    `,
  })
}

// 신뢰 기기 삭제 알림
export const sendDeviceRevokedAlert = async (
  email: string,
  label: string,
): Promise<void> => {
  const timeStr = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
  await transporter.sendMail({
    from: `"UpTick" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: '[UpTick] 신뢰 기기가 삭제되었습니다',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #1a1a2e;">신뢰 기기 삭제</h2>
        <p>아래 기기가 신뢰 기기에서 삭제되었습니다.</p>
        <div style="background: #f4f4f4; border-radius: 8px; padding: 16px; margin: 20px 0;">
          <p style="margin: 4px 0;"><strong>기기:</strong> ${label}</p>
          <p style="margin: 4px 0;"><strong>시각:</strong> ${timeStr}</p>
        </div>
        <p style="color: #888; font-size: 13px;">본인이 삭제하지 않았다면 즉시 비밀번호를 변경해주세요.</p>
      </div>
    `,
  })
}


// 이상 로그인 시도 감지 알림
export const sendAnomalyAlertEmail = async (
  email: string,
  ctx: {
    reasons: string[]
    ip: string
    location: string
    userAgent: string
  },
): Promise<void> => {
  const timeStr = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })

  await transporter.sendMail({
    from: `"UpTick" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: '[UpTick] 비정상 로그인 시도가 감지되었습니다',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto;">
        <h2 style="color: #e53935;">⚠️ 보안 알림</h2>
        <p>회원님의 계정에서 비정상적인 접근이 감지되었습니다.</p>

        <div style="background: #fff3f3; border-left: 4px solid #e53935; border-radius: 4px; padding: 16px; margin: 20px 0;">
          <p style="margin: 0 0 8px 0; font-weight: bold; color: #c62828;">감지된 항목</p>
          ${ctx.reasons.map(r => `<p style="margin: 4px 0; color: #555;">• ${r}</p>`).join('')}
        </div>

        <div style="background: #f5f5f5; border-radius: 8px; padding: 16px; margin: 16px 0;">
          <p style="margin: 0 0 10px 0; font-weight: bold; color: #333;">접속 정보</p>
          <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
            <tr>
              <td style="padding: 5px 0; color: #888; width: 80px;">IP 주소</td>
              <td style="padding: 5px 0; color: #333; font-family: monospace;">${ctx.ip}</td>
            </tr>
            <tr>
              <td style="padding: 5px 0; color: #888;">위치</td>
              <td style="padding: 5px 0; color: #333;">${ctx.location}</td>
            </tr>
            <tr>
              <td style="padding: 5px 0; color: #888;">감지 시각</td>
              <td style="padding: 5px 0; color: #333;">${timeStr}</td>
            </tr>
            <tr>
              <td style="padding: 5px 0; color: #888; vertical-align: top;">브라우저</td>
              <td style="padding: 5px 0; color: #555; font-size: 11px; word-break: break-all;">${ctx.userAgent}</td>
            </tr>
          </table>
        </div>

        <p style="color: #888; font-size: 13px; margin-top: 16px;">
          본인이 맞다면 이 메일을 무시해주세요.<br>
          본인이 아니라면 즉시 비밀번호를 변경하고 로그아웃해주세요.
        </p>
      </div>
    `,
  })
}