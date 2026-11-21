import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { getStore } from '@netlify/blobs'
import { productCategories } from '../data/products.js'

const dataDir = process.env.DATA_DIR || path.join(tmpdir(), 'pahaditokri-data')
const catalogFile = path.join(dataDir, 'catalog.json')
const useNetlifyBlobs = process.env.NETLIFY === 'true'
const blobStoreName = 'pahaditokri-catalog'
const blobKey = 'product-overrides'
let catalogWriteQueue = Promise.resolve()

function withCatalogWriteLock(action) {
  const result = catalogWriteQueue.then(action)
  catalogWriteQueue = result.then(() => undefined, () => undefined)
  return result
}

async function readOverrides() {
  let saved
  if (useNetlifyBlobs) {
    const store = getStore({ name: blobStoreName, consistency: 'strong' })
    saved = (await store.get(blobKey, { type: 'json' })) ?? {}
  } else {
    if (!fs.existsSync(catalogFile)) return { schema: 1, overrides: {}, added: [], removed: [] }
    saved = JSON.parse(fs.readFileSync(catalogFile, 'utf8'))
  }
  if (saved.schema === 1) return saved
  return { schema: 1, overrides: saved, added: [], removed: [] }
}

async function writeOverrides(overrides) {
  if (useNetlifyBlobs) {
    const store = getStore({ name: blobStoreName, consistency: 'strong' })
    await store.setJSON(blobKey, overrides)
    return
  }
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(catalogFile, JSON.stringify(overrides, null, 2), 'utf8')
}

function applyOverrides(saved) {
  const removed = new Set(saved.removed)
  const categories = productCategories.map((category) => ({
    ...category,
    items: category.items
      .filter((item) => !removed.has(item.sku))
      .map((item) => {
        const changes = saved.overrides[item.sku] ?? {}
        const priceInRupees = changes.priceInRupees ?? item.priceInRupees
        return {
          ...item,
          ...changes,
          priceInRupees,
          price: `₹${priceInRupees}/kg`,
          isAvailable: changes.isAvailable ?? true,
          availableQuantity: changes.availableQuantity ?? item.availableQuantity ?? 0,
        }
      }),
  }))
  for (const item of saved.added) {
    const category = categories.find((entry) => entry.slug === item.categorySlug)
    if (category && !removed.has(item.sku)) {
      const changes = saved.overrides[item.sku] ?? {}
      const priceInRupees = changes.priceInRupees ?? item.priceInRupees
      category.items.push({
        ...item,
        ...changes,
        priceInRupees,
        price: `₹${priceInRupees}/kg`,
        isAvailable: changes.isAvailable ?? true,
        availableQuantity: changes.availableQuantity ?? item.availableQuantity ?? 0,
      })
    }
  }
  return categories
}

export async function getProductCatalog() {
  return applyOverrides(await readOverrides())
}

export async function updateCatalogProduct(sku, changes) {
  return withCatalogWriteLock(async () => {
    const saved = await readOverrides()
    saved.overrides[sku] = { ...saved.overrides[sku], ...changes }
    await writeOverrides(saved)
    const catalog = applyOverrides(saved)
    return catalog.flatMap((category) => category.items).find((item) => item.sku === sku)
  })
}

export async function addCatalogProduct({ name, info, priceInRupees, categorySlug, availableQuantity }) {
  return withCatalogWriteLock(async () => {
    const saved = await readOverrides()
    const category = productCategories.find((entry) => entry.slug === categorySlug)
    if (!category) throw new Error('Choose a valid product category.')
    const slug = name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'product'
    const existing = new Set([
      ...productCategories.flatMap((entry) => entry.items.map((item) => item.sku)),
      ...saved.added.map((item) => item.sku),
    ])
    let sku = `${categorySlug}-${slug}`
    let suffix = 2
    while (existing.has(sku)) {
      sku = `${categorySlug}-${slug}-${suffix}`
      suffix += 1
    }
    const product = {
      sku,
      name,
      info,
      priceInRupees,
      price: `₹${priceInRupees}/kg`,
      image: category.image,
      categorySlug,
      isAvailable: true,
      availableQuantity,
    }
    saved.added.push(product)
    await writeOverrides(saved)
    return product
  })
}

export async function adjustCatalogStock(items, direction) {
  return withCatalogWriteLock(async () => {
    const saved = await readOverrides()
    const catalog = applyOverrides(saved)
    const productsBySku = new Map(catalog.flatMap((category) => category.items).map((item) => [item.sku, item]))
    const quantities = new Map()
    for (const item of items) {
      quantities.set(item.sku, (quantities.get(item.sku) ?? 0) + item.quantity)
    }

    for (const [sku, quantity] of quantities) {
      const product = productsBySku.get(sku)
      if (!product) throw new Error(`Unknown product: ${sku}`)
      if (direction < 0 && product.isAvailable === false) {
        const error = new Error(`${product.name} is currently unavailable.`)
        error.code = 'OUT_OF_STOCK'
        throw error
      }
      const stock = Number(product.availableQuantity) || 0
      if (direction < 0 && quantity > stock) {
        const error = new Error(`Only ${stock} kg of ${product.name} are available.`)
        error.code = 'OUT_OF_STOCK'
        throw error
      }
    }

    for (const [sku, quantity] of quantities) {
      const product = productsBySku.get(sku)
      const stock = Number(product.availableQuantity) || 0
      saved.overrides[sku] = {
        ...saved.overrides[sku],
        availableQuantity: stock + (direction * quantity),
      }
    }
    await writeOverrides(saved)
  })
}

export async function removeCatalogProduct(sku) {
  return withCatalogWriteLock(async () => {
    const saved = await readOverrides()
    const exists = productCategories.some((category) => category.items.some((item) => item.sku === sku))
      || saved.added.some((item) => item.sku === sku)
    if (!exists || saved.removed.includes(sku)) return false
    saved.added = saved.added.filter((item) => item.sku !== sku)
    delete saved.overrides[sku]
    saved.removed.push(sku)
    await writeOverrides(saved)
    return true
  })
}
