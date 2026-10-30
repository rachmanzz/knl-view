import { promises as fs } from 'node:fs'
import path from 'node:path'
import { GraphNode } from './model.js'
import { edgeKey } from './anchordb_client.js'
import { SYNTAX_LANGUAGES, extractImportSpecifiers } from './syntax.js'

// Sources graph: the whole project as a dependency graph in AnchorDB, not
// just the .knowledges markdown. Every file becomes a node (id = repo
// relative path); import edges come from tree-sitter syntax extraction
// (JS family and Go today, one uniform API per language). Hidden paths
// (dot-prefixed) are skipped except .github; node_modules, dist, and
// .gitignore patterns are skipped so dependency folders cannot flood the
// graph.
//
// Everything lives in the server. Nodes are records with numeric attributes
// only (AnchorDB admits no text), enumerated with list(); edges are stored
// in both directions (imports and imported_by) because causalChain walks
// forward only, and both directions are needed for lineage. Sync is
// server-authoritative: it enumerates what the server already has instead
// of trusting a local mirror.
//
// Removed files: the protocol has no delete, so their record is marked with
// the tombstone attribute (2 = gone, 0 = alive) after its edges are
// unlinked. Tombstoned records are skipped by every later sync and are
// unreachable in a trace; if the file reappears, a normal attribute save
// lifts the tombstone and the edges are relinked.

export const SOURCE_RELATIONS = ['imports', 'imported_by']
export const SOURCE_TOMBSTONE = 2
const DEFAULT_IGNORES = ['node_modules', 'dist', 'build', 'coverage']

const JS_EXTS = new Set(['.js', '.mjs', '.cjs'])

/** One ignore rule after parsing a .gitignore line. */
function ignoreRule(line) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) return null
  const dirOnly = trimmed.endsWith('/')
  const pattern = trimmed.replace(/\/+$/, '')
  return { dirOnly, pattern }
}

/**
 * Size in whole KB and mtime in whole days since the epoch: the two numeric
 * attributes AnchorDB can hold for a file. They are informational; change
 * detection never depends on them, it diffs the edge sets.
 */
function fileAttrs(stat) {
  return { size: Math.ceil(stat.size / 1024), mtime: Math.floor(stat.mtimeMs / 86400000) }
}

/**
 * Walk the project root and return every file that belongs in the sources
 * graph: { rel -> { size, mtime } }. Skips dot-prefixed folders except
 * .github, the default ignore list, and basic .gitignore patterns.
 */
export async function scanSourceFiles(rootAbs) {
  const rules = []
  try {
    const gitignore = await fs.readFile(path.join(rootAbs, '.gitignore'), 'utf8')
    for (const line of gitignore.split('\n')) {
      const rule = ignoreRule(line)
      if (rule) rules.push(rule)
    }
  } catch {
    // No .gitignore: the default list still applies.
  }
  rules.push(...DEFAULT_IGNORES.map((pattern) => ({ dirOnly: true, pattern })))

  const ignored = (rel) => {
    const segments = rel.split('/')
    if (segments.some((s) => s.startsWith('.') && s !== '.github')) return true
    return segments.some((segment) =>
      rules.some((rule) => {
        if (rule.pattern.includes('*')) {
          const re = new RegExp('^' + rule.pattern.replace(/\*/g, '[^/]*') + '$')
          return re.test(segment) || re.test(rel)
        }
        if (rule.dirOnly) return segments.includes(rule.pattern)
        return segment === rule.pattern || rel === rule.pattern
      })
    )
  }

  const files = {}
  const walk = async (dirAbs, rel) => {
    let entries
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.github') continue
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (ignored(childRel)) continue
      const childAbs = path.join(dirAbs, entry.name)
      if (entry.isDirectory()) {
        await walk(childAbs, childRel)
        continue
      }
      if (!entry.isFile()) continue
      try {
        files[childRel] = fileAttrs(await fs.stat(childAbs))
      } catch {
        // Raced with a deletion between readdir and stat: skip the file.
      }
    }
  }
  await walk(rootAbs, '')
  return files
}

/**
 * Relative specifiers from one JS file's text: ESM import/export sources,
 * dynamic import(), and CommonJS require(). Bare and URL specifiers are
 * skipped; only './' and '../' resolve to project files.
 *
 * Extraction itself is tree-sitter (syntax.js); this function is the JS
 * half of resolution: which extracted specifiers point at project files.
 */
export function resolveJsSpecifiers(fromRel, specs, files) {
  const relative = specs.filter((spec) => spec.startsWith('./') || spec.startsWith('../'))
  return relative.map((spec) => resolveImportSpecifier(fromRel, spec, files)).filter(Boolean)
}

/**
 * Module path declared by the project's go.mod, or null when there is
 * none. Go imports only resolve against it: a specifier equal to the
 * module path or starting with it is local, everything else (standard
 * library, remote modules) is external to the graph.
 */
export async function goModulePath(rootAbs) {
  try {
    const text = await fs.readFile(path.join(rootAbs, 'go.mod'), 'utf8')
    const match = text.match(/^module\s+(\S+)/m)
    return match ? match[1] : null
  } catch {
    return null
  }
}

/**
 * Resolve one Go import specifier to the local files of the imported
 * package: every .go file in the specifier's directory below the module
 * root. Returns [] for anything outside the module.
 */
export function resolveGoSpecifiers(spec, modulePath, files) {
  if (!modulePath) return []
  let sub
  if (spec === modulePath) sub = ''
  else if (spec.startsWith(modulePath + '/')) sub = spec.slice(modulePath.length + 1)
  else return []
  const dir = sub === '' ? '.' : sub
  return Object.keys(files).filter((rel) => rel.endsWith('.go') && path.posix.dirname(rel) === dir)
}

/**
 * Resolve one relative specifier from file `fromRel` against the set of
 * scanned files. Tries the exact path, the JS extensions, and an index
 * file inside the directory.
 */
export function resolveImportSpecifier(fromRel, spec, files) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec))
  const candidates = [base]
  for (const ext of JS_EXTS) candidates.push(base + ext)
  for (const ext of JS_EXTS) candidates.push(`${base}/index${ext}`)
  return candidates.find((candidate) => files[candidate]) || null
}

/**
 * Build the desired sources graph: nodes for every scanned file, import
 * edges from tree-sitter extraction (JS relative imports, Go module-internal
 * imports). Returns plain arrays so callers can diff without depending on
 * the DirectedGraph type.
 */
export async function buildSourcesGraph(rootAbs, files = null) {
  const scanned = files || await scanSourceFiles(rootAbs)
  const modulePath = await goModulePath(rootAbs)
  const edges = []
  for (const [rel] of Object.entries(scanned)) {
    const ext = path.posix.extname(rel).toLowerCase()
    if (!SYNTAX_LANGUAGES[ext]) continue
    let content
    try {
      content = await fs.readFile(path.join(rootAbs, rel), 'utf8')
    } catch {
      continue
    }
    let specs
    try {
      specs = await extractImportSpecifiers(ext, content)
    } catch {
      continue
    }
    const targets = ext === '.go'
      ? specs.flatMap((spec) => resolveGoSpecifiers(spec, modulePath, scanned))
      : resolveJsSpecifiers(rel, specs, scanned)
    for (const target of targets) {
      if (target && target !== rel) edges.push({ from: rel, to: target })
    }
  }
  const nodes = Object.entries(scanned).map(([rel, attrs]) => new GraphNode({
    id: rel,
    title: rel,
    type: 'file',
    path: rel,
    metadata: attrs
  }))
  return { nodes, edges }
}

/**
 * Desired edge keys in both directions, for diffing against the server.
 */
export function desiredSourceEdgeKeys(edges) {
  const keys = new Set()
  for (const { from, to } of edges) {
    keys.add(edgeKey(from, 'imports', to))
    keys.add(edgeKey(to, 'imported_by', from))
  }
  return keys
}

/**
 * Server-authoritative sync. Enumerates the server's own nodes (list) and
 * edges (one causalChain per node per relation), diffs them against the
 * freshly scanned disk state, and applies the difference. No local mirror:
 * the server is the single source of truth.
 *
 * Records of removed files are not deletable (the protocol has no delete),
 * so their edges are unlinked and the record stays edgeless and invisible.
 *
 * @returns {Promise<{linked, unlinked, saved, failed, nodes, edges}>}
 */
export async function syncSourcesToAnchorDB(client, rootAbs) {
  const { nodes, edges } = await buildSourcesGraph(rootAbs)
  const desired = desiredSourceEdgeKeys(edges)
  const diskIds = new Set(nodes.map((node) => node.id))

  // Page through the full record list: server truth for which nodes exist.
  // Tombstoned records are invisible: not nodes, not seeds, not savable.
  const serverAttrs = new Map()
  let offset = 0
  for (;;) {
    const page = await client.list({ limit: 500, offset })
    for (const item of page.items || []) {
      if ((item.props || {}).tombstone === SOURCE_TOMBSTONE) continue
      serverAttrs.set(item.name, item.props || {})
    }
    if (!page.hasMore || !page.items?.length) break
    offset += page.items.length
  }

  // Server truth for edges: walk every known node once per relation.
  const existing = new Set()
  const seeds = new Set([...serverAttrs.keys()])
  for (const { from, to } of edges) {
    seeds.add(from)
    seeds.add(to)
  }
  for (const seed of seeds) {
    for (const relation of SOURCE_RELATIONS) {
      let rows
      try {
        rows = await client.causalChain([seed], relation, 1000)
      } catch {
        continue
      }
      for (const row of rows || []) existing.add(edgeKey(seed, relation, row.word))
    }
  }

  let linked = 0
  let unlinked = 0
  let saved = 0
  let tombstoned = 0
  let failed = 0

  for (const key of desired) {
    if (existing.has(key)) continue
    const [from, type, to] = key.split('\u0000')
    try {
      await client.link(from, type, to, 1.0)
      linked += 1
    } catch {
      failed += 1
    }
  }
  for (const key of existing) {
    if (desired.has(key)) continue
    const [from, type, to] = key.split('\u0000')
    try {
      await client.unlink(from, type, to)
      unlinked += 1
    } catch {
      failed += 1
    }
  }

  // Server records whose file is gone: their edges are already unlinked
  // above; mark them with the tombstone attribute so no later sync or trace
  // ever reaches them again.
  for (const name of serverAttrs.keys()) {
    if (diskIds.has(name)) continue
    try {
      await client.saveWithID(name, { tombstone: SOURCE_TOMBSTONE })
      tombstoned += 1
    } catch {
      failed += 1
    }
  }

  // Node records carry the numeric attributes. Existing records are only
  // re-saved when their attributes changed; tombstone 0 keeps the alive
  // state explicit even if the server merges attributes.
  for (const node of nodes) {
    const current = serverAttrs.get(node.id)
    if (current && current.size === node.metadata.size && current.mtime === node.metadata.mtime) continue
    try {
      await client.saveWithID(node.id, {
        size: node.metadata.size,
        mtime: node.metadata.mtime,
        tombstone: 0
      })
      saved += 1
    } catch {
      failed += 1
    }
  }

  return { linked, unlinked, saved, tombstoned, failed, nodes: nodes.length, edges: desired.size / 2 }
}

/**
 * Lineage over the sources graph, entirely server-side: `out` follows
 * imports, `in` follows the mirrored imported_by edges. causalChain is
 * direct-only, so hops beyond one are walked level by level. Returns
 * [id, hop] entries per direction; callers shape the response.
 */
export async function traceSources(client, target, direction = 'both', maxHops = 2) {
  const walk = async (start, relation) => {
    const seen = new Map()
    let frontier = [start]
    for (let hop = 1; hop <= maxHops; hop++) {
      const next = []
      for (const node of frontier) {
        let rows
        try {
          rows = await client.causalChain([node], relation, 1000)
        } catch {
          continue
        }
        for (const row of rows || []) {
          if (!seen.has(row.word)) {
            seen.set(row.word, hop)
            next.push(row.word)
          }
        }
      }
      frontier = next
      if (!next.length) break
    }
    return [...seen.entries()].filter(([id]) => id !== start)
  }
  const out = direction === 'in' ? [] : await walk(target, 'imports')
  const inc = direction === 'out' ? [] : await walk(target, 'imported_by')
  return { out, in: inc }
}
