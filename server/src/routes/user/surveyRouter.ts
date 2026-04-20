import { Router, Request, Response } from 'express'
import { isAuthenticated } from '../../middleware/auth/authMiddleware'
import sequelize from '../../config/database'
import User from '../../models/user/User'
import SurveyResponse from '../../models/user/SurveyResponse'

const router = Router()
router.use(isAuthenticated)

// POST /api/survey/complete
router.post('/complete', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id
    if (!userId) return res.status(401).json({ message: '인증 필요' })

    const { responses, investment_type_id } = req.body
    // responses: [{ question_num: 1, selected_option: 2 }, ...]

    if (!Array.isArray(responses) || responses.length === 0)
      return res.status(400).json({ message: '응답 데이터가 없습니다' })

    if (!investment_type_id)
      return res.status(400).json({ message: '투자 유형이 없습니다' })

    await sequelize.transaction(async (t) => {
      // 기존 응답 삭제 (재설문 시)
      await SurveyResponse.destroy({ where: { user_id: userId }, transaction: t })

      // 응답 일괄 저장
      await SurveyResponse.bulkCreate(
        responses.map((r: { question_num: number; selected_option: number }) => ({
          user_id: userId,
          question_num: r.question_num,
          selected_option: r.selected_option,
        })),
        { transaction: t },
      )

      // 유저 업데이트
      await User.update(
        { is_survey_completed: true, investment_type_id },
        { where: { id: userId }, transaction: t },
      )
    })

    return res.status(200).json({ message: '설문 완료' })
  } catch (error: any) {
    return res.status(500).json({ message: error.message })
  }
})

export default router
