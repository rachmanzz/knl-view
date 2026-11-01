import { promises as fs } from 'node:fs'
import path from 'node:path'
import { GraphNode } from './model.js'
import { SYNTAX_LANGUAGES, extractCode } from './syntax.js'
import { desiredSourceEdgeKeys } from './sources.js'
import {
  resolveModuleLocation,
  formatExternalPackageNodeId,
  formatExternalSymbolNodeId,
  defaultEcosystemModel,
  updateModulesCatalog,
  SUPPORTED_ECOSYSTEMS,
  isValidModuleName
} from './modules_catalog.js'

const MODULE_DEFAULT_IGNORES = [
  'node_modules',
  '.git',
  '.github',
  'test',
  'tests',
  '__tests__',
  'docs',
  'doc',
  'example',
  'examples',
  'fixtures',
  'coverage'
]

/**
 * Scan source files of an external module directory with depth and file count guard-rails.
 */
export async function scanModuleFiles(moduleDir, ecosystem, { maxDepth = 20, maxFiles = 5000 } = {}) {
  const files = {}
  let totalFiles = 0

  const walk = async (dirAbs, rel, depth = 0) => {
    if (depth > maxDepth || totalFiles >= maxFiles) return
    let entries
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (totalFiles >= maxFiles) break
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (MODULE_DEFAULT_IGNORES.includes(entry.name.toLowerCase())) continue
        await walk(path.join(dirAbs, entry.name), childRel, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (!SYNTAX_LANGUAGES[ext]) continue
      if (ecosystem === 'go' && entry.name.endsWith('_test.go')) continue
      if (ecosystem === 'pypi' && entry.name.startsWith('test_')) continue
      files[childRel] = path.join(dirAbs, entry.name)
      totalFiles += 1
    }
  }
  await walk(moduleDir, '', 0)
  return files
}

/**
 * Parse an eco::name string into components: { ecosystem, moduleName }
 * Strictly validates ecosystem against SUPPORTED_ECOSYSTEMS and moduleName against path traversal.
 */
export function parseModuleSpecifier(target) {
  if (!target || typeof target !== 'string') return null
  const idx = target.indexOf('::')
  if (idx <= 0) return null
  const ecosystem = target.slice(0, idx).toLowerCase()
  const moduleName = target.slice(idx + 2)
  if (!moduleName || !SUPPORTED_ECOSYSTEMS.has(ecosystem) || !isValidModuleName(moduleName)) {
    return null
  }
  return { ecosystem, moduleName }
}

/**
 * Build graph for an external module from disk using Tree-Sitter.
 */
export async function buildModuleGraph(ecosystem, moduleName, options = {}) {
  const resolved = options.location
    ? { location: options.location, version: options.version || '0.0.0', name: moduleName, ecosystem }
    : await resolveModuleLocation(ecosystem, moduleName, options)

  if (!resolved || !resolved.location) {
    throw new Error(`Could not resolve module directory for ${ecosystem}::${moduleName} on disk. Ensure it is installed.`)
  }

  const { location, version } = resolved
  const model = defaultEcosystemModel(ecosystem)
  const moduleNodeId = formatExternalPackageNodeId(ecosystem, moduleName, version)

  const files = await scanModuleFiles(location, ecosystem)
  const symbolNodes = []
  const symbolNamesSet = new Set()
  const edges = []
  const symbolIndex = new Map() // name -> [id, ...]
  const fileSymbolsMap = new Map()

  for (const [rel, abs] of Object.entries(files)) {
    const ext = path.extname(rel).toLowerCase()
    let content
    try {
      content = await fs.readFile(abs, 'utf8')
    } catch {
      continue
    }

    let extracted
    try {
      extracted = await extractCode(ext, content)
    } catch {
      continue
    }

    const nameCounts = new Map()
    for (const sym of extracted.symbols || []) {
      nameCounts.set(sym.name, (nameCounts.get(sym.name) || 0) + 1)
    }

    const currentFileSymbols = []
    for (const sym of extracted.symbols || []) {
      const symId = nameCounts.get(sym.name) > 1
        ? formatExternalSymbolNodeId(ecosystem, moduleName, version, `${sym.name}@${sym.line}`)
        : formatExternalSymbolNodeId(ecosystem, moduleName, version, sym.name)

      symbolNamesSet.add(sym.name)
      currentFileSymbols.push({ ...sym, id: symId })
      symbolIndex.set(sym.name, [...(symbolIndex.get(sym.name) || []), symId])

      edges.push({ from: moduleNodeId, to: symId, type: 'defines' })
      symbolNodes.push(new GraphNode({
        id: symId,
        title: sym.name,
        type: 'symbol',
        metadata: { kind: sym.kind, line: sym.line }
      }))
    }

    fileSymbolsMap.set(rel, { symbols: currentFileSymbols, calls: extracted.calls || [] })
  }

  // Internal calls between symbols inside the module
  for (const [, { symbols, calls }] of fileSymbolsMap.entries()) {
    for (const call of calls) {
      let owner = null
      for (const sym of symbols) {
        const start = sym.line - 1
        const end = start + sym.lines
        if (call.row >= start && call.row < end) {
          if (!owner || sym.lines < owner.lines) owner = sym
        }
      }
      if (!owner) continue
      const targetMatches = symbolIndex.get(call.name) || []
      if (targetMatches.length === 1 && targetMatches[0] !== owner.id) {
        edges.push({ from: owner.id, to: targetMatches[0], type: 'calls' })
      }
    }
  }

  const moduleNode = new GraphNode({
    id: moduleNodeId,
    title: `${moduleName}@${version}`,
    type: 'module',
    metadata: { ecosystem, name: moduleName, version }
  })

  return {
    moduleNode,
    symbolNodes,
    edges,
    symbols: [...symbolNamesSet].sort(),
    name: moduleName,
    version,
    ecosystem,
    model,
    location
  }
}

/**
 * Sync the constructed module graph to AnchorDB in model modules-<ecosystem>.
 */
export async function syncModuleToAnchorDB(client, moduleGraph, options = {}) {
  if (!client || !moduleGraph) return { linked: 0, saved: 0, failed: 0 }

  const desired = desiredSourceEdgeKeys(moduleGraph.edges)
  let linked = 0
  let failed = 0

  for (const key of desired) {
    const [from, type, to] = key.split('\0')
    try {
      await client.link(from, type, to, 1.0)
      linked += 1
    } catch {
      failed += 1
    }
  }

  const pending = [
    { name: moduleGraph.moduleNode.id, props: { ...moduleGraph.moduleNode.metadata, tombstone: 0 } },
    ...moduleGraph.symbolNodes.map((s) => ({ name: s.id, props: { ...s.metadata, tombstone: 0 } }))
  ]

  let saved = 0
  if (typeof client.saveBatch === 'function') {
    try {
      await client.saveBatch(pending)
      saved = pending.length
    } catch {
      for (const item of pending) {
        try {
          await client.saveWithID(item.name, item.props)
          saved += 1
        } catch {
          failed += 1
        }
      }
    }
  } else {
    for (const item of pending) {
      try {
        await client.saveWithID(item.name, item.props)
        saved += 1
      } catch {
        failed += 1
      }
    }
  }

  await updateModulesCatalog(moduleGraph.ecosystem, {
    [`${moduleGraph.name}@${moduleGraph.version}`]: {
      name: moduleGraph.name,
      version: moduleGraph.version,
      ecosystem: moduleGraph.ecosystem,
      model: moduleGraph.model,
      nodeId: moduleGraph.moduleNode.id,
      symbolCount: moduleGraph.symbols.length
    }
  }, options)

  return {
    linked,
    saved,
    failed,
    symbols: moduleGraph.symbols.length,
    edges: moduleGraph.edges.length,
    model: moduleGraph.model
  }
}

/**
 * Trace lineage for a module or symbol in its ecosystem model.
 */
export async function traceModuleSymbol(client, targetId, { direction = 'both', maxHops = 2 } = {}) {
  const forwardRelations = targetId.includes('#') ? ['calls'] : ['defines']
  const backwardRelations = targetId.includes('#') ? ['called_by', 'defined_in'] : []

  const rels = []
  if (direction === 'out' || direction === 'both') rels.push(...forwardRelations)
  if (direction === 'in' || direction === 'both') rels.push(...backwardRelations)

  const visited = new Map() // id -> hop
  visited.set(targetId, 0)
  let frontier = [targetId]

  for (let hop = 1; hop <= maxHops && frontier.length; hop++) {
    const nextFrontier = []
    for (const current of frontier) {
      for (const rel of rels) {
        let rows = []
        try {
          rows = await client.causalChain([current], rel, 100)
        } catch {
          continue
        }
        for (const r of rows || []) {
          if (!r?.word || visited.has(r.word)) continue
          visited.set(r.word, hop)
          nextFrontier.push(r.word)
        }
      }
    }
    frontier = nextFrontier
  }

  const results = []
  for (const [id, hop] of visited.entries()) {
    if (id !== targetId) results.push({ id, hop })
  }
  return results.sort((a, b) => a.hop - b.hop || a.id.localeCompare(b.id))
}
