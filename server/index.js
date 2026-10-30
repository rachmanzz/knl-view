import http from 'node:http'
import { promises as fs } from 'node:fs'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { readMap, normalizeMap, decorateNode } from './map.js'
import { buildGraphFromRoot } from './graph/parser.js'
import { createAnchorWireClient, syncGraphToAnchorDB, traceCausalChain, traceInboundFromMirror, mergeLineage, mirrorStillValid } from './graph/anchordb_client.js'
import {
  deriveStatus,
  readClaimsIndex,
  readConsensusMirror,
  inboundConsensus,
  outboundConsensus
} from './consensus.js'
import { anchordbClientOptions, syncStatePath, DEFAULT_RELATIONS } from './config.js'

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

export function createKnowledgeServer({ root, dist = null, host = '127.0.0.1', port = 8085, anchordb = null, consensusModel = null }) {
  const rootAbs = path.resolve(root)
  const distAbs = dist ? path.resolve(dist) : null
  // Live AnchorDB connection status lives here, not a snapshot: attachAnchorDB
  // fills it after the server listens, and routes read the latest status.
  const anchordbState = {
    config: anchordb,
    client: null,
    status: anchordb ? 'connecting' : 'off',
    error: null,
    syncedAt: null,
    consensusModel,
    consensusClient: null,
    consensusError: null
  }

  const server = http.createServer((req, res) => {
    route(req, res, rootAbs, distAbs, { host, port, anchordb: anchordbState }).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: `Failed to handle request: ${err.message}` })
      else res.end()
    })
  })

  server.knlRoot = rootAbs
  server.knlHost = host
  server.knlPort = port
  server.knlAnchorDB = anchordbState
  return server
}

// Connect knl-view to AnchorDB after the server listens. Connect or sync
// failures never bring the server down: the viewer keeps running fully
// local, and the status can be read from the state.
export async function attachAnchorDB(server) {
  const state = server.knlAnchorDB
  if (!state?.config) {
    state.status = 'off'
    return { ok: false, reason: 'off' }
  }
  const options = anchordbClientOptions(state.config)
  if (!options) {
    state.status = 'error'
    state.error = 'anchordb URL is unreadable'
    return { ok: false, reason: state.error }
  }
  if (!options.model) {
    state.status = 'error'
    state.error = 'model name is not mapped yet'
    return { ok: false, reason: 'role "knowledges" is missing from the knl-config.json "models" map, run: knl-view model new knowledges' }
  }
  try {
    state.client = await createAnchorWireClient(options)
  } catch (err) {
    state.client = null
    state.status = 'error'
    state.error = err.message
    return { ok: false, reason: err.message }
  }
  state.status = 'connected'
  state.error = null
  state.model = options.model

  // A second client for the consensus model, when the project maps that
  // role. Best effort: a failed consensus connection only disables
  // consensus endpoints, never the main graph sync.
  if (state.consensusModel) {
    try {
      state.consensusClient = await createAnchorWireClient({ ...options, model: state.consensusModel })
    } catch (err) {
      state.consensusClient = null
      state.consensusError = err.message
    }
  }
  let synced = false
  if (state.config.sync) {
    try {
      const graph = await buildGraphFromRoot(server.knlRoot)
      const previous = await readSyncState(options.model)
      const result = await syncGraphToAnchorDB(state.client, graph, previous)
      if (result.failed === 0) {
        // The mirror is only written on a clean sync, so failed parts are
        // retried automatically on the next start.
        await writeSyncState(options.model, result.edges)
      }
      state.syncedAt = Date.now()
      state.lastSync = result
      synced = true
    } catch (err) {
      // A connection is enough for trace; a sync failure is only recorded.
      state.error = err.message
    }
  }
  return {
    ok: true,
    model: options.model,
    synced,
    linked: state.lastSync?.linked ?? 0,
    unlinked: state.lastSync?.unlinked ?? 0,
    kept: state.lastSync?.kept ?? 0,
    failed: state.lastSync?.failed ?? 0
  }
}

// Mirror of the edges from the last sync: ~/.knlview/sync-state/<model>.json.
// A broken/missing file is treated as "never synced" (full sync), not an
// error; this mirror is purely an optimization, not a source of truth.
async function readSyncState(model) {
  try {
    const parsed = JSON.parse(await fs.readFile(syncStatePath(model), 'utf8'))
    if (parsed?.model !== model || !Array.isArray(parsed.edges)) return null
    return parsed.edges
  } catch {
    return null
  }
}

async function writeSyncState(model, edges) {
  try {
    const file = syncStatePath(model)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ model, syncedAt: new Date().toISOString(), edges }), 'utf8')
  } catch {
    // Mirror write failed: the sync still counts, only incrementality is lost.
  }
}

async function route(req, res, rootAbs, distAbs, listen) {
  const url = new URL(req.url, 'http://localhost')
  const pathname = url.pathname

  if (pathname === '/api/meta') return sendJson(res, 200, await buildMeta(rootAbs, listen))
  if (pathname === '/api/tree') return sendJson(res, 200, await buildTree(rootAbs, '', await loadMapNorm(rootAbs)))
  if (pathname === '/api/doc') return sendDoc(res, rootAbs, url)
  if (pathname === '/api/raw') return sendRaw(res, rootAbs, url)
  if (pathname === '/api/graph') {
    const graph = await buildGraphFromRoot(rootAbs)
    return sendJson(res, 200, graph.toJSON())
  }
  if (pathname === '/api/graph/trace') {
    const target = url.searchParams.get('target') || url.searchParams.get('id')
    if (!target) {
      return sendJson(res, 400, { error: 'Parameter "target" or "id" is required.' })
    }
    const hops = parseInt(url.searchParams.get('hops') || '2', 10)
    const rawDirection = url.searchParams.get('direction')
    if (rawDirection !== null && !['in', 'out', 'both'].includes(rawDirection)) {
      return sendJson(res, 400, { error: 'Parameter "direction" must be in, out, or both.' })
    }
    const direction = rawDirection || 'both'
    const graph = await buildGraphFromRoot(rootAbs)
    const subGraph = graph.extractSubGraph(target, Number.isInteger(hops) && hops > 0 ? hops : 2, direction)
    return sendJson(res, 200, subGraph)
  }
  if (pathname === '/api/anchordb/trace') {
    return handleAnchorTrace(res, listen.anchordb, url)
  }
  if (pathname === '/api/consensus') {
    return handleConsensus(res, listen.anchordb, url)
  }
  if (pathname.startsWith('/api/')) {
    return sendJson(res, 404, { error: `Unknown endpoint: ${pathname}` })
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD')
    return sendJson(res, 405, { error: 'Only GET is supported.' })
  }

  return sendStatic(req, res, distAbs, pathname)
}

// Multi-hop causal chain trace on the AnchorDB side. Only active when the
// project's knl-config.json carries an anchordb block and the connection
// is alive.
async function handleAnchorTrace(res, state, url) {
  if (!state?.config) {
    return sendJson(res, 503, { error: 'AnchorDB is not active. Add an "anchordb" block to knl-config.json.' })
  }
  if (state.status !== 'connected' || !state.client) {
    return sendJson(res, 503, {
      error: `AnchorDB not connected yet (status: ${state.status}).`,
      detail: state.error || null
    })
  }
  const target = url.searchParams.get('target') || url.searchParams.get('id')
  if (!target) {
    return sendJson(res, 400, { error: 'Parameter "target" or "id" is required.' })
  }
  const relations = url.searchParams.get('relations')
    ? url.searchParams.get('relations').split(',').map((s) => s.trim()).filter(Boolean)
    : (state.config.relations?.length ? state.config.relations : DEFAULT_RELATIONS)
  const limit = parseInt(url.searchParams.get('limit') || '20', 10)
  const hops = parseInt(url.searchParams.get('hops') || '2', 10)
  const rawDirection = url.searchParams.get('direction')
  if (rawDirection !== null && !['in', 'out', 'both'].includes(rawDirection)) {
    return sendJson(res, 400, { error: 'Parameter "direction" must be in, out, or both.' })
  }
  const direction = rawDirection || 'out'

  // Mechanically directional, never cause-and-effect:
  //   out  — follow the relations forward from the target (server-scored)
  //   in   — who references the target: walked from the local sync mirror,
  //          because the wire protocol has no reverse query
  //   both — union of the two, best score wins per word
  const maxHops = Number.isInteger(hops) && hops > 0 ? hops : 2
  const limitK = Number.isInteger(limit) && limit > 0 ? limit : 20
  try {
    const forward = direction === 'in'
      ? []
      : await traceCausalChain(state.client, target, relations, limitK, maxHops)
    let inbound = []
    let mirrored = false
    if (direction !== 'out') {
      const mirrorEdges = await readSyncState(state.model || state.config.model)
      mirrored = Array.isArray(mirrorEdges) && mirrorEdges.length > 0
      inbound = mirrored ? traceInboundFromMirror(mirrorEdges, target, relations, maxHops) : []
    }
    const chain = direction === 'out' ? forward : mergeLineage(forward, inbound)
    return sendJson(res, 200, {
      target,
      relations,
      limit,
      hops,
      direction,
      mirrored,
      chain
    })
  } catch (err) {
    return sendJson(res, 502, { error: `AnchorDB trace failed: ${err.message}` })
  }
}

// Read-only consensus status over HTTP. Mutations stay in the CLI on
// purpose: one write path, one mirror to keep honest.
async function handleConsensus(res, state, url) {
  if (!state?.config) {
    return sendJson(res, 503, { error: 'AnchorDB is off. Add the "anchordb" block to the global knl-config.json.' })
  }
  if (state.status !== 'connected' || !state.client) {
    return sendJson(res, 503, {
      error: `AnchorDB is not connected yet (status: ${state.status}).`,
      detail: state.error || null
    })
  }
  if (!state.consensusModel) {
    return sendJson(res, 503, {
      error: 'Role "consensus" is not mapped in this project\'s models map.',
      hint: 'knl-view model new consensus'
    })
  }
  const target = url.searchParams.get('target') || url.searchParams.get('id')
  if (!target) {
    return sendJson(res, 400, { error: 'Parameter "target" or "id" is required.' })
  }
  try {
    let probeClient = state.consensusClient
    if (!probeClient) {
      return sendJson(res, 503, {
        error: 'Consensus model is not reachable.',
        detail: state.consensusError || 'no consensus client'
      })
    }
    const mirrorEdges = await readConsensusMirror(state.consensusModel)
    let mirrored = Array.isArray(mirrorEdges)
    if (mirrored && mirrorEdges.length > 0) {
      mirrored = await mirrorStillValid(probeClient, mirrorEdges).catch(() => false)
    }
    const usable = mirrored ? mirrorEdges : []
    const inbound = inboundConsensus(usable, target)
    const stance = outboundConsensus(usable, target)
    const { claims } = await readClaimsIndex(state.consensusModel)
    return sendJson(res, 200, {
      target,
      status: deriveStatus(inbound.supporters, inbound.objectors),
      supporters: inbound.supporters,
      objectors: inbound.objectors,
      stance,
      mirrored,
      statements: Object.fromEntries(
        [target, ...inbound.supporters, ...inbound.objectors]
          .filter((id) => claims[id]?.text)
          .map((id) => [id, claims[id].text])
      )
    })
  } catch (err) {
    return sendJson(res, 502, { error: `Consensus status failed: ${err.message}` })
  }
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

// Read + normalize map.json once per request. No map at all is fine too:
// every overlay is optional and applies as annotation only.
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
    // The map may hide entries (`ignore`). A hidden folder hides its whole
    // contents with it: never walk into it at all.
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

  // One sort rule, same as orderForIndex in the views: documents first, then
  // folders. When the map sets `order`, ordered entries come first (ascending)
  // regardless of type; the rest fall back to the name rule.
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
  if (!rel) return sendJson(res, 400, { error: 'Parameter path is required.' })

  const abs = safeJoin(rootAbs, rel)
  if (!abs) return sendJson(res, 400, { error: `Path outside the knowledge base: ${rel}` })

  let stat
  try {
    stat = await fs.stat(abs)
  } catch {
    return sendJson(res, 404, { error: `File not found: ${rel}` })
  }
  if (stat.isDirectory()) return sendJson(res, 400, { error: `That is a folder, not a file: ${rel}` })
  if (stat.size > MAX_DOC_BYTES) {
    return sendJson(res, 413, { error: `File too large to display (${formatBytes(stat.size)}).` })
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
  if (!rel) return sendJson(res, 400, { error: 'Parameter path is required.' })

  const abs = safeJoin(rootAbs, rel)
  if (!abs) return sendJson(res, 400, { error: `Path outside the knowledge base: ${rel}` })

  let stat
  try {
    stat = await fs.stat(abs)
  } catch {
    return sendJson(res, 404, { error: `File not found: ${rel}` })
  }
  if (!stat.isFile()) return sendJson(res, 400, { error: `Not a file: ${rel}` })

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
    res.end('UI not built yet. Run: npm run build')
    return
  }

  let rel = decodeURIComponent(pathname)
  if (rel.endsWith('/')) rel += 'index.html'

  let abs = safeJoin(distAbs, rel.replace(/^\/+/, ''))
  if (!abs) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Access denied.')
    return
  }

  let stat = await statOrNull(abs)
  if (stat?.isDirectory()) {
    abs = path.join(abs, 'index.html')
    stat = await statOrNull(abs)
  }

  if (!stat || !stat.isFile()) {
    // No extension means an SPA route request, not a missing file.
    if (!path.extname(rel)) {
      abs = path.join(distAbs, 'index.html')
      stat = await statOrNull(abs)
    }
    if (!stat || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('File not found.')
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
