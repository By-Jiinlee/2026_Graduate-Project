import { Router, Request, Response } from 'express'
import * as contractService from '../../services/web3/contractService'

const router = Router()

// 지갑 등록 여부 확인
router.get('/is-registered/:address', async (req: Request, res: Response) => {
  try {
    const address = req.params.address as string
    const result = await contractService.isWalletRegistered(address)
    return res.status(200).json({ isRegistered: result })
  } catch (error: any) {
    return res.status(500).json({ message: error.message })
  }
})

// nonce 조회
router.get('/nonce/:address', async (req: Request, res: Response) => {
  try {
    const address = req.params.address as string
    const result = await contractService.getAuthNonce(address)
    return res.status(200).json({ nonce: result.toString() })
  } catch (error: any) {
    return res.status(500).json({ message: error.message })
  }
})

export default router
