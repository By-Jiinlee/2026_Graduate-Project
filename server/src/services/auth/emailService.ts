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

// 보안 경보(신규 기기·이상 탐지·기기 등록/해제)는 인증된 이메일로만 보낸다.
// 휴대폰 인증으로 가입하면 이메일은 로그인 아이디일 뿐 소유가 확인되지 않았다. 그 주소가 남의 것이면
// 로그인 IP·위치·기기가 담긴 경보가 제3자에게 가고, 남의 주소로 가입해 메일 폭탄을 보내는 데 쓰일 수도 있다.
// 계정이 아닌 주소(관리자 경보 수신 주소 등)는 그대로 보낸다. 인증코드 메일(sendVerificationEmail)은 대상이 아니다.
export const isAlertRecipientVerified = async (to: string): Promise<boolean> => {
  try {
    const { default: User } = await import('../../models/user/User')
    const user = await User.findOne({ where: { email: to }, attributes: ['is_email_verified'] })
    return !user || Boolean(user.is_email_verified)
  } catch {
    return true
  }
}

const sendSecurityAlert = async (mail: Parameters<typeof transporter.sendMail>[0]): Promise<void> => {
  const to = mail.to ? String(mail.to) : ''
  // 이메일이 없는 계정(휴대폰 가입) — 보낼 곳이 없다
  if (!to) return
  if (!(await isAlertRecipientVerified(to))) {
    console.info('[Email] 미인증 이메일 계정이라 보안 경보 메일을 보내지 않음')
    return
  }
  await transporter.sendMail(mail)
}

export const sendVerificationEmail = async (
  email: string,
  code: string,
): Promise<void> => {
  await transporter.sendMail({
    from: `"UpTick" <${process.env.EMAIL_USER}>`,
    to: email ?? undefined,
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
  email: string | null,
  label: string,
  ip: string,
  loginAt: Date,
): Promise<void> => {
  const timeStr = loginAt.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
  await sendSecurityAlert({
    from: `"UpTick" <${process.env.EMAIL_USER}>`,
    to: email ?? undefined,
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
  email: string | null,
  label: string,
  ip: string,
): Promise<void> => {
  const timeStr = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
  await sendSecurityAlert({
    from: `"UpTick" <${process.env.EMAIL_USER}>`,
    to: email ?? undefined,
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
  email: string | null,
  label: string,
): Promise<void> => {
  const timeStr = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
  await sendSecurityAlert({
    from: `"UpTick" <${process.env.EMAIL_USER}>`,
    to: email ?? undefined,
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
  email: string | null,
  ctx: {
    reasons: string[]
    ip: string
    location: string
    userAgent: string
  },
): Promise<void> => {
  const timeStr = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })

  await sendSecurityAlert({
    from: `"UpTick" <${process.env.EMAIL_USER}>`,
    to: email ?? undefined,
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