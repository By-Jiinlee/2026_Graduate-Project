import { Router, Request, Response } from 'express'
import { isAuthenticated } from '../../middleware/auth/authMiddleware'
import UserFavorite from '../../models/user/UserFavorite'
import User from '../../models/user/User'

const router = Router()
router.use(isAuthenticated)

// ── 관심종목 ────────────────────────────────────────────────────────

// GET /api/user/favorites
router.get('/favorites', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id
    const rows = await UserFavorite.findAll({
      where: { user_id: userId },
      order: [['order_index', 'ASC']],
    })
    return res.json({ stock_ids: rows.map((r) => Number(r.stock_id)) })
  } catch (e: any) {
    // 테이블 미생성 시 빈 배열 반환
    if (e?.parent?.code === 'ER_NO_SUCH_TABLE') return res.json({ stock_ids: [] })
    return res.status(500).json({ message: e.message })
  }
})

// POST /api/user/favorites  body: { stock_id }
router.post('/favorites', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id
    const { stock_id } = req.body
    if (!stock_id) return res.status(400).json({ message: 'stock_id 필요' })

    const exists = await UserFavorite.findOne({ where: { user_id: userId, stock_id } })
    if (exists) return res.status(409).json({ message: '이미 관심종목입니다' })

    const lastRow = await UserFavorite.findOne({
      where: { user_id: userId },
      order: [['order_index', 'DESC']],
    })
    const nextIndex = lastRow ? lastRow.order_index + 1 : 0
    await UserFavorite.create({ user_id: userId, stock_id, order_index: nextIndex })
    return res.status(201).json({ message: '관심종목 추가됨' })
  } catch (e: any) {
    if (e?.parent?.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ message: 'DB 준비 중입니다' })
    return res.status(500).json({ message: e.message })
  }
})

// DELETE /api/user/favorites/:stockId
router.delete('/favorites/:stockId', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id
    const stockId = Number(req.params.stockId)
    await UserFavorite.destroy({ where: { user_id: userId, stock_id: stockId } })
    return res.json({ message: '삭제됨' })
  } catch (e: any) {
    if (e?.parent?.code === 'ER_NO_SUCH_TABLE') return res.json({ message: '삭제됨' })
    return res.status(500).json({ message: e.message })
  }
})

// PUT /api/user/favorites/reorder  body: { stock_ids: number[] }
router.put('/favorites/reorder', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id
    const { stock_ids } = req.body
    if (!Array.isArray(stock_ids)) return res.status(400).json({ message: 'stock_ids 배열 필요' })

    await Promise.all(
      stock_ids.map((id: number, idx: number) =>
        UserFavorite.update({ order_index: idx }, { where: { user_id: userId, stock_id: id } }),
      ),
    )
    return res.json({ message: '순서 저장됨' })
  } catch (e: any) {
    if (e?.parent?.code === 'ER_NO_SUCH_TABLE') return res.json({ message: '순서 저장됨' })
    return res.status(500).json({ message: e.message })
  }
})

// ── 프로필 이미지 ────────────────────────────────────────────────────

// GET /api/user/profile-image
router.get('/profile-image', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id
    const user = await User.findOne({ where: { id: userId }, attributes: ['profile_image_url'] })
    return res.json({ imageUrl: user?.profile_image_url ?? null })
  } catch (e: any) {
    return res.status(500).json({ message: e.message })
  }
})

// POST /api/user/profile-image  body: { imageBase64: string, mimeType: string }
router.post('/profile-image', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id
    const { imageBase64, mimeType } = req.body
    if (!imageBase64 || !mimeType) return res.status(400).json({ message: 'imageBase64, mimeType 필요' })

    const base64Data = imageBase64.replace(/^data:[^;]+;base64,/, '')
    const buffer = Buffer.from(base64Data, 'base64')
    const ext = mimeType.split('/')[1] || 'jpg'

    const formData = new FormData()
    const blob = new Blob([buffer], { type: mimeType })
    formData.append('file', blob, `profile_${userId}.${ext}`)
    formData.append('pinataMetadata', JSON.stringify({ name: `profile_${userId}` }))

    const pinataRes = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
      method: 'POST',
      headers: {
        pinata_api_key: process.env.PINATA_API_KEY!,
        pinata_secret_api_key: process.env.PINATA_SECRET_API_KEY!,
      },
      body: formData,
    })

    if (!pinataRes.ok) {
      const err = await pinataRes.text()
      return res.status(502).json({ message: `Pinata 오류: ${err}` })
    }

    const data = await pinataRes.json() as { IpfsHash: string }
    const imageUrl = `https://gateway.pinata.cloud/ipfs/${data.IpfsHash}`
    await User.update({ profile_image_url: imageUrl }, { where: { id: userId } })
    return res.json({ imageUrl })
  } catch (e: any) {
    return res.status(500).json({ message: e.message })
  }
})

// DELETE /api/user/profile-image
router.delete('/profile-image', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id
    await User.update({ profile_image_url: null }, { where: { id: userId } })
    return res.json({ message: '프로필 이미지 삭제됨' })
  } catch (e: any) {
    return res.status(500).json({ message: e.message })
  }
})

export default router
