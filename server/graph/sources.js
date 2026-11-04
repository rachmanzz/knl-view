import { promises as fs } from 'node:fs'
import path from 'node:path'
import { GraphNode } from './model.js'
import { edgeKey } from './anchordb_client.js'
import { SYNTAX_LANGUAGES, extractCode } from './syntax.js'
import { createPathMatcher, syncStatePath } from '../config.js'

// Sources graph: the whole project as a dependency graph in AnchorDB, not
// just the .knowledges markdown. Nodes are the files (id = repo relative
// path) and the named symbols they define (id = `<path>#<name>`, from
// tree-sitter syntax extraction: JS family, TS, Go, Python, Rust). Edges:
// file imports file, file defines symbol, symbol calls symbol, each stored
// in both directions because causalChain walks forward only. Hidden paths
// (dot-prefixed) are skipped except .github;
// node_modules, dist, and .gitignore patterns are skipped so dependency
// folders cannot flood the graph.
//
// Everything lives in the server. Nodes are records with numeric attributes
// only (AnchorDB admits no text), enumerated with list(); sync is
// server-authoritative: it enumerates what the server already has instead
// of trusting a local mirror. Label text (symbol names and kinds) lives in
// the project's label dir (.knowledges/.knl-data by default, overridable
// via the project config's labelDir), regenerated on every sync.
//
// Removed files: the record is archived with opcode 2 (TOMBSTONE, hidden
// from list and lookups) and purged by a collector run; a save revives it.

export const SOURCE_RELATIONS = ['imports', 'imported_by']
export const SOURCE_TOMBSTONE = 2
// OpStatus on the wire: 2 = Archived (TOMBSTONE).
export const OP_ARCHIVED = 2
// Symbol layer, same AnchorDB model as the files: a file defines symbols,
// symbols call symbols. Mirrored both directions like imports, for the same
// reason: causalChain walks forward only.
export const SYMBOL_RELATIONS = ['defines', 'defined_in', 'calls', 'called_by']
export const SYNC_RELATIONS = [...SOURCE_RELATIONS, ...SYMBOL_RELATIONS]

const REVERSE_EDGE = {
  imports: 'imported_by',
  defines: 'defined_in',
  calls: 'called_by'
}

// Symbol kinds whose name may serve as a same-file receiver: a call
// `Foo.bar()` in the file that declares Foo. The qualified candidate must
// still match exactly one definition, so this only widens the evidence,
// never the ambiguity rule.
const RECEIVER_KINDS = new Set(['class', 'struct', 'trait', 'interface', 'enum', 'type'])

// Where generated label files live inside the target project: the label
// text AnchorDB cannot hold (numeric-only attributes). Overridable via the
// project config's labelDir.
const DEFAULT_LABEL_DIR = '.knowledges/.knl-data'
const DEFAULT_IGNORES = ['node_modules', 'dist', 'build', 'coverage']

const JS_TS_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx'])

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
function compileIgnorePattern(pattern) {
  if (!pattern || !pattern.includes('*')) return null
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
  try {
    return new RegExp('^' + escaped + '$')
  } catch {
    return null
  }
}

export async function scanSourceFiles(rootAbs, { include = null, exclude = null } = {}) {
  const excludeFilter = createPathMatcher(exclude)
  const includeFilter = createPathMatcher(include)

  const rules = []
  try {
    const gitignore = await fs.readFile(path.join(rootAbs, '.gitignore'), 'utf8')
    for (const line of gitignore.split('\n')) {
      const rule = ignoreRule(line)
      if (rule) {
        rule.regex = compileIgnorePattern(rule.pattern)
        rules.push(rule)
      }
    }
  } catch {
    // No .gitignore: the default list still applies.
  }
  rules.push(...DEFAULT_IGNORES.map((pattern) => ({ dirOnly: true, pattern, regex: compileIgnorePattern(pattern) })))

  const isDefaultIgnored = (rel, isDir) => {
    const segments = rel.split('/')
    if (segments.some((s) => s.startsWith('.') && s !== '.github')) return true
    return segments.some((segment) =>
      rules.some((rule) => {
        if (rule.regex) {
          return rule.regex.test(segment) || rule.regex.test(rel)
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
      const childRel = rel ? `${rel}/${entry.name}` : entry.name

      // 1. Hard exclude: knl-config exclude is truly excluded, always wins
      if (excludeFilter && excludeFilter.matches(childRel, entry.name)) {
        continue
      }

      // 2. Explicit include overrides default excludes
      const isExplicitlyIncluded = includeFilter && includeFilter.matches(childRel, entry.name)
      const isDirPrefixOfInclude = entry.isDirectory() && includeFilter && includeFilter.isPrefixOfAny(childRel)

      if (entry.isDirectory()) {
        if (!isExplicitlyIncluded && !isDirPrefixOfInclude) {
          if (includeFilter) {
            continue
          }
          if (isDefaultIgnored(childRel, true)) {
            continue
          }
        }
        await walk(path.join(dirAbs, entry.name), childRel)
        continue
      }

      if (!entry.isFile()) continue

      if (includeFilter) {
        if (!isExplicitlyIncluded) continue
      } else {
        if (isDefaultIgnored(childRel, false)) continue
      }

      const childAbs = path.join(dirAbs, entry.name)
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
 * scanned files. Tries the exact path, JS/TS extension fallbacks (including
 * mapping .js specifiers in TS ESM to .ts/.tsx on disk), and directory index files.
 */
export function resolveImportSpecifier(fromRel, spec, files) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec))
  const candidates = [base]
  if (base.endsWith('.js')) {
    candidates.push(base.slice(0, -3) + '.ts', base.slice(0, -3) + '.tsx')
  } else if (base.endsWith('.mjs')) {
    candidates.push(base.slice(0, -4) + '.mts')
  } else if (base.endsWith('.cjs')) {
    candidates.push(base.slice(0, -4) + '.cts')
  }
  for (const ext of JS_TS_EXTS) candidates.push(base + ext)
  for (const ext of JS_TS_EXTS) candidates.push(`${base}/index${ext}`)
  return candidates.find((candidate) => files[candidate]) || null
}

/**
 * Resolve Python import specifiers: relative dots (e.g. .local, ..utils) and
 * module paths (e.g. pkg.sub) to .py or /__init__.py files in scanned files.
 */
export function resolvePySpecifiers(fromRel, specs, files) {
  const dir = path.posix.dirname(fromRel)
  const resolved = []
  for (const spec of specs) {
    const candidates = []
    const m = spec.match(/^(\.+)(.*)$/)
    if (m) {
      const dotCount = m[1].length
      const rest = m[2].replace(/\./g, '/')
      let targetDir = dir
      for (let i = 1; i < dotCount; i++) targetDir = path.posix.dirname(targetDir)
      const base = rest ? path.posix.normalize(path.posix.join(targetDir, rest)) : targetDir
      candidates.push(base + '.py', path.posix.join(base, '__init__.py'))
    } else {
      const asPath = spec.replace(/\./g, '/')
      candidates.push(
        asPath + '.py',
        path.posix.join(asPath, '__init__.py'),
        path.posix.normalize(path.posix.join(dir, asPath)) + '.py',
        path.posix.normalize(path.posix.join(dir, asPath, '__init__.py'))
      )
    }
    const found = candidates.find((c) => files[c])
    if (found && !resolved.includes(found)) resolved.push(found)
  }
  return resolved
}

/**
 * Resolve Rust import specifiers: `crate::`, `super::`, `self::`, and `./`
 * (from `mod foo;`) to .rs or /mod.rs files in scanned files.
 */
export function resolveRustSpecifiers(fromRel, specs, files) {
  const dir = path.posix.dirname(fromRel)
  let crateRoot = '.'
  const srcIdx = fromRel.indexOf('src/')
  if (srcIdx >= 0) {
    crateRoot = fromRel.slice(0, srcIdx + 3)
  }
  const resolved = []
  for (const spec of specs) {
    const candidates = []
    if (spec.startsWith('crate::')) {
      const rest = spec.slice('crate::'.length).split('::').join('/')
      const parts = rest.split('/')
      for (let i = parts.length; i >= 1; i--) {
        const sub = parts.slice(0, i).join('/')
        candidates.push(
          path.posix.normalize(path.posix.join(crateRoot, sub)) + '.rs',
          path.posix.normalize(path.posix.join(crateRoot, sub, 'mod.rs'))
        )
      }
    } else if (spec.startsWith('super::')) {
      const rest = spec.slice('super::'.length).split('::').join('/')
      const parentDir = path.posix.dirname(dir)
      const parts = rest.split('/')
      for (let i = parts.length; i >= 1; i--) {
        const sub = parts.slice(0, i).join('/')
        candidates.push(
          path.posix.normalize(path.posix.join(parentDir, sub)) + '.rs',
          path.posix.normalize(path.posix.join(parentDir, sub, 'mod.rs'))
        )
      }
    } else if (spec.startsWith('self::') || spec.startsWith('./')) {
      const raw = spec.startsWith('self::') ? spec.slice('self::'.length).split('::').join('/') : spec.slice(2)
      const parts = raw.split('/')
      for (let i = parts.length; i >= 1; i--) {
        const sub = parts.slice(0, i).join('/')
        candidates.push(
          path.posix.normalize(path.posix.join(dir, sub)) + '.rs',
          path.posix.normalize(path.posix.join(dir, sub, 'mod.rs'))
        )
      }
    }
    const found = candidates.find((c) => files[c])
    if (found && !resolved.includes(found)) resolved.push(found)
  }
  return resolved
}

/**
 * Build the desired sources graph: nodes for every scanned file plus one
 * node per named symbol, and edges from tree-sitter extraction (file-level
 * imports, file-defines-symbol, symbol-calls-symbol). Symbol node ids are
 * `<path>#<name>`; class methods are `Class.method`. Returns plain arrays
 * so callers can diff without depending on the DirectedGraph type.
 */
export async function buildSourcesGraph(rootAbs, files = null, options = {}) {
  const scanned = files || await scanSourceFiles(rootAbs, options)
  const modulePath = await goModulePath(rootAbs)
  const edges = []
  const symbolIndex = new Map() // symbol name -> [node id, ...] for call resolution
  const symbolsByFile = new Map() // file rel -> symbol nodes
  // Total size of the scanned sources, in whole KB as the scanner stores
  // it. Feeds the drift sensor's second aggregate, not precision claims.
  const fileBytes = Object.values(scanned).reduce((sum, file) => sum + (file.size || 0), 0)

  const structure = {}
  for (const [rel] of Object.entries(scanned)) {
    const ext = path.posix.extname(rel).toLowerCase()
    if (!SYNTAX_LANGUAGES[ext]) continue
    let content
    try {
      content = await fs.readFile(path.join(rootAbs, rel), 'utf8')
    } catch {
      continue
    }
    let extracted
    try {
      extracted = await extractCode(ext, content)
    } catch {
      continue
    }
    structure[rel] = { ext, modulePath, ...extracted }

    // A name defined more than once in one file would collide on one
    // AnchorDB record id, so repeated names get a line suffix: `@<line>`.
    const nameCounts = new Map()
    for (const symbol of extracted.symbols) {
      nameCounts.set(symbol.name, (nameCounts.get(symbol.name) || 0) + 1)
    }
    const fileSymbols = extracted.symbols.map((symbol) => ({
      ...symbol,
      id: nameCounts.get(symbol.name) > 1
        ? `${rel}#${symbol.name}@${symbol.line}`
        : `${rel}#${symbol.name}`
    }))
    if (fileSymbols.length) symbolsByFile.set(rel, fileSymbols)
    // ResolveCallTargets builds call edges *from* these symbols, so store
    // the id-carrying list (duplicate names already line-suffixed here).
    structure[rel].symbols = fileSymbols
    for (const symbol of fileSymbols) {
      symbolIndex.set(symbol.name, [...(symbolIndex.get(symbol.name) || []), symbol.id])
      edges.push({ from: rel, to: symbol.id, type: 'defines' })
    }
  }
  // callResolution feeds the label files: skipped call sites per symbol so a
  // reader of the labels sees what the resolver chose not to link.

  const callResolution = new Map() // file rel -> Map(symbol id -> stats)
  for (const [rel, file] of Object.entries(structure)) {
    let targets = []
    if (file.ext === '.go') {
      targets = file.imports.flatMap((spec) => resolveGoSpecifiers(spec, file.modulePath, scanned))
    } else if (file.ext === '.py') {
      targets = resolvePySpecifiers(rel, file.imports, scanned)
    } else if (file.ext === '.rs') {
      targets = resolveRustSpecifiers(rel, file.imports, scanned)
    } else {
      targets = resolveJsSpecifiers(rel, file.imports, scanned)
    }
    for (const target of targets) {
      if (target && target !== rel) edges.push({ from: rel, to: target, type: 'imports' })
    }
    const calls = resolveCallTargets(rel, file, symbolIndex, scanned)
    if (calls.resolution.size) callResolution.set(rel, calls.resolution)
    for (const call of calls.targets) {
      edges.push({ from: call.from, to: call.to, type: 'calls' })
    }
  }

  const nodes = Object.entries(scanned).map(([rel, attrs]) => new GraphNode({
    id: rel,
    title: rel,
    type: 'file',
    path: rel,
    metadata: attrs
  }))
  for (const [rel, list] of symbolsByFile.entries()) {
    for (const symbol of list) {
      nodes.push(new GraphNode({
        id: symbol.id,
        title: symbol.id,
        type: 'symbol',
        path: rel,
        metadata: { line: symbol.line, lines: symbol.lines }
      }))
    }
  }
  return { nodes, edges, symbolsByFile, callResolution, fileBytes }
}

/**
 * Resolve a file's call sites to symbol nodes. The call is attributed to
 * the innermost enclosing symbol by line range; the target is resolved by
 * name: a name defined exactly once project-wide is unambiguous, anything
 * else is skipped rather than guessed. Go additionally accepts a qualified
 * callee (`Recv.Method`, `pkg.Fn`) and prefers a symbol defined in the
 * same package directory.
 *
 * A receiver counts as evidence when it is an import binding, or when it
 * names a class-like type defined in this same file (`Foo.bar()` inside
 * Foo's own module). A same-file receiver resolves through its qualified
 * name only: the bare fallback (the bare call name) stays gated on import
 * evidence, so `s.logger.Log()` still cannot be absorbed by a single
 * project-wide `Log()`.
 *
 * Returns { targets, resolution }: resolution maps each owner symbol id to
 * { matched, skipped, skippedReasons }. matched + skipped covers every
 * call site inside that symbol's body, so nothing is dropped silently.
 * Calls outside any symbol body are file-level and carry no owner.
 */
export function resolveCallTargets(fromRel, file, symbolIndex, scanned) {
  const symbols = file.symbols || []
  const dir = path.posix.dirname(fromRel)
  const resolution = new Map()
  const bucket = (id) => {
    let entry = resolution.get(id)
    if (!entry) {
      entry = { matched: 0, skipped: 0, skippedReasons: {} }
      resolution.set(id, entry)
    }
    return entry
  }
  const skip = (id, reason) => {
    const entry = bucket(id)
    entry.skipped += 1
    entry.skippedReasons[reason] = (entry.skippedReasons[reason] || 0) + 1
  }
  // A candidate resolves when exactly one definition matches, preferring
  // definitions in the same package directory; anything ambiguous or
  // external stays out of the graph.
  const resolve = (key) => {
    const ids = symbolIndex.get(key) || []
    const local = ids.filter((id) => path.posix.dirname(id.split('#')[0]) === dir)
    const pick = local.length === 1 ? local : ids
    return pick.length === 1 ? pick[0] : null
  }
  const importNames = file.importNames instanceof Set
    ? file.importNames
    : new Set(file.importNames || [])
  const ownTypes = new Set(
    symbols.filter((symbol) => RECEIVER_KINDS.has(symbol.kind)).map((symbol) => symbol.name)
  )
  const targets = []
  for (const call of file.calls || []) {
    // Innermost symbol containing the call row: same file, so ordering by
    // start line and taking the narrowest match is enough.
    let owner = null
    for (const symbol of symbols) {
      const start = symbol.line - 1
      const end = start + symbol.lines
      if (call.row >= start && call.row < end) {
        if (!owner || symbol.lines < owner.lines) owner = symbol
      }
    }
    if (!owner) continue
    const from = owner.id || `${fromRel}#${owner.name}`
    const importRecv = Boolean(call.recv) && importNames.has(call.recv)
    const ownRecv = Boolean(call.recv) && !importRecv && ownTypes.has(call.recv)
    if (call.recv && !importRecv && !ownRecv) {
      skip(from, 'local-receiver')
      continue
    }
    // Same-file receiver: the qualified name is the only candidate. Import
    // receivers may fall back to the bare name; a bare call has only the
    // bare name.
    const candidates = !call.recv
      ? [call.name]
      : ownRecv
        ? [`${call.recv}.${call.name}`]
        : [`${call.recv}.${call.name}`, call.name]
    let hit = null
    let self = false
    for (const key of candidates) {
      const to = resolve(key)
      if (!to) continue
      if (to === from) {
        // A self-edge would loop the trace; excluded on purpose, but never
        // silently: it still counts as a skipped site below.
        self = true
        break
      }
      hit = to
      break
    }
    if (self) {
      skip(from, 'self-call')
      continue
    }
    if (!hit) {
      skip(from, 'ambiguous-callee')
      continue
    }
    targets.push({ from, to: hit })
    bucket(from).matched += 1
  }
  return { targets, resolution }
}

/**
 * Desired edge keys in both directions for every relation type, for
 * diffing against the server.
 */
export function desiredSourceEdgeKeys(edges) {
  const keys = new Set()
  for (const { from, to, type = 'imports' } of edges) {
    keys.add(edgeKey(from, type, to))
    keys.add(edgeKey(to, REVERSE_EDGE[type], from))
  }
  return keys
}

/**
 * Label text for one file's symbols: the information AnchorDB cannot hold
 * (attributes are numeric-only). Written under the label dir as a mirror
 * of the repo-relative path, one .md per file that has symbols.
 */
export function labelContent(rel, symbols, resolution = null) {
  const lines = [`# ${rel}`, '']
  for (const symbol of symbols) {
    const info = resolution?.get(symbol.id)
    const note = info ? ` calls ${info.matched} linked, ${info.skipped} skipped` : ''
    const reasons = info && info.skipped
      ? ' (' + Object.entries(info.skippedReasons).map(([reason, count]) => `${reason} ${count}`).join(', ') + ')'
      : ''
    lines.push(`- \`${symbol.name}\` (${symbol.kind}, line ${symbol.line})${note}${reasons}`)
  }
  return lines.join('\n') + '\n'
}

/**
 * Reconcile the label files on disk with the current symbol state:
 * write files whose content changed, delete files whose file or last
 * symbol is gone. Generated files only; never touches anything else.
 */
export async function writeLabelFiles(rootAbs, labelDir = DEFAULT_LABEL_DIR, symbolsByFile, resolutionByFile = new Map()) {
  const base = path.resolve(rootAbs, labelDir)
  if (base !== rootAbs && !base.startsWith(rootAbs + path.sep)) {
    throw new Error(`labelDir "${labelDir}" resolves outside the project root`)
  }
  const expected = new Map()
  for (const [rel, symbols] of symbolsByFile) {
    expected.set(rel, labelContent(rel, symbols, resolutionByFile.get(rel)))
  }

  const existing = new Set()
  const walk = async (dir, rel) => {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), childRel)
      else if (entry.isFile() && entry.name.endsWith('.md')) existing.add(childRel.slice(0, -3))
    }
  }
  await walk(base, '')

  const written = []
  const deleted = []
  for (const [rel, content] of expected) {
    const abs = path.join(base, `${rel}.md`)
    let current = null
    try {
      current = await fs.readFile(abs, 'utf8')
    } catch {
      // No file yet: it will be written below.
    }
    if (current === content) continue
    try {
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.writeFile(abs, content, 'utf8')
      written.push(rel)
    } catch {
      // Label files are a convenience; a failed write is not a sync failure.
    }
  }
  for (const rel of existing) {
    if (expected.has(rel)) continue
    try {
      await fs.rm(path.join(base, `${rel}.md`), { force: true })
      deleted.push(rel)
    } catch {
      // Best effort too: a failed delete leaves one stale label file.
    }
  }
  return { written, deleted }
}

/**
 * Server-authoritative sync. Enumerates the server's own nodes (list) and
 * edges (one causalChain per node per relation), diffs them against the
 * freshly scanned disk state, and applies the difference. No local mirror:
 * the server is the single source of truth.
 *
 * Records of removed files and removed symbols are not deletable (the
 * protocol has no delete), so their edges are unlinked and the record is
 * tombstoned, invisible to every later sync and trace.
 *
 * @returns {Promise<{linked, unlinked, saved, tombstoned, failed, orphans,
 *   files, symbols, edges, labels}>}
 */
export async function syncSourcesToAnchorDB(client, rootAbs, { labelDir, include = null, exclude = null } = {}) {
  const { nodes, edges, symbolsByFile, callResolution, fileBytes } = await buildSourcesGraph(rootAbs, null, { include, exclude })
  const desired = desiredSourceEdgeKeys(edges)
  const diskIds = new Set(nodes.map((node) => node.id))

  // Page through the full record list: server truth for which nodes exist.
  // Records the server already archived (opcode 2) never appear here, so a
  // tombstone is written once and never revisited.
  const serverAttrs = new Map()
  let offset = 0
  for (;;) {
    const page = await client.list({ limit: 500, offset })
    for (const item of page.items || []) {
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
    for (const relation of SYNC_RELATIONS) {
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

  // Files gone from disk: edges are already unlinked; archive the record
  // (opcode 2) and keep the tombstone attr for servers without opcodes.
  const pending = []
  for (const name of serverAttrs.keys()) {
    if (diskIds.has(name)) continue
    pending.push({ name, props: { tombstone: SOURCE_TOMBSTONE }, operation: OP_ARCHIVED, tombstone: true })
  }

  // Node records carry the numeric attributes. Existing records are only
  // re-saved when their attributes changed; tombstone 0 keeps the alive
  // state explicit even if the server merges attributes.
  for (const node of nodes) {
    const current = serverAttrs.get(node.id)
    if (current && current.size === node.metadata.size && current.mtime === node.metadata.mtime
      && current.line === node.metadata.line && current.lines === node.metadata.lines) continue
    pending.push({ name: node.id, props: { ...node.metadata, tombstone: 0 } })
  }

  // Records alive on the server after this sync: pre-existing ones plus
  // whatever this sync successfully saved.
  const live = new Set(serverAttrs.keys())

  // One transactional batch when the wire client supports it (faster than
  // per-record saves at scale); per-record fallback keeps a single bad
  // record from losing the rest.
  const saveOne = async (item) => {
    await client.saveWithID(item.name, item.props)
    if (item.tombstone) tombstoned += 1
    else {
      saved += 1
      live.add(item.name)
    }
  }
  if (pending.length) {
    if (typeof client.saveBatch === 'function') {
      try {
        await client.saveBatch(pending)
        for (const item of pending) {
          if (item.tombstone) tombstoned += 1
          else {
            saved += 1
            live.add(item.name)
          }
        }
      } catch {
        // Batch refused as a whole: retry one by one.
        for (const item of pending) {
          try {
            await saveOne(item)
          } catch {
            failed += 1
          }
        }
      }
    } else {
      for (const item of pending) {
        try {
          await saveOne(item)
        } catch {
          failed += 1
        }
      }
    }
  }

  // Integrity check: every desired edge endpoint must exist as a live
  // record on the server. An edge whose endpoint failed to save would
  // dangle; count those, never hide.
  let orphans = 0
  for (const { from, to } of edges) {
    if (!live.has(from) || !live.has(to)) orphans += 1
  }

  const labels = await writeLabelFiles(rootAbs, labelDir || DEFAULT_LABEL_DIR, symbolsByFile, callResolution)

  const files = nodes.filter((node) => node.type === 'file').length
  const symbols = nodes.filter((node) => node.type === 'symbol').length
  return {
    linked,
    unlinked,
    saved,
    tombstoned,
    failed,
    orphans,
    files,
    symbols,
    edges: desired.size / 2,
    bytes: fileBytes,
    labels: { written: labels.written.length, deleted: labels.deleted.length }
  }
}

/**
 * Lineage over the sources graph, entirely server-side: files walk
 * imports/imported_by, symbols (ids containing '#') walk calls/called_by.
 * causalChain is direct-only, so hops beyond one are walked level by
 * level. Returns [id, hop] entries per direction; callers shape the
 * response. A thrown causalChain call is a connection-level failure, not
 * an empty result: the first error is returned as serverError so callers
 * can report "server unavailable" instead of letting a dead server read
 * as "no callers".
 */
export async function traceSources(client, target, direction = 'both', maxHops = 2) {
  const symbol = target.includes('#')
  const outRelation = symbol ? 'calls' : 'imports'
  const inRelation = symbol ? 'called_by' : 'imported_by'
  let serverError = null
  const walk = async (start, relation) => {
    const seen = new Map()
    let frontier = [start]
    for (let hop = 1; hop <= maxHops; hop++) {
      const next = []
      for (const node of frontier) {
        let rows
        try {
          rows = await client.causalChain([node], relation, 1000)
        } catch (err) {
          serverError = serverError || err?.message || String(err)
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
  const out = direction === 'in' ? [] : await walk(target, outRelation)
  const inc = direction === 'out' ? [] : await walk(target, inRelation)
  return { out, in: inc, serverError }
}

/**
 * Sync-state of the sources model: ~/.knlview/sync-state/<model>.json.
 * Written after every sync so a later trace can (a) date the graph (asOf)
 * and (b) detect staleness against a fresh disk count. A missing or
 * broken file means "never synced": trace reports asOf null rather than
 * inventing a date.
 */
export async function readSourcesSyncState(model, home = null, options = {}) {
  try {
    const parsed = JSON.parse(await fs.readFile(syncStatePath(model, home, options), 'utf8'))
    if (parsed?.model !== model || !Number.isInteger(parsed.files)) return null
    return parsed
  } catch {
    return null
  }
}

export async function writeSourcesSyncState(model, { files, symbols, edges, bytes }, home = null, options = {}) {
  try {
    const file = syncStatePath(model, home, options)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(
      file,
      JSON.stringify({ model, syncedAt: new Date().toISOString(), files, symbols, edges, bytes }),
      'utf8'
    )
  } catch {
    // State write failed: the sync itself still counts, the next trace
    // just reports asOf null and no staleness signal.
  }
}

/**
 * Drift sensor: a coarse aggregate, not a per-file diff and not proof of
 * freshness. Compare the file count and total size on disk now against
 * what sync stored; a drift of at most 1 unit is noise (an in-progress
 * edit, or one KB of rounding - the scanner stores sizes as whole KB).
 * Content changes that keep both totals are invisible here. The name says
 * suspect on purpose: it flags "worth re-syncing", never certifies fresh,
 * and it never affects exit codes; only the server-unreachable check may
 * fail a run (--strict).
 */
export function staleWarning(state, diskFiles, diskBytes = null) {
  if (!state || !Number.isInteger(state.files) || !Number.isInteger(diskFiles)) return null
  const parts = []
  const fileDiff = Math.abs(diskFiles - state.files)
  if (fileDiff > 1) parts.push(`${fileDiff} files differ`)
  if (Number.isInteger(diskBytes) && Number.isInteger(state.bytes)) {
    const byteDiff = Math.abs(diskBytes - state.bytes)
    if (byteDiff > 1) parts.push(`${byteDiff} KB differ`)
  }
  if (!parts.length) return null
  return `graph drift-suspect: ${parts.join(', ')} since last sync`
}

/**
 * HTTP URL of the administration endpoint for a wire:// URL. AnchorDB
 * listens wire on one port and REST on the port below it by default
 * (7448/7447); both are plain host:port.
 */
export function collectorHttpUrl(wireUrl) {
  const match = /^wire:\/\/([^?]+)/i.exec(String(wireUrl))
  if (!match) return null
  const hostPort = match[1]
  const at = hostPort.lastIndexOf(':')
  if (at <= 0) return null
  const host = hostPort.slice(0, at)
  const port = Number.parseInt(hostPort.slice(at + 1), 10)
  if (!Number.isInteger(port) || port <= 1) return null
  return `http://${host}:${port - 1}/v1/collector/run`
}

/**
 * Ask the server's collector to purge archived (opcode 2) records of one
 * model. Wire cannot start collector jobs; this is the documented HTTP
 * route, scoped to the model so no other model's tombstones are touched.
 * @returns {Promise<number>} records purged
 */
export async function purgeArchivedRecords(wireUrl, token, model) {
  const url = collectorHttpUrl(wireUrl)
  if (!url) throw new Error(`cannot derive the collector endpoint from "${wireUrl}"`)
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model })
  })
  if (!res.ok) throw new Error(`collector run failed (HTTP ${res.status})`)
  const body = await res.json()
  if (!body.success) throw new Error(`collector run failed: ${body.message || 'unknown error'}`)
  return body.purged_records ?? 0
}
