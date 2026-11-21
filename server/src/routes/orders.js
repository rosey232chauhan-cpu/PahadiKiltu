import crypto from 'node:crypto'
import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { calculateCartTotals } from '../data/products.js'
import { adjustCatalogStock, getProductCatalog } from '../store/catalog.js'
import { createRazorpayOrder, getRazorpayKeyId, isOnlinePaymentsConfigured } from '../services/razorpay.js'
import { getOrderById, listOrdersByPhone, saveOrder } from '../store/orders.js'

const router = Router()

router.post('/', async (req, res) => {
  const { customer, items, paymentMethod = 'cod' } = req.body ?? {}
  if (!customer?.name?.trim() || !customer?.phone?.trim() || !customer?.address?.trim()) {
    return res.status(400).json({ error: 'Name, phone, and address are required.' })
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'At least one product is required.' })
  }
  if (!['cod', 'upi', 'card', 'online'].includes(paymentMethod)) {
    return res.status(400).json({ error: 'Invalid payment method.' })
  }

  let totals
  try {
    totals = calculateCartTotals(items, await getProductCatalog())
  } catch (error) {
    return res.status(error.code === 'OUT_OF_STOCK' ? 409 : 400).json({ error: error.message })
  }

  const order = {
    orderId: `PT-${uuidv4().slice(0, 8).toUpperCase()}`,
    customerName: String(customer.name).trim().slice(0, 120),
    phone: String(customer.phone).trim().slice(0, 30),
    address: String(customer.address).trim().slice(0, 500),
    paymentMethod,
    status: paymentMethod === 'cod' ? 'confirmed' : 'payment_pending',
    items: totals.items,
    subtotal: totals.subtotal,
    shippingCharge: totals.shippingCharge,
    gstAmount: totals.gstAmount,
    total: totals.total,
    createdAt: new Date().toISOString(),
  }
  const cancellationToken = paymentMethod === 'cod' ? null : crypto.randomBytes(32).toString('hex')
  if (cancellationToken) {
    order.cancellationTokenHash = crypto.createHash('sha256').update(cancellationToken).digest('hex')
  }

  if (paymentMethod !== 'cod') {
    if (!isOnlinePaymentsConfigured()) {
      return res.status(503).json({ error: 'Online payments are not configured. Please choose Cash on Delivery.' })
    }
    try {
      const razorpayOrder = await createRazorpayOrder({
        amountPaise: totals.amountPaise,
        receipt: order.orderId,
        notes: { customerPhone: order.phone },
      })
      order.razorpayOrderId = razorpayOrder.id
      order.razorpayAmount = razorpayOrder.amount
      order.razorpayCurrency = razorpayOrder.currency
    } catch (error) {
      return res.status(502).json({ error: error.message })
    }
  }

  let stockReserved = false
  try {
    await adjustCatalogStock(totals.items, -1)
    stockReserved = true
    await saveOrder(order)
  } catch (error) {
    if (stockReserved) {
      try {
        await adjustCatalogStock(totals.items, 1)
      } catch (restoreError) {
        console.error('Unable to restore product stock after order save failed:', restoreError)
      }
    }
    if (error.code === 'OUT_OF_STOCK') {
      return res.status(409).json({ error: error.message })
    }
    console.error('Unable to reserve product stock or save order:', error)
    return res.status(500).json({ error: 'Order could not be saved.' })
  }
  if (paymentMethod === 'cod') {
    return res.status(201).json({ order })
  }
  res.status(201).json({
    order: { ...order, cancellationTokenHash: undefined },
    checkout: {
      keyId: getRazorpayKeyId(),
      orderId: order.razorpayOrderId,
      amount: order.razorpayAmount,
      currency: order.razorpayCurrency,
      cancellationToken,
    },
  })
})

router.get('/history', async (req, res) => {
  const phone = String(req.query.phone ?? '').trim()
  if (!phone) {
    return res.status(400).json({ error: 'Phone number is required.' })
  }
  try {
    res.json({ orders: await listOrdersByPhone(phone) })
  } catch {
    res.status(500).json({ error: 'Order history could not be loaded.' })
  }
})

router.get('/:orderId', async (req, res) => {
  let order
  try {
    order = await getOrderById(req.params.orderId)
  } catch {
    return res.status(500).json({ error: 'Order could not be loaded.' })
  }
  if (!order) {
    return res.status(404).json({ error: 'Order not found.' })
  }
  res.json({ order })
})

export default router
