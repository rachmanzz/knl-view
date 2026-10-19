import http from 'node:http'
import { promises as fs } from 'node:fs'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { readMap, normalizeMap, decorateNode } from './map.js'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.prd': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf'
}

const MD_EXTS = new Set(['md', 'markdown', 'prd'])
const MAX_DOC_BYTES = 8 * 1024 * 1024
const TITLE_READ_BYTES = 8192

export function createKnowledgeServer({ root, dist = null, host = '127.0.0.1', port = 8085 }) {
  const rootAbs = path.resolve(root)
  const distAbs = dist ? path.resolve(dist) : null

  const server = http.createServer((req, res) => {
    route(req, res, rootAbs, distAbs, { host, port }).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: `Gagal memproses permintaan: ${err.message}` })
      else res.end()
    })
  })

  server.knlRoot = rootAbs
  server.knlHost = host
  server.knlPort = port
  return server
}

async function route(req, res, rootAbs, distAbs, listen) {
  const url = new URL(req.url, 'http://localhost')
  const pathname = url.pathname

  if (pathname === '/api/meta') return sendJson(res, 200, await buildMeta(rootAbs, listen))
  if (pathname === '/api/tree') return sendJson(res, 200, await buildTree(rootAbs, '', await loadMapNorm(rootAbs)))
  if (pathname === '/api/doc') return sendDoc(res, rootAbs, url)
  if (pathname === '/api/raw') return sendRaw(res, rootAbs, url)
  if (pathname.startsWith('/api/')) {
    return sendJson(res, 404, { error: `Endpoint tidak dikenal: ${pathname}` })
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD')
    return sendJson(res, 405, { error: 'Hanya GET yang didukung.' })
  }

  return sendStatic(req, res, distAbs, pathname)
}

function safeJoin(base, relPath) {
  if (!relPath) return null
  let decoded
  try {
    decoded = decodeURIComponent(relPath)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const abs = path.resolve(base, decoded)
  if (abs !== base && !abs.startsWith(base + path.sep)) return null
  return abs
}

async function buildMeta(rootAbs, listen = {}) {
  const norm = await loadMapNorm(rootAbs)
  const tree = await buildTree(rootAbs, '', norm)
  const counts = { files: 0, dirs: 0, newest: 0 }
  walkStats(tree, counts)
  const host = listen.host || '127.0.0.1'
  const port = listen.port || 0
  return {
    name: path.basename(rootAbs),
    root: rootAbs,
    files: counts.files,
    dirs: counts.dirs,
    newest: counts.newest,
    map: norm.raw ? { title: norm.title } : null,
    address: `http://${host}:${port}`
  }
}

// Baca + normalisasi map.json sekali per permintaan. Tanpa peta pun tidak
// apa-apa: semua overlay bersifat opsional dan berlaku sebagai anotasi saja.
async function loadMapNorm(rootAbs) {
  const raw = await readMap(rootAbs)
  return { raw, ...normalizeMap(raw) }
}

function walkStats(nodes, acc) {
  for (const node of nodes) {
    if (node.type === 'dir') {
      acc.dirs += 1
      if (node.mtime > acc.newest) acc.newest = node.mtime
      walkStats(node.children, acc)
    } else {
      acc.files += 1
      if (node.mtime > acc.newest) acc.newest = node.mtime
    }
  }
}

async function buildTree(dirAbs, rel, norm) {
  const entries = await fs.readdir(dirAbs, { withFileTypes: true })
  const nodes = []

  for (const entry of entries) {
    if (entry.name === '.git') continue
    if (rel === '' && entry.name === 'map.json') continue
    const childRel = rel ? `${rel}/${entry.name}` : entry.name
    // Peta boleh menyembunyikan entri (`ignore`). Folder yang disembunyikan
    // ikut menyembunyikan seluruh isinya: jangan disusuri sama sekali.
    if (norm?.entries?.get(childRel)?.ignore) continue
    const childAbs = path.join(dirAbs, entry.name)

    if (entry.isDirectory()) {
      const stat = await fs.stat(childAbs)
      const node = {
        name: entry.name,
        path: childRel,
        type: 'dir',
        mtime: stat.mtimeMs,
        children: await buildTree(childAbs, childRel, norm)
      }
      nodes.push(decorateNode(node, norm))
      continue
    }
    if (!entry.isFile()) continue

    const stat = await fs.stat(childAbs)
    const ext = path.extname(entry.name).slice(1).toLowerCase()
    const node = {
      name: entry.name,
      path: childRel,
      type: 'file',
      ext,
      size: stat.size,
      mtime: stat.mtimeMs
    }
    if (MD_EXTS.has(ext)) {
      const title = await readFirstHeading(childAbs, stat.size)
      if (title) node.title = title
    }
    nodes.push(decorateNode(node, norm))
  }

  // Satu aturan urut, sama dengan orderForIndex di tampilan: dokumen dulu,
  // baru folder. Bila peta menetapkan `order`, entri ber-order lebih dulu
  // (menaik) tanpa peduli tipenya; sisanya jatuh ke aturan nama.
  nodes.sort((a, b) => {
    const ao = a.order ?? Number.POSITIVE_INFINITY
    const bo = b.order ?? Number.POSITIVE_INFINITY
    if (ao !== bo) return ao - bo
    if (a.type !== b.type) return a.type === 'file' ? -1 : 1
    return a.name.localeCompare(b.name, 'id', { numeric: true, sensitivity: 'base' })
  })
  return nodes
}

async function readFirstHeading(abs, size) {
  if (size === 0 || size > 512 * 1024) return null
  const handle = await fs.open(abs, 'r')
  try {
    const buffer = Buffer.alloc(TITLE_READ_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, TITLE_READ_BYTES, 0)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const match = text.match(/^#\s+(.+)$/m)
    if (!match) return null
    const title = cleanTitle(match[1])
    return title || null
  } finally {
    await handle.close()
  }
}

function cleanTitle(raw) {
  const title = raw
    .replace(/\s+#+\s*$/, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return title.length > 160 ? `${title.slice(0, 157)}...` : title
}

async function sendDoc(res, rootAbs, url) {
  const rel = url.searchParams.get('path')
  if (!rel) return sendJson(res, 400, { error: 'Parameter path wajib diisi.' })

  const abs = safeJoin(rootAbs, rel)
  if (!abs) return sendJson(res, 400, { error: `Path di luar basis pengetahuan: ${rel}` })

  let stat
  try {
    stat = await fs.stat(abs)
  } catch {
    return sendJson(res, 404, { error: `Berkas tidak ditemukan: ${rel}` })
  }
  if (stat.isDirectory()) return sendJson(res, 400, { error: `Itu folder, bukan berkas: ${rel}` })
  if (stat.size > MAX_DOC_BYTES) {
    return sendJson(res, 413, { error: `Berkas terlalu besar untuk ditampilkan (${formatBytes(stat.size)}).` })
  }

  const content = await fs.readFile(abs, 'utf8')
  return sendJson(res, 200, {
    path: rel,
    name: path.basename(rel),
    ext: path.extname(rel).slice(1).toLowerCase(),
    content,
    size: stat.size,
    mtime: stat.mtimeMs
  })
}

async function sendRaw(res, rootAbs, url) {
  const rel = url.searchParams.get('path')
  if (!rel) return sendJson(res, 400, { error: 'Parameter path wajib diisi.' })

  const abs = safeJoin(rootAbs, rel)
  if (!abs) return sendJson(res, 400, { error: `Path di luar basis pengetahuan: ${rel}` })

  let stat
  try {
    stat = await fs.stat(abs)
  } catch {
    return sendJson(res, 404, { error: `Berkas tidak ditemukan: ${rel}` })
  }
  if (!stat.isFile()) return sendJson(res, 400, { error: `Bukan berkas: ${rel}` })

  const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream'
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'no-store' })
  if (res.req.method === 'HEAD') return res.end()
  return new Promise((resolve, reject) => {
    const stream = createReadStream(abs)
    stream.on('error', reject)
    stream.on('end', resolve)
    stream.pipe(res)
  })
}

async function sendStatic(req, res, distAbs, pathname) {
  if (!distAbs) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Antarmuka belum dibangun. Jalankan: npm run build')
    return
  }

  let rel = decodeURIComponent(pathname)
  if (rel.endsWith('/')) rel += 'index.html'

  let abs = safeJoin(distAbs, rel.replace(/^\/+/, ''))
  if (!abs) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Akses ditolak.')
    return
  }

  let stat = await statOrNull(abs)
  if (stat?.isDirectory()) {
    abs = path.join(abs, 'index.html')
    stat = await statOrNull(abs)
  }

  if (!stat || !stat.isFile()) {
    // Tanpa ekstensi berarti permintaan rute SPA, bukan berkas hilang.
    if (!path.extname(rel)) {
      abs = path.join(distAbs, 'index.html')
      stat = await statOrNull(abs)
    }
    if (!stat || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Berkas tidak ditemukan.')
      return
    }
  }

  const ext = path.extname(abs).toLowerCase()
  const immutable = abs.startsWith(path.join(distAbs, 'assets') + path.sep)
  const cache = immutable ? 'public, max-age=31536000, immutable' : 'no-store'

  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': cache
  })
  if (req.method === 'HEAD') return res.end()
  return new Promise((resolve, reject) => {
    const stream = createReadStream(abs)
    stream.on('error', reject)
    stream.on('end', resolve)
    stream.pipe(res)
  })
}

async function statOrNull(abs) {
  try {
    return await fs.stat(abs)
  } catch {
    return null
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  })
  res.end(payload)
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = value < 10 ? 1 : 0
  return `${value.toFixed(digits).replace('.', ',')} ${units[unit]}`
}
