import crypto from 'node:crypto'
import { Router } from 'express'
import { adjustCatalogStock } from '../store/catalog.js'
import { getOrderById, transitionOrder } from '../store/orders.js'
import { verifyPaymentSignature } from '../services/razorpay.js'

const router = Router()

router.post('/verify', async (req, res) => {
  const { orderId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body ?? {}
  if (!orderId || !razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    return res.status(400).json({ error: 'Payment verification details are required.' })
  }
  let existingOrder
  try {
    existingOrder = await getOrderById(orderId)
  } catch {
    return res.status(500).json({ error: 'Order could not be loaded.' })
  }
  if (!existingOrder || existingOrder.razorpayOrderId !== razorpayOrderId) {
    return res.status(400).json({ error: 'Payment does not match this order.' })
  }
  if (existingOrder.status !== 'payment_pending') {
    return res.status(409).json({ error: 'This order is no longer awaiting payment.' })
  }
  if (!verifyPaymentSignature({ razorpayOrderId: existingOrder.razorpayOrderId, razorpayPaymentId, razorpaySignature })) {
    return res.status(400).json({ error: 'Invalid payment signature.' })
  }
  let order
  try {
    order = await transitionOrder(orderId, 'payment_pending', {
      status: 'paid',
      razorpayPaymentId,
      razorpayOrderId,
      cancellationTokenHash: null,
    })
  } catch {
    return res.status(500).json({ error: 'Payment status could not be saved.' })
  }
  if (!order) {
    return res.status(409).json({ error: 'This order is no longer awaiting payment.' })
  }
  res.json({ success: true, order })
})

router.post('/cancel', async (req, res) => {
  const { orderId, razorpayOrderId, cancellationToken } = req.body ?? {}
  if (typeof orderId !== 'string' || typeof razorpayOrderId !== 'string'
    || typeof cancellationToken !== 'string' || !/^[a-f0-9]{64}$/i.test(cancellationToken)) {
    return res.status(400).json({ error: 'Payment cancellation details are required.' })
  }
  let existingOrder
  try {
    existingOrder = await getOrderById(orderId)
  } catch {
    return res.status(500).json({ error: 'Order could not be loaded.' })
  }
  if (!existingOrder || existingOrder.razorpayOrderId !== razorpayOrderId || existingOrder.status !== 'payment_pending') {
    return res.status(409).json({ error: 'This order is no longer awaiting payment.' })
  }
  const expectedToken = Buffer.from(existingOrder.cancellationTokenHash || '', 'hex')
  const actualToken = crypto.createHash('sha256').update(cancellationToken).digest()
  if (expectedToken.length !== actualToken.length || !crypto.timingSafeEqual(expectedToken, actualToken)) {
    return res.status(403).json({ error: 'Payment cancellation could not be authorized.' })
  }

  let cancellingOrder
  try {
    cancellingOrder = await transitionOrder(orderId, 'payment_pending', { status: 'cancelling' })
  } catch {
    return res.status(500).json({ error: 'Order could not be updated.' })
  }
  if (!cancellingOrder) {
    return res.status(409).json({ error: 'This order is no longer awaiting payment.' })
  }

  let stockReleased = false
  try {
    await adjustCatalogStock(cancellingOrder.items, 1)
    stockReleased = true
    const order = await transitionOrder(orderId, 'cancelling', {
      status: 'cancelled',
      cancellationTokenHash: null,
    })
    if (!order) throw new Error('Cancelled order status could not be saved.')
    res.json({ order })
  } catch (error) {
    console.error('Unable to release stock for cancelled UPI order:', error)
    if (!stockReleased) {
      try {
        await transitionOrder(orderId, 'cancelling', { status: 'payment_pending' })
      } catch (restoreError) {
        console.error('Unable to restore pending status after UPI cancellation failed:', restoreError)
      }
    }
    res.status(500).json({ error: 'Product stock could not be released for this cancelled payment.' })
  }
})

export default router
