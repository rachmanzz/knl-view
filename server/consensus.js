import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// Consensus: agreement and conflict between claims, stored purely in
// AnchorDB as a second model (the "consensus" role in the project's models
// map). Claims relate only to other claims, never to decisions or files.
//
// A claim is content-addressed: id = "c-" + the first 16 hex chars of the
// statement's SHA-256, so the same statement is the same id on every
// machine. AnchorDB schemas only admit float32 attributes, so the statement
// text cannot live in the server; the local index below is a convenience
// cache (same nature as the sync mirror), never the source of the
// consensus structure.
//
// Relation types are fixed so status derivation stays meaningful:
//   agrees_with: the source claim supports the target claim
//   contradicts: the source claim opposes the target claim

export const CONSENSUS_RELATIONS = ['agrees_with', 'contradicts']

/**
 * Content-addressed claim id from the statement text.
 * @param {string} text
 * @returns {string} "c-" plus 16 hex characters
 */
export function claimId(text) {
  const normalized = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ')
  const hash = crypto.createHash('sha256').update(normalized).digest('hex')
  return `c-${hash.slice(0, 16)}`
}

/**
 * Derive consensus status for one claim from who points at it.
 * Any objection outweighs support: a single contradicts makes the claim
 * disputed even if many agree with it.
 * @returns {'disputed'|'consensus'|'uncontested'}
 */
export function deriveStatus(supporters, objectors) {
  if (objectors.length > 0) return 'disputed'
  if (supporters.length > 0) return 'consensus'
  return 'uncontested'
}

/** Local cache path for claim statements: ~/.knlview/claims/<model>.json */
export function claimsIndexPath(model, home = process.env.HOME) {
  return path.join(home || '', '.knlview', 'claims', `${model}.json`)
}

/**
 * Read the claim index. Missing file = empty index, not an error.
 * @returns {Promise<{claims: object, error: string|null}>}
 */
export async function readClaimsIndex(model, home = process.env.HOME) {
  try {
    const parsed = JSON.parse(await fs.readFile(claimsIndexPath(model, home), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { claims: {}, error: 'claim index is not an object' }
    }
    const claims = {}
    for (const [id, entry] of Object.entries(parsed)) {
      if (entry && typeof entry === 'object' && typeof entry.text === 'string') {
        claims[id] = entry
      }
    }
    return { claims, error: null }
  } catch (err) {
    if (err?.code === 'ENOENT') return { claims: {}, error: null }
    return { claims: {}, error: err.message }
  }
}

/**
 * Register a claim statement in the local index. Content-addressed, so
 * re-registering the same statement is an idempotent update.
 */
export async function recordClaim(model, text, home = process.env.HOME) {
  const id = claimId(text)
  const { claims, error } = await readClaimsIndex(model, home)
  if (error) return { id, written: false, error }
  if (!claims[id]) claims[id] = { text: String(text).trim(), createdAt: new Date().toISOString() }
  try {
    const file = claimsIndexPath(model, home)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify(claims, null, 2) + '\n', 'utf8')
    return { id, written: true, error: null }
  } catch (err) {
    return { id, written: false, error: err.message }
  }
}

// Consensus mirror
// The wire protocol only walks edges forward (causalChain), but "who agrees
// with this claim?" is an inbound question. So every successful link/unlink
// also updates a local mirror of the consensus model's edges, the same
// pattern the knowledges graph already uses. The mirror is a read model:
// losing it only degrades inbound queries, never the server's data.

export function consensusEdgeKey(from, type, to) {
  return `${from}\u0000${type}\u0000${to}`
}

/**
 * Read the consensus mirror for one model. Returns the edge key list, or
 * null when there is no mirror (never synced, or wiped).
 */
export async function readConsensusMirror(model, home = process.env.HOME) {
  try {
    const file = path.join(home || '', '.knlview', 'sync-state', `${model}.json`)
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
    if (parsed?.model !== model || !Array.isArray(parsed.edges)) return null
    return parsed.edges
  } catch {
    return null
  }
}

/**
 * Apply one change to the consensus mirror. Best effort: a failed mirror
 * write is reported but never blocks the server mutation that already
 * succeeded.
 */
export async function updateConsensusMirror(model, change, home = process.env.HOME) {
  const edges = new Set(await readConsensusMirror(model, home) || [])
  if (change.op === 'link') edges.add(consensusEdgeKey(change.from, change.type, change.to))
  if (change.op === 'unlink') {
    edges.delete(consensusEdgeKey(change.from, 'agrees_with', change.to))
    edges.delete(consensusEdgeKey(change.from, 'contradicts', change.to))
  }
  try {
    const file = path.join(home || '', '.knlview', 'sync-state', `${model}.json`)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({
      model,
      syncedAt: new Date().toISOString(),
      edges: Array.from(edges)
    }), 'utf8')
    return { error: null }
  } catch (err) {
    return { error: err.message }
  }
}

/**
 * Inbound half of consensus status, walked backwards over the mirror:
 * supporters (incoming agrees_with) and objectors (incoming contradicts).
 * @returns {{ supporters: string[], objectors: string[] }}
 */
export function inboundConsensus(mirrorEdges, targetId) {
  const supporters = []
  const objectors = []
  for (const key of mirrorEdges || []) {
    const [from, type, to] = key.split('\u0000')
    if (to !== targetId) continue
    if (type === 'agrees_with') supporters.push(from)
    else if (type === 'contradicts') objectors.push(from)
  }
  return { supporters, objectors }
}

/**
 * Outbound half: the claim's own stance, walked forward over the mirror.
 * @returns {{ agrees: string[], contradicts: string[] }}
 */
export function outboundConsensus(mirrorEdges, sourceId) {
  const agrees = []
  const contradicts = []
  for (const key of mirrorEdges || []) {
    const [from, type, to] = key.split('\u0000')
    if (from !== sourceId) continue
    if (type === 'agrees_with') agrees.push(to)
    else if (type === 'contradicts') contradicts.push(to)
  }
  return { agrees, contradicts }
}
