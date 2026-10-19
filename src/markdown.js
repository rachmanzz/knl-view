import { marked } from 'marked'
import { docHref, dirHref } from './router.js'

// Konten .knowledges datang dari disk, tapi tetap dilewati whitelist agar
// berkas berisi HTML mentah tidak bisa menaruh skrip atau pengendali di viewer.
const KEEP_TAGS = new Set([
  'P', 'BR', 'HR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'UL', 'OL', 'LI', 'PRE', 'CODE', 'BLOCKQUOTE',
  'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD',
  'STRONG', 'EM', 'DEL', 'S', 'A', 'IMG', 'INPUT', 'SPAN', 'DIV',
  'SUP', 'SUB', 'KBD', 'MARK', 'SMALL', 'DETAILS', 'SUMMARY',
  'ABBR', 'CITE', 'Q', 'DL', 'DT', 'DD'
])

const DROP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'APPLET', 'LINK',
  'META', 'BASE', 'FORM', 'BUTTON', 'SELECT', 'TEXTAREA', 'SVG', 'MATH',
  'NOSCRIPT', 'TEMPLATE', 'VIDEO', 'AUDIO', 'SOURCE'
])

const TAG_ATTRS = {
  A: ['href'],
  IMG: ['src', 'alt', 'width', 'height'],
  TD: ['colspan', 'rowspan'],
  TH: ['colspan', 'rowspan'],
  OL: ['start'],
  INPUT: ['type', 'checked', 'disabled']
}

const GLOBAL_ATTRS = new Set(['class', 'id', 'title'])

let pendingAnchor = null

export function setPendingAnchor(id) {
  pendingAnchor = id
}

export function takePendingAnchor() {
  const id = pendingAnchor
  pendingAnchor = null
  return id
}

export function prepareDocument({ content, baseDir, files, dirs }) {
  const html = marked.parse(content, { gfm: true, breaks: false })
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const body = parsed.body

  sanitize(body)
  const headings = assignHeadingIds(body)
  const ids = new Set(headings.map((heading) => heading.id))
  resolveLinks(body, { baseDir, files, dirs, ids })
  resolveImages(body, { baseDir, files, parsed })

  return {
    html: body.innerHTML,
    headings,
    hasH1: headings.some((heading) => heading.level === 1)
  }
}

export function scrollToId(id) {
  const target = document.getElementById(id)
  if (!target) return false
  target.scrollIntoView({ block: 'start' })
  target.focus({ preventScroll: true })
  return true
}

export function handleMarkdownClick(event) {
  const jump = event.target.closest?.('a[data-jump]')
  if (jump) {
    // Rute berganti dulu; DocView menarik anchor setelah dokumen baru terpasang.
    setPendingAnchor(jump.getAttribute('data-jump'))
    return
  }

  const anchor = event.target.closest?.('a[data-anchor]')
  if (!anchor) return
  event.preventDefault()
  scrollToId(anchor.getAttribute('data-anchor'))
}

function sanitize(root) {
  for (const el of [...root.querySelectorAll('*')]) {
    if (!el.isConnected) continue
    const tag = el.tagName.toUpperCase()

    if (DROP_TAGS.has(tag)) {
      el.remove()
      continue
    }
    if (!KEEP_TAGS.has(tag)) {
      el.replaceWith(...el.childNodes)
      continue
    }
    filterAttrs(el)
  }
}

function filterAttrs(el) {
  const tag = el.tagName.toUpperCase()
  const allowed = new Set([...GLOBAL_ATTRS, ...(TAG_ATTRS[tag] || [])])

  for (const attr of [...el.attributes]) {
    const name = attr.name.toLowerCase()
    if (name.startsWith('on') || !allowed.has(name)) el.removeAttribute(attr.name)
  }

  if (tag === 'INPUT') {
    const type = (el.getAttribute('type') || '').toLowerCase()
    if (type !== 'checkbox') el.remove()
  }
}

function assignHeadingIds(root) {
  const used = new Map()
  const headings = []

  for (const el of [...root.querySelectorAll('h1, h2, h3, h4')]) {
    const text = el.textContent.replace(/\s+/g, ' ').trim()
    let base = text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
    if (!base) base = 'bagian'
    if (base.length > 72) base = base.slice(0, 72).replace(/-+$/, '')

    const seen = used.get(base) || 0
    used.set(base, seen + 1)
    const id = seen > 0 ? `${base}-${seen + 1}` : base

    el.setAttribute('id', id)
    el.setAttribute('tabindex', '-1')
    headings.push({ id, level: Number(el.tagName.charAt(1)), text })
  }

  return headings
}

function resolveLinks(root, { baseDir, files, dirs, ids }) {
  for (const a of [...root.querySelectorAll('a')]) {
    const href = a.getAttribute('href')
    if (!href) {
      a.removeAttribute('href')
      continue
    }

    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) {
      const protocol = href.slice(0, href.indexOf(':')).toLowerCase()
      if (protocol === 'http' || protocol === 'https' || protocol === 'mailto') {
        a.setAttribute('target', '_blank')
        a.setAttribute('rel', 'noreferrer')
      } else {
        a.removeAttribute('href')
      }
      continue
    }

    if (href.startsWith('//')) {
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noreferrer')
      continue
    }

    if (href.startsWith('#')) {
      const id = decodeURIComponent(href.slice(1))
      if (ids.has(id)) a.setAttribute('data-anchor', id)
      else markMissing(a)
      continue
    }

    const [pathPartRaw, fragment] = href.split('#')
    const pathPart = pathPartRaw.split('?')[0]
    const target = resolveWithinRoot(baseDir, pathPart)
    if (!target) {
      markMissing(a)
      continue
    }

    if (dirs.has(target)) {
      a.setAttribute('href', dirHref(target))
      continue
    }
    if (files.has(target)) {
      a.setAttribute('href', docHref(target))
      if (fragment) a.setAttribute('data-jump', decodeURIComponent(fragment))
      continue
    }
    markMissing(a)
  }
}

function resolveImages(root, { baseDir, files, parsed }) {
  for (const img of [...root.querySelectorAll('img')]) {
    const src = img.getAttribute('src') || ''
    if (!src) {
      replaceWithPlaceholder(img, parsed)
      continue
    }
    if (/^https?:/i.test(src)) continue
    if (src.startsWith('//')) {
      img.setAttribute('src', `https:${src}`)
      continue
    }

    const clean = src.split('?')[0].split('#')[0]
    const target = clean.startsWith('/')
      ? clean.replace(/^\/+/, '')
      : resolveWithinRoot(baseDir, clean)

    if (target && files.has(target)) {
      img.setAttribute('src', `/api/raw?path=${encodeURIComponent(target)}`)
      img.setAttribute('loading', 'lazy')
    } else {
      replaceWithPlaceholder(img, parsed)
    }
  }
}

function replaceWithPlaceholder(img, parsed) {
  const alt = (img.getAttribute('alt') || '').trim()
  const text = alt ? `[gambar tidak ditemukan: ${alt}]` : '[gambar tidak ditemukan]'
  img.replaceWith(parsed.createTextNode(text))
}

function markMissing(a) {
  a.removeAttribute('href')
  a.setAttribute('title', 'This file does not exist in the knowledge base')
  a.classList.add('md-link-dead')
}

function resolveWithinRoot(baseDir, pathPart) {
  if (!pathPart) return null
  const segments = [...baseDir.split('/').filter(Boolean), ...pathPart.split('/')]
  const out = []
  for (const segment of segments) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (!out.length) return null
      out.pop()
      continue
    }
    out.push(segment)
  }
  return out.join('/')
}
