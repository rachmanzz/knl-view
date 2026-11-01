import { promises as fs } from 'node:fs'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Two-layer knl-view config:
// - Global: %APPDATA%\knlview on Windows (fallback to ~/.knlview), or
//   ~/.knlview/knl-config.json on Linux/macOS. Holds the "anchordb" block
//   (URL, token, sync). That connection belongs to the machine/user, not
//   the repo, so all projects using AnchorDB share the same server.
// - Per project: knl-config.json at the project root (gitignored) holds
//   path/port/host and the "models" map (role -> AnchorDB model name; names
//   may be random, the map records what each name is for).
//
// A missing or broken file must never bring the viewer down. Final values
// are chosen by resolveSettings in the order: CLI flag > config > default.

const PROJECT_CONFIG_FILE = 'knl-config.json'
const GLOBAL_CONFIG_DIR = '.knlview'
const GLOBAL_CONFIG_FILE = 'knl-config.json'
const MAX_CONFIG_BYTES = 64 * 1024

export const DEFAULT_SETTINGS = { path: '.knowledges', port: '8085', host: '127.0.0.1' }
export const DEFAULT_MODEL = 'knowledges'

// Causal relations /api/anchordb/trace follows when the config sets none.
export const DEFAULT_RELATIONS = ['supersedes', 'affects_knowledge', 'depends_on']

/**
 * Resolve the global knl-view base directory based on OS:
 * - On Windows (win32): uses %APPDATA%\knlview (falling back to %USERPROFILE%\AppData\Roaming\knlview).
 * - On macOS/Linux: uses ~/.knlview (falling back to os.homedir()/.knlview).
 * - If an explicit `home` path is provided (e.g. in unit tests), it maps to path.join(home, '.knlview').
 */
export function knlGlobalDir(home = null, { env = process.env, platform = process.platform } = {}) {
  const p = platform === 'win32' ? path.win32 : path
  if (home && typeof home === 'string' && home.trim()) {
    return p.join(home.trim(), GLOBAL_CONFIG_DIR)
  }

  // OS detection: Windows (win32) uses %APPDATA%\knlview
  if (platform === 'win32') {
    if (env.APPDATA && env.APPDATA.trim()) {
      return p.join(env.APPDATA.trim(), 'knlview')
    }
    const winHome = env.USERPROFILE || (typeof os.homedir === 'function' ? os.homedir() : '') || '.'
    return p.join(winHome, 'AppData', 'Roaming', 'knlview')
  }

  // macOS and Linux use ~/.knlview
  const unixHome = env.HOME || (typeof os.homedir === 'function' ? os.homedir() : '') || '.'
  return p.join(unixHome, GLOBAL_CONFIG_DIR)
}

export function globalConfigPath(home = null, options = {}) {
  const platform = options.platform || process.platform
  const p = platform === 'win32' ? path.win32 : path
  return p.join(knlGlobalDir(home, options), GLOBAL_CONFIG_FILE)
}

/**
 * Location of the mirror of the last synced edges for one model:
 * ~/.knlview/sync-state/<model>.json (or %APPDATA%\knlview\sync-state\ on Windows).
 * Incremental sync compares the local graph against this mirror, not against
 * the server contents (the server offers no edge enumeration over the wire protocol).
 */
export function syncStatePath(model, home = null, options = {}) {
  const platform = options.platform || process.platform
  const p = platform === 'win32' ? path.win32 : path
  const safe = String(model || 'model').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'model'
  return p.join(knlGlobalDir(home, options), 'sync-state', `${safe}.json`)
}

/**
 * Read the global config knl-config.json (anchordb block).
 * On Windows, falls back to legacy ~/.knlview/knl-config.json if %APPDATA% has no config yet.
 * @returns {Promise<{config: object|null, error: string|null}>}
 */
export async function readGlobalConfig(home = null, options = {}) {
  const primary = globalConfigPath(home, options)
  const res = await readConfigFile(primary, normalizeGlobalConfig)
  if (res.config) return res

  // On Windows, if config is missing in %APPDATA%, check legacy ~/.knlview fallback
  const platform = options.platform || process.platform
  const p = platform === 'win32' ? path.win32 : path
  const env = options.env || process.env
  if (platform === 'win32' && !home) {
    const winHome = env.USERPROFILE || env.HOME || (typeof os.homedir === 'function' ? os.homedir() : null)
    if (winHome) {
      const fallbackFile = p.join(winHome, GLOBAL_CONFIG_DIR, GLOBAL_CONFIG_FILE)
      if (fallbackFile !== primary) {
        const fallbackRes = await readConfigFile(fallbackFile, normalizeGlobalConfig)
        if (fallbackRes.config) return fallbackRes
      }
    }
  }

  return res
}

/**
 * Read the per-project config: knl-config.json at the project root.
 * @returns {Promise<{config: object|null, error: string|null}>}
 */
export async function readProjectConfig(cwd = process.cwd()) {
  return readConfigFile(path.join(cwd, PROJECT_CONFIG_FILE), normalizeProjectConfig)
}

async function readConfigFile(abs, normalize) {
  let stat
  try {
    stat = await fs.stat(abs)
  } catch {
    return { config: null, error: null }
  }
  if (!stat.isFile()) return { config: null, error: null }
  if (stat.size > MAX_CONFIG_BYTES) {
    return { config: null, error: `size exceeds ${MAX_CONFIG_BYTES} bytes` }
  }
  let parsed
  try {
    parsed = JSON.parse(await fs.readFile(abs, 'utf8'))
  } catch (err) {
    return { config: null, error: `invalid JSON: ${err.message}` }
  }
  return { config: normalize(parsed), error: null }
}

/**
 * Filter the project config down to known fields. Invalid values are dropped
 * (not fatal) so resolveSettings falls back to the CLI flag or the default.
 *
 * `models` is the role → AnchorDB model name map (names may be random; this
 * map is what records what each name is for). The legacy `model: "x"` shape
 * is still accepted as shorthand for models.knowledges.
 */
export function normalizeProjectConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const config = {}
  const configPath = cleanString(raw.path)
  if (configPath) config.path = configPath
  const port = toPort(raw.port)
  if (port != null) config.port = String(port)
  const host = cleanString(raw.host)
  if (host) config.host = host
  const models = normalizeModels(raw.models)
  if (models) config.models = models
  const model = cleanString(raw.model)
  if (model) config.model = model
  const labelDir = cleanString(raw.labelDir)
  if (labelDir) config.labelDir = labelDir
  const include = cleanStringList(raw.include)
  if (include) config.include = include
  const exclude = cleanStringList(raw.exclude)
  if (exclude) config.exclude = exclude
  return config
}

const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const MODEL_ROLE_RE = /^[a-z][a-z0-9_-]*$/

/**
 * Filter the models map: keys = roles (lowercase slugs), values = model names.
 * Invalid entries are dropped, not fatal.
 */
export function normalizeModels(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const models = {}
  for (const [role, name] of Object.entries(raw)) {
    const roleSlug = String(role).trim().toLowerCase()
    const nameStr = cleanString(name)
    if (!MODEL_ROLE_RE.test(roleSlug) || !MODEL_NAME_RE.test(nameStr)) continue
    models[roleSlug] = nameStr
  }
  return Object.keys(models).length ? models : null
}

/**
 * Model name for one role, verbatim from the map. No automatic namespacing:
 * model names deliberately stay stable even when the project/folder is
 * renamed. Returns null when the role is unmapped (the caller supplies the
 * "run knl-view model new <role>" hint).
 */
export function resolveModel(models, role = DEFAULT_MODEL) {
  const name = models?.[role]
  return typeof name === 'string' && name ? name : null
}

/**
 * Filter the global config: only the anchordb block matters here.
 */
export function normalizeGlobalConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const anchordb = normalizeAnchordb(raw.anchordb)
  return anchordb ? { anchordb } : null
}

/**
 * Normalize the anchordb block shape: a "wire://host:port?token=..." string
 * or a full object. Returns null when unusable.
 */
export function normalizeAnchordb(raw) {
  if (typeof raw === 'string') raw = { url: raw }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const url = cleanString(raw.url)
  if (!url || !/^(wire|tcp):\/\//i.test(url)) return null
  const anchordb = { url }
  const token = cleanString(raw.token)
  if (token) anchordb.token = token
  const model = cleanString(raw.model)
  if (model) anchordb.model = model
  // Present means active (including graph sync on start); sync: false to opt out.
  anchordb.sync = raw.sync !== false
  if (Array.isArray(raw.relations)) {
    const relations = raw.relations.map((r) => cleanString(r)).filter(Boolean)
    if (relations.length) anchordb.relations = relations
  }
  const daemon = cleanString(raw.daemon || raw.deamon)
  if (daemon) {
    anchordb.daemon = daemon
    anchordb.deamon = daemon
  }
  const containerName = cleanString(raw.container_name)
  if (containerName) anchordb.container_name = containerName
  const containerId = cleanString(raw.container_id)
  if (containerId) anchordb.container_id = containerId
  const containerCreatedOn = cleanString(raw.container_created_on)
  if (containerCreatedOn) anchordb.container_created_on = containerCreatedOn
  return anchordb
}

/**
 * Project name for the model registry entry: the package.json "name" field
 * when present, otherwise the project folder name. Cleaned into a safe slug.
 */
export function projectSlug(cwd = process.cwd()) {
  let name = null
  try {
    const parsed = JSON.parse(fsSync.readFileSync(path.join(cwd, 'package.json'), 'utf8'))
    if (typeof parsed?.name === 'string') name = parsed.name
  } catch {
    // Without a package.json, the project folder name is used.
  }
  if (!name || !name.trim()) name = path.basename(path.resolve(cwd))
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug || 'project'
}

/**
 * Merge CLI flags, project config, global config, and defaults.
 *
 * - path/port/host: CLI > project config > default
 * - anchordb: --anchordb flag > global config; fully off when neither exists
 *   (a project without global config never touches AnchorDB)
 * - model: taken from the project config `models` map (knowledges role).
 *   The name in the URL (?model=) is only used when the map does not set it.
 */
export function resolveSettings({ cli = {}, project = null, global: globalConfig = null } = {}) {
  const p = project || {}
  const g = globalConfig || {}
  const anchordb = cli.anchordb !== undefined
    ? normalizeAnchordb(cli.anchordb)
    : normalizeAnchordb(g.anchordb)

  // Legacy "model": "x" shape still counts as models.knowledges.
  const models = { ...(p.models || {}) }
  if (!models[DEFAULT_MODEL] && typeof p.model === 'string' && p.model.trim()) {
    models[DEFAULT_MODEL] = p.model.trim()
  }
  const hasModels = Object.keys(models).length > 0

  if (anchordb) {
    anchordb.model = (hasModels && resolveModel(models)) || cleanString(anchordb.model) || null
  }

  const labelDir = pickString(cli.labelDir, p.labelDir)
  const include = Array.isArray(p.include) && p.include.length ? p.include : null
  const exclude = Array.isArray(p.exclude) && p.exclude.length ? p.exclude : null

  return {
    path: pickString(cli.path, p.path) ?? DEFAULT_SETTINGS.path,
    port: pickString(cli.port, p.port) ?? DEFAULT_SETTINGS.port,
    host: pickString(cli.host, p.host) ?? DEFAULT_SETTINGS.host,
    models: hasModels ? models : null,
    labelDir: labelDir ?? null,
    include,
    exclude,
    anchordb
  }
}

/**
 * Build AnchorWire client options from the already-resolved anchordb block.
 * Config fields win over values in the URL query.
 */
export function anchordbClientOptions(anchordb) {
  if (!anchordb?.url || typeof anchordb.url !== 'string') return null
  const normalized = anchordb.url.replace(/^(wire|tcp):\/\//i, 'http://')
  let parsed
  try {
    parsed = new URL(normalized.startsWith('http') ? normalized : `http://${normalized}`)
  } catch {
    return null
  }
  const options = {}
  if (parsed.hostname) options.host = parsed.hostname.replace(/^\[|\]$/g, '')
  if (parsed.port) {
    const port = Number.parseInt(parsed.port, 10)
    if (Number.isInteger(port) && port > 0 && port <= 65535) options.port = port
  }
  options.token = anchordb.token || parsed.searchParams.get('token') || ''
  // The model name comes from the project map (already resolved by
  // resolveSettings) or the URL query for a one-off session. Deliberately no
  // default: a model with no clear name must not silently create a generic
  // "knowledges" model.
  options.model = anchordb.model || parsed.searchParams.get('model') || ''
  return options
}

function pickString(cliValue, configValue) {
  if (typeof cliValue === 'string' && cliValue.trim()) return cliValue.trim()
  if (typeof configValue === 'string' && configValue.trim()) return configValue.trim()
  return null
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function toPort(value) {
  const n = Number(value)
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null
}

function cleanStringList(raw) {
  if (!raw) return null
  const arr = Array.isArray(raw) ? raw : [raw]
  const cleaned = arr
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
  return cleaned.length ? cleaned : null
}

/**
 * Compile a list of string patterns (globs, directory names, or exact paths)
 * into a reusable matcher object with `matches(relPath, baseName)` and
 * `isPrefixOfAny(relPath)`.
 */
export function createPathMatcher(patterns) {
  if (!patterns) return null
  const list = cleanStringList(patterns)
  if (!list) return null

  const matchers = list.map((pattern) => {
    const clean = pattern.replace(/^\/+|\/+$/g, '')
    const hasWildcard = clean.includes('*') || clean.includes('?')
    if (!hasWildcard) {
      return {
        pattern: clean,
        test: (rel, name) => rel === clean || rel.startsWith(clean + '/') || name === clean
      }
    }
    const escaped = clean
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '§§GLOBSTAR§§')
      .replace(/\*/g, '[^/]*')
      .replace(/§§GLOBSTAR§§/g, '.*')
      .replace(/\?/g, '[^/]')
    try {
      const re = new RegExp(`^(?:${escaped}|.*/${escaped})(?:/.*)?$`)
      return {
        pattern: clean,
        test: (rel, name) => re.test(rel) || (name && re.test(name))
      }
    } catch {
      return {
        pattern: clean,
        test: () => false
      }
    }
  })

  return {
    patterns: list,
    matches: (rel, name = '') => matchers.some((m) => m.test(rel, name)),
    isPrefixOfAny: (rel) => matchers.some((m) => m.pattern.startsWith(rel + '/') || m.test(rel, rel))
  }
}
