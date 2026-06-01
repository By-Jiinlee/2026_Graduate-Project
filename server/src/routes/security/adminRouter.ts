import { Router } from 'express'
import { isAuthenticated, isAdmin } from '../../middleware/auth/authMiddleware'
import * as adminController from '../../controllers/security/adminController'

const router = Router()

router.use(isAuthenticated, isAdmin)

router.get('/stats', adminController.getStats)
router.get('/chart/by-type', adminController.getChartByType)
router.get('/chart/by-day', adminController.getChartByDay)
router.get('/honeypot-hits', adminController.getHoneypotHits)
router.get('/anomaly-logs', adminController.getAnomalyLogs)
router.get('/locked-accounts', adminController.getLockedAccounts)
router.patch('/users/:userId/unlock', adminController.unlockAccount)
router.get('/blocked-ips', adminController.getBlockedIPs)
router.delete('/blocked-ips/:ip', adminController.unblockIP)

export default router
