import { Router, Request, Response } from 'express'
import * as contractService from '../../services/web3/contractService'

const router = Router()

router.use((req, res, next) => {
  if (process.env.NODE_ENV !== 'development') {
    return res.status(404).json({ message: 'Not found' })
  }
  next()
})

router.get('/is-registered/:address', async (req: Request, res: Response) => {
  try {
    const address = req.params.address as string
    const result = await contractService.isWalletRegistered(address)
    return res.status(200).json({ isRegistered: result })
  } catch (error: any) {
    return res.status(500).json({ message: error.message })
  }
})

router.get('/nonce/:address', async (req: Request, res: Response) => {
  try {
    const address = req.params.address as string
    const result = await contractService.getAuthNonce(address)
    return res.status(200).json({ nonce: result.toString() })
  } catch (error: any) {
    return res.status(500).json({ message: error.message })
  }
})

router.get('/trade-nonce/:address', async (req: Request, res: Response) => {
  try {
    const address = req.params.address as string
    const result = await contractService.getTradeNonce(address)
    return res.status(200).json({ tradeNonce: result.toString() })
  } catch (error: any) {
    return res.status(500).json({ message: error.message })
  }
})

router.post('/register/:address', async (req: Request, res: Response) => {
  try {
    const address = req.params.address as string
    await contractService.registerWalletFor(address)
    return res.status(200).json({ message: '온체인 등록 완료' })
  } catch (error: any) {
    return res.status(500).json({ message: error.message })
  }
})

router.delete('/unregister/:address', async (req: Request, res: Response) => {
  try {
    const address = req.params.address as string
    await contractService.unregisterWallet(address)
    return res.status(200).json({ message: '온체인 등록 취소 완료' })
  } catch (error: any) {
    return res.status(500).json({ message: error.message })
  }
})

export default router
