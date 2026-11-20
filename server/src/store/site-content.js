import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { getStore } from '@netlify/blobs'

const dataDir = process.env.DATA_DIR || path.join(tmpdir(), 'pahaditokri-data')
const contentFile = path.join(dataDir, 'site-content.json')
const useNetlifyBlobs = process.env.NETLIFY === 'true'
const blobStoreName = 'pahaditokri-content'
const blobKey = 'site-content'

export const defaultSiteContent = {
  brandName: 'PahadiKiltu',
  footerText: 'Freshness Delivered Daily.',
  whatsappNumber: '917018777497',
  whatsappDefaultMessage: 'Hello PahadiKiltu, I have a question.',
  navigation: [
    { label: 'Home', path: '/' },
    { label: 'About', path: '/about' },
    { label: 'Farm Stories', path: '/farm' },
    { label: 'Products', path: '/products' },
    { label: 'Cart', path: '/cart' },
    { label: 'Contact Us', path: '/contact-us' },
  ],
  home: {
    eyebrow: 'From the hills to your home',
    title: 'Freshness from the Hills, Delivered to Your Home.',
    description: 'Discover seasonal fruits, wholesome grains and everyday goodness from PahadiKiltu.',
    assurance: 'Locally sourced • Fresh quality • Convenient delivery',
    origin: 'Based in Karal, Kotkhai, Shimla, Himachal Pradesh',
  },
  about: {
    eyebrow: 'From The Pahadi Himalayas',
    title: 'About PahadiKiltu',
    paragraphs: [
      'Welcome to PahadiKiltu, where we bring you the purest, freshest, and most authentic flavors of the Pahadi Himalayas - straight from our farms to your home.',
      'No middlemen, no compromises - just farm-fresh goodness, handpicked and sun-dried the traditional way.',
      'Taste the Himalayas. Eat pure, live healthy.',
    ],
  },
  contact: {
    title: 'Contact Us',
    email: 'hello@pahadikiltu.com',
    phone: '7018777497',
    address: 'Karal, Kotkhai, Shimla, Himachal Pradesh',
  },
  hiddenHomeSections: [],
  customBlocks: [],
}

function mergeContent(saved = {}) {
  return {
    ...defaultSiteContent,
    ...saved,
    home: { ...defaultSiteContent.home, ...(saved.home || {}) },
    about: { ...defaultSiteContent.about, ...(saved.about || {}), paragraphs: Array.isArray(saved.about?.paragraphs) ? saved.about.paragraphs : defaultSiteContent.about.paragraphs },
    contact: { ...defaultSiteContent.contact, ...(saved.contact || {}) },
    navigation: Array.isArray(saved.navigation) ? saved.navigation : defaultSiteContent.navigation,
    hiddenHomeSections: Array.isArray(saved.hiddenHomeSections) ? saved.hiddenHomeSections : [],
    customBlocks: Array.isArray(saved.customBlocks) ? saved.customBlocks : [],
  }
}

export async function getSiteContent() {
  if (useNetlifyBlobs) {
    const store = getStore({ name: blobStoreName, consistency: 'strong' })
    return mergeContent((await store.get(blobKey, { type: 'json' })) || {})
  }
  if (!fs.existsSync(contentFile)) return mergeContent()
  return mergeContent(JSON.parse(fs.readFileSync(contentFile, 'utf8')))
}

export async function saveSiteContent(content) {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw new Error('Site content must be an object.')
  }
  const saved = mergeContent(content)
  saved.navigation = saved.navigation
    .filter((item) => item && typeof item.label === 'string' && typeof item.path === 'string')
    .map((item) => ({ label: item.label.trim().slice(0, 40), path: item.path.trim().slice(0, 200) }))
    .filter((item) => item.label && item.path)
  saved.customBlocks = saved.customBlocks
    .filter((block) => block && typeof block.id === 'string')
    .map((block) => ({
      id: block.id,
      type: ['text', 'image', 'link'].includes(block.type) ? block.type : 'text',
      title: String(block.title || '').slice(0, 160),
      text: String(block.text || '').slice(0, 1000),
      image: String(block.image || '').slice(0, 2000),
      path: String(block.path || '').slice(0, 500),
      buttonLabel: String(block.buttonLabel || '').slice(0, 60),
      enabled: block.enabled !== false,
    }))
  if (useNetlifyBlobs) {
    const store = getStore({ name: blobStoreName, consistency: 'strong' })
    await store.setJSON(blobKey, saved)
  } else {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(contentFile, JSON.stringify(saved, null, 2), 'utf8')
  }
  return saved
}
