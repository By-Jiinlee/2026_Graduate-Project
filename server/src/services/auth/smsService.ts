import coolsms from 'coolsms-node-sdk'

const messageService = new coolsms(
  process.env.COOLSMS_API_KEY as string,
  process.env.COOLSMS_API_SECRET as string,
)

export interface SmsService {
  sendVerificationCode(phone: string, code: string): Promise<void>
}

export const sendVerificationSms = async (
  phone: string,
  code: string,
): Promise<void> => {
  await messageService.sendOne({
    to: phone,
    from: process.env.COOLSMS_SENDER as string,
    text: `[UpTick] 인증번호 ${code}를 입력해주세요. (5분 이내)`,
    autoTypeDetect: true,
  })
}