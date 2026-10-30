import { connectWire } from '@rahmantech/anchorwire'

/**
 * Optional bridge module to the AnchorDB backend via the AnchorWire protocol
 * (wire://). Follows the KISS principle: active only when configured, with
 * graceful fallback.
 */

/**
 * Open an AnchorWire client connection.
 * @param {string|object} urlOrOptions - Example: 'wire://127.0.0.1:7448?model=knowledges'
 */
export async function createAnchorWireClient(urlOrOptions) {
  try {
    const client = await connectWire(urlOrOptions)
    return client
  } catch (err) {
    const target = typeof urlOrOptions === 'string'
      ? urlOrOptions
      : `${urlOrOptions?.host || '?'}:${urlOrOptions?.port || '?'}`
    throw new Error(`Failed to connect to AnchorDB (${target}): ${err.message}`)
  }
}

/**
 * Stable key for one edge, for diffing and the mirror: "from\x00type\x00to".
 * NUL is used because it cannot appear in healthy markdown IDs.
 */
export function edgeKey(from, type, to) {
  return `${from}\u0000${type}\u0000${to}`
}

/**
 * Collect the set of unique edges from a DirectedGraph. Duplicate edges in
 * markdown (one decision writing supersedes twice, say) only need to be sent
 * to the server once.
 * @param {import('./model.js').DirectedGraph} graph
 * @returns {string[]} sorted edge keys
 */
export function edgesOfGraph(graph) {
  const set = new Set()
  for (const edge of graph?.edges ?? []) {
    if (edge?.from && edge?.type && edge?.to) set.add(edgeKey(edge.from, edge.type, edge.to))
  }
  return Array.from(set).sort()
}

/**
 * Diff two edge sets: what must be sent as link and unlink.
 * @param {string[]} desired - edges that should exist (the current local graph)
 * @param {string[]|null} previous - edges per the last sync mirror;
 *   null means no mirror (the server is assumed empty → full link)
 * @returns {{toLink: string[], toUnlink: string[]}}
 */
export function diffEdges(desired, previous) {
  const now = new Set(desired)
  if (!previous) return { toLink: [...now], toUnlink: [] }
  const before = new Set(previous)
  return {
    toLink: desired.filter((k) => !before.has(k)),
    toUnlink: previous.filter((k) => !now.has(k))
  }
}

function isEdgeNotFound(err) {
  return /edge not found/i.test(err?.message || '')
}

/**
 * Cheap check that the server still recognizes one sample edge from the
 * mirror. If the sample edge does not show up in causalChain, the server is
 * considered different (reinstalled, wiped, model reset) and the mirror must
 * be discarded so the sync becomes a full link. Link is an upsert, so a full
 * link is always safe; what is dangerous is trusting a mirror against an
 * empty server.
 */
export async function mirrorStillValid(client, previousEdges) {
  if (!Array.isArray(previousEdges) || previousEdges.length === 0) return Boolean(previousEdges)
  const [from, type, to] = previousEdges[0].split('\u0000')
  try {
    const results = await client.causalChain([from], type, 5)
    return results.some((item) => item?.word === to)
  } catch {
    return false
  }
}

/**
 * Sync the graph to AnchorDB INCREMENTALLY: only new edges are linked, edges
 * missing from markdown are unlinked, the rest are left alone. The server
 * offers no edge enumeration, so the comparator is the mirror of the last
 * sync (`previousEdges` from the local sync-state), and the mirror is
 * verified with one causal probe before being trusted.
 *
 * Unlinking an edge that no longer exists on the server is treated as
 * success (case: the container/server was reinstalled but the mirror remains).
 *
 * @param {import('@rahmantech/anchorwire').AnchorWireClient} client
 * @param {import('./model.js').DirectedGraph} graph
 * @param {string[]|null} previousEdges - mirror of the last sync (null = full sync)
 * @returns {Promise<{linked: number, unlinked: number, kept: number, failed: number, edges: string[]}>}
 *   `edges` = the full edge set after the sync, to be written to the mirror
 *   ONLY when `failed === 0`. On partial failure the mirror is not written so
 *   the next start retries the failed part.
 */
export async function syncGraphToAnchorDB(client, graph, previousEdges = null) {
  if (!client || !graph) return { linked: 0, unlinked: 0, kept: 0, failed: 0, edges: [] }

  const edges = edgesOfGraph(graph)
  if (previousEdges && !(await mirrorStillValid(client, previousEdges))) {
    previousEdges = null
  }
  const { toLink, toUnlink } = diffEdges(edges, previousEdges)
  let linked = 0
  let unlinked = 0
  let failed = 0

  for (const key of toLink) {
    const [from, type, to] = key.split('\u0000')
    try {
      await client.link(from, type, to, 1.0)
      linked += 1
    } catch {
      failed += 1
    }
  }

  for (const key of toUnlink) {
    const [from, type, to] = key.split('\u0000')
    try {
      await client.unlink(from, type, to)
      unlinked += 1
    } catch (err) {
      // The edge no longer exists on the server: the end state equals what
      // we want, so it counts as success.
      if (isEdgeNotFound(err)) unlinked += 1
      else failed += 1
    }
  }

  return { linked, unlinked, kept: edges.length - linked, failed, edges }
}

/**
 * Distributed multi-hop causal chain trace on the AnchorDB server.
 *
 * The AnchorWire client uses a relations array as an ORDERED CHAIN of hops
 * (the second hop goes through the second relation), not "any one of". For
 * the knowledge graphs we want to trace a UNION of relations (DEC
 * --supersedes--> X or --affects_knowledge--> Y), each relation is traced
 * separately per hop and then merged: dedupe per node, highest score wins,
 * and each next hop's score is multiplied by its parent's.
 *
 * @param {import('@rahmantech/anchorwire').AnchorWireClient} client
 * @param {string} seedId - id of the center node of the query
 * @param {string|string[]} relations - relations to follow (e.g. ['supersedes', 'affects_knowledge', 'depends_on'])
 * @param {number} limitK - result limit per server call
 * @param {number} maxHops - trace hop radius
 */
export async function traceCausalChain(client, seedId, relations = ['supersedes', 'affects_knowledge', 'depends_on'], limitK = 20, maxHops = 2) {
  if (!client) throw new Error('AnchorWire client unavailable.')
  const rels = (Array.isArray(relations) ? relations : [relations]).filter(Boolean)
  if (!rels.length) return []

  const best = new Map() // word -> { word, score }
  let frontier = [{ word: seedId, score: 1 }]

  for (let hop = 1; hop <= Math.max(1, maxHops) && frontier.length; hop++) {
    const nextFrontier = []
    for (const { word, score } of frontier) {
      const perRelation = await Promise.all(
        rels.map((rel) => client.causalChain([word], rel, limitK).catch(() => []))
      )
      for (const results of perRelation) {
        for (const item of results) {
          if (!item?.word || item.word === seedId) continue
          const reached = { word: item.word, score: score * (item.score || 1) }
          const prev = best.get(reached.word)
          if (!prev || reached.score > prev.score) {
            best.set(reached.word, reached)
            nextFrontier.push(reached)
          }
        }
      }
    }
    frontier = nextFrontier
  }

  return Array.from(best.values()).sort((a, b) => b.score - a.score)
}

/**
 * Reverse traversal over the local sync mirror — the inbound half of
 * two-way lineage. The wire protocol has no "who points at X" query, but
 * the mirror holds every edge this project ever linked, which is exactly
 * the inbound map for this project's model. Entries carry score 1: the
 * server's relevance scoring only exists for forward chains.
 *
 * @param {string[]} mirrorEdges - edge keys "from\x00type\x00to" from the sync mirror
 * @param {string} seedId - id of the node to trace inbound from
 * @param {string[]} relations - relation types to follow
 * @param {number} maxHops - traversal radius
 * @returns {Array<{word: string, score: number}>}
 */
export function traceInboundFromMirror(mirrorEdges, seedId, relations, maxHops = 2) {
  if (!Array.isArray(mirrorEdges) || !mirrorEdges.length || !seedId) return []
  const wanted = new Set(relations.filter(Boolean))

  // Reverse adjacency: target node -> list of { source, type }.
  const inbound = new Map()
  for (const key of mirrorEdges) {
    const [from, type, to] = key.split('\u0000')
    if (!from || !to) continue
    if (wanted.size && !wanted.has(type)) continue
    if (!inbound.has(to)) inbound.set(to, [])
    inbound.get(to).push(from)
  }

  const best = new Map() // word -> depth reached (BFS, first reach wins)
  let frontier = [seedId]
  best.set(seedId, 0)

  for (let hop = 1; hop <= Math.max(1, maxHops) && frontier.length; hop++) {
    const nextFrontier = []
    for (const word of frontier) {
      for (const source of inbound.get(word) || []) {
        if (source === seedId || best.has(source)) continue
        best.set(source, hop)
        nextFrontier.push(source)
      }
    }
    frontier = nextFrontier
  }

  best.delete(seedId)
  return Array.from(best.keys()).map((word) => ({ word, score: 1 }))
}

/**
 * Merge forward (server-scored) and inbound (mirror) results into one
 * ranked list. A word reached both ways keeps the higher, meaningful score.
 */
export function mergeLineage(forward, inbound) {
  const merged = new Map()
  for (const { word, score } of forward) {
    merged.set(word, { word, score })
  }
  for (const { word, score } of inbound) {
    const prev = merged.get(word)
    if (!prev || score > prev.score) merged.set(word, { word, score })
  }
  return Array.from(merged.values()).sort((a, b) => b.score - a.score)
}
