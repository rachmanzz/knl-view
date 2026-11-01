import { promises as fs } from 'node:fs'
import path from 'node:path'
import { knlGlobalDir } from '../config.js'

export const SUPPORTED_ECOSYSTEMS = new Set(['npm', 'go', 'cargo', 'pypi'])

/**
 * Validate that a module name does not contain traversal tokens, null bytes, or invalid paths.
 */
export function isValidModuleName(name) {
  if (!name || typeof name !== 'string') return false
  if (name.includes('\0')) return false
  const segments = name.replace(/\\/g, '/').split('/')
  for (const seg of segments) {
    if (seg === '.' || seg === '..' || !seg) return false
  }
  return true
}

/**
 * Returns the path to the global modules catalog directory (~/.knlview/modules).
 */
export function modulesCatalogDir(home = null, options = {}) {
  const base = knlGlobalDir(home, options)
  return path.join(base, 'modules')
}

/**
 * Default global AnchorDB model name for an ecosystem.
 */
export function defaultEcosystemModel(ecosystem) {
  const eco = String(ecosystem || '').toLowerCase()
  if (!SUPPORTED_ECOSYSTEMS.has(eco)) {
    throw new Error(`Unsupported ecosystem "${ecosystem}". Supported: ${[...SUPPORTED_ECOSYSTEMS].join(', ')}`)
  }
  return `modules-${eco}`
}

export function formatModuleKey(pkgName, version) {
  return `${pkgName}@${version}`
}

export function formatExternalPackageNodeId(ecosystem, pkgName, version) {
  return `ext:${ecosystem}/${pkgName}@${version}`
}

export function formatExternalSymbolNodeId(ecosystem, pkgName, version, symbol) {
  return `ext:${ecosystem}/${pkgName}@${version}#${symbol}`
}

/**
 * Read the catalog for a specific ecosystem ('npm', 'go', 'cargo', 'pypi').
 */
export async function readModulesCatalog(ecosystem, options = {}) {
  const eco = String(ecosystem || '').toLowerCase()
  if (!SUPPORTED_ECOSYSTEMS.has(eco)) return {}
  const dir = modulesCatalogDir(options.home, options)
  const file = path.join(dir, `${eco}.json`)
  try {
    const raw = await fs.readFile(file, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Check if a module version is already indexed in the catalog.
 */
export async function isModuleSynced(ecosystem, pkgName, version, options = {}) {
  const catalog = await readModulesCatalog(ecosystem, options)
  const key = formatModuleKey(pkgName, version)
  return Boolean(catalog[key]?.syncedAt)
}

/**
 * Record discovered modules and symbols to ~/.knlview/modules/<ecosystem>.json.
 * Stores lightweight metadata and symbolCount to avoid bloat in the local JSON catalog.
 */
export async function updateModulesCatalog(ecosystem, entries, options = {}) {
  const eco = String(ecosystem || '').toLowerCase()
  if (!SUPPORTED_ECOSYSTEMS.has(eco)) return
  if (!entries || !Object.keys(entries).length) return
  const dir = modulesCatalogDir(options.home, options)
  const file = path.join(dir, `${eco}.json`)
  try {
    await fs.mkdir(dir, { recursive: true })
    const existing = await readModulesCatalog(eco, options)
    for (const [key, item] of Object.entries(entries)) {
      const prev = existing[key] || {}
      const symbolCount = item.symbolCount !== undefined
        ? item.symbolCount
        : Array.isArray(item.symbols)
          ? item.symbols.length
          : (prev.symbolCount || 0)

      existing[key] = {
        name: item.name,
        version: item.version,
        ecosystem: eco,
        model: item.model || prev.model || defaultEcosystemModel(eco),
        nodeId: item.nodeId || prev.nodeId || formatExternalPackageNodeId(eco, item.name, item.version),
        symbolCount,
        syncedAt: item.syncedAt || prev.syncedAt || Date.now()
      }
    }
    await fs.writeFile(file, JSON.stringify(existing, null, 2) + '\n', 'utf8')
  } catch {
    // Fail gracefully: catalog is an informational index, never fatal.
  }
}

/**
 * Detect project dependency versions from on-disk manifests:
 * package.json, go.mod, Cargo.toml, requirements.txt.
 */
export async function detectProjectManifests(rootAbs) {
  const manifests = {
    npm: {},
    go: {},
    cargo: {},
    pypi: {}
  }

  // 1. npm (package.json)
  try {
    const pkgRaw = await fs.readFile(path.join(rootAbs, 'package.json'), 'utf8')
    const pkg = JSON.parse(pkgRaw)
    const all = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }
    for (const [name, ver] of Object.entries(all)) {
      if (typeof ver === 'string') {
        manifests.npm[name] = ver.replace(/^[\^~>=<]/, '').trim() || 'latest'
      }
    }
  } catch {}

  // 2. Go (go.mod)
  try {
    const text = await fs.readFile(path.join(rootAbs, 'go.mod'), 'utf8')
    const singleMatch = text.matchAll(/^require\s+([^\s()]+)\s+([^\s()]+)/gm)
    for (const m of singleMatch) manifests.go[m[1]] = m[2]
    const blockMatch = text.match(/require\s*\(([\s\S]*?)\)/m)
    if (blockMatch) {
      for (const line of blockMatch[1].split('\n')) {
        const parts = line.trim().split(/\s+/)
        if (parts.length >= 2 && !parts[0].startsWith('//')) {
          manifests.go[parts[0]] = parts[1]
        }
      }
    }
  } catch {}

  // 3. Rust (Cargo.toml)
  try {
    const text = await fs.readFile(path.join(rootAbs, 'Cargo.toml'), 'utf8')
    let inDeps = false
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (
        trimmed.startsWith('[dependencies]') ||
        trimmed.startsWith('[dev-dependencies]') ||
        trimmed.startsWith('[build-dependencies]')
      ) {
        inDeps = true
        continue
      }
      if (trimmed.startsWith('[')) {
        inDeps = false
        continue
      }
      if (inDeps && trimmed && !trimmed.startsWith('#')) {
        const eqIdx = trimmed.indexOf('=')
        if (eqIdx > 0) {
          const name = trimmed.slice(0, eqIdx).trim()
          const val = trimmed.slice(eqIdx + 1).trim()
          let ver = 'unknown'
          const strMatch = val.match(/^"([^"]+)"/)
          if (strMatch) ver = strMatch[1]
          const objMatch = val.match(/version\s*=\s*"([^"]+)"/)
          if (objMatch) ver = objMatch[1]
          manifests.cargo[name] = ver
        }
      }
    }
  } catch {}

  // 4. Python (requirements.txt)
  try {
    const reqText = await fs.readFile(path.join(rootAbs, 'requirements.txt'), 'utf8')
    for (const line of reqText.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const m = trimmed.match(/^([a-zA-Z0-9_.-]+)(?:[=<>~!\s]*([a-zA-Z0-9_.-]+))?/)
      if (m) manifests.pypi[m[1].toLowerCase()] = m[2] || 'unknown'
    }
  } catch {}

  return manifests
}

/**
 * Resolve the directory of an installed external module on disk.
 * Supports npm (node_modules), Go (GOPATH/pkg/mod or vendor), Cargo (cargo cache or vendor),
 * and Python (venv site-packages).
 */
export async function resolveModuleLocation(ecosystem, moduleName, options = {}) {
  const eco = String(ecosystem || '').toLowerCase()
  if (!SUPPORTED_ECOSYSTEMS.has(eco) || !isValidModuleName(moduleName)) return null
  const root = path.resolve(options.projectRoot || process.cwd())
  const manifests = options.manifests || await detectProjectManifests(root)

  if (eco === 'npm') {
    // 1. Check node_modules in projectRoot and walk up if necessary
    let curr = root
    let foundDir = null
    while (true) {
      const baseModules = path.join(curr, 'node_modules')
      const candidate = path.resolve(baseModules, moduleName)
      if (candidate.startsWith(baseModules + path.sep)) {
        try {
          const stat = await fs.stat(candidate)
          if (stat.isDirectory()) {
            foundDir = candidate
            break
          }
        } catch {}
      }
      const parent = path.dirname(curr)
      if (parent === curr) break
      curr = parent
    }

    let version = manifests.npm[moduleName] || 'unknown'
    if (foundDir) {
      try {
        const pkgText = await fs.readFile(path.join(foundDir, 'package.json'), 'utf8')
        const pkg = JSON.parse(pkgText)
        if (pkg.version) version = pkg.version
      } catch {}
      return { location: foundDir, version, name: moduleName, ecosystem: eco }
    }
  } else if (eco === 'go') {
    // 1. Check local vendor
    const vendorBase = path.join(root, 'vendor')
    const vendorDir = path.resolve(vendorBase, moduleName)
    if (vendorDir.startsWith(vendorBase + path.sep)) {
      try {
        const stat = await fs.stat(vendorDir)
        if (stat.isDirectory()) {
          return { location: vendorDir, version: manifests.go[moduleName] || 'vendor', name: moduleName, ecosystem: eco }
        }
      } catch {}
    }

    // 2. Check GOPATH
    const gopath = process.env.GOPATH || path.join(options.home || process.env.HOME || '', 'go')
    const version = manifests.go[moduleName]
    if (version) {
      const modBase = path.join(gopath, 'pkg', 'mod')
      const modDir = path.resolve(modBase, `${moduleName}@${version}`)
      if (modDir.startsWith(modBase + path.sep)) {
        try {
          const stat = await fs.stat(modDir)
          if (stat.isDirectory()) {
            return { location: modDir, version, name: moduleName, ecosystem: eco }
          }
        } catch {}
      }
    }
  } else if (eco === 'cargo') {
    // 1. Check local vendor
    const vendorBase = path.join(root, 'vendor')
    const vendorDir = path.resolve(vendorBase, moduleName)
    if (vendorDir.startsWith(vendorBase + path.sep)) {
      try {
        const stat = await fs.stat(vendorDir)
        if (stat.isDirectory()) {
          return { location: vendorDir, version: manifests.cargo[moduleName] || 'vendor', name: moduleName, ecosystem: eco }
        }
      } catch {}
    }

    // 2. Check cargo registry cache (~/.cargo/registry/src)
    const cargoHome = process.env.CARGO_HOME || path.join(options.home || process.env.HOME || '', '.cargo')
    const regSrc = path.join(cargoHome, 'registry', 'src')
    const version = manifests.cargo[moduleName]
    try {
      const registries = await fs.readdir(regSrc)
      for (const reg of registries) {
        const targetPrefix = version ? `${moduleName}-${version}` : `${moduleName}-`
        const regDir = path.join(regSrc, reg)
        const entries = await fs.readdir(regDir)
        const match = entries.find((e) => version ? e === targetPrefix : e.startsWith(targetPrefix))
        if (match) {
          const location = path.resolve(regDir, match)
          if (location.startsWith(regDir + path.sep)) {
            const matchedVersion = version || match.slice(moduleName.length + 1)
            return { location, version: matchedVersion, name: moduleName, ecosystem: eco }
          }
        }
      }
    } catch {}
  } else if (eco === 'pypi') {
    const version = manifests.pypi[moduleName.toLowerCase()] || 'unknown'
    // 1. Check .venv and venv site-packages
    const venvDirs = ['.venv', 'venv']
    for (const venv of venvDirs) {
      const libDir = path.join(root, venv, 'lib')
      try {
        const pyDirs = await fs.readdir(libDir)
        for (const py of pyDirs) {
          const spBase = path.join(libDir, py, 'site-packages')
          const sp = path.resolve(spBase, moduleName)
          if (sp.startsWith(spBase + path.sep)) {
            try {
              const stat = await fs.stat(sp)
              if (stat.isDirectory()) {
                return { location: sp, version, name: moduleName, ecosystem: eco }
              }
            } catch {}
          }
        }
      } catch {}
    }
  }

  return null
}
