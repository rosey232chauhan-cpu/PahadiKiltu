import { Router } from 'express'
import { getSiteContent } from '../store/site-content.js'

const router = Router()

router.get('/', async (_req, res) => {
  try {
    res.json({ content: await getSiteContent() })
  } catch (error) {
    console.error('Unable to load site content:', error)
    res.status(500).json({ error: 'Site content could not be loaded.' })
  }
})

export default router
