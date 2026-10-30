import { promises as fs } from 'node:fs'
import fsSync from 'node:fs'
import path from 'node:path'

// Dua lapis config knl-view:
// - Global: ~/.knlview/knl-config.json berisi blok "anchordb" (URL, token,
//   sync). Koneksi itu sifatnya milik mesin/user, bukan repo, jadi semua
//   project di mesin ini berbagi server AnchorDB yang sama.
// - Per project: knl-config.json di project root (gitignored) berisi
//   path/port/host dan "model". Model otomatis di-namespace menjadi
//   "{projectname}-{model}" supaya tidak tabrakan antar project.
//
// File hilang atau rusak tidak boleh menjatuhkan viewer. Nilai final
// dipilih resolveSettings dengan urutan: flag CLI > config > bawaan.

const PROJECT_CONFIG_FILE = 'knl-config.json'
const GLOBAL_CONFIG_DIR = '.knlview'
const GLOBAL_CONFIG_FILE = 'knl-config.json'
const MAX_CONFIG_BYTES = 64 * 1024

export const DEFAULT_SETTINGS = { path: '.knowledges', port: '8085', host: '127.0.0.1' }
export const DEFAULT_MODEL = 'knowledges'

// Relasi kausal yang diikuti /api/anchordb/trace bila config tidak menetapkan.
export const DEFAULT_RELATIONS = ['supersedes', 'affects_knowledge', 'depends_on']

export function globalConfigPath(home = process.env.HOME) {
  return path.join(home || '', GLOBAL_CONFIG_DIR, GLOBAL_CONFIG_FILE)
}

/**
 * Baca config global ~/.knlview/knl-config.json (blok anchordb).
 * @returns {Promise<{config: object|null, error: string|null}>}
 */
export async function readGlobalConfig(home = process.env.HOME) {
  return readConfigFile(globalConfigPath(home), normalizeGlobalConfig)
}

/**
 * Baca config per project: knl-config.json di project root.
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
    return { config: null, error: `ukuran melebihi ${MAX_CONFIG_BYTES} byte` }
  }
  let parsed
  try {
    parsed = JSON.parse(await fs.readFile(abs, 'utf8'))
  } catch (err) {
    return { config: null, error: `JSON tidak valid: ${err.message}` }
  }
  return { config: normalize(parsed), error: null }
}

/**
 * Saring config project ke field yang dikenal. Nilai tidak valid dilepas
 * (bukan fatal) supaya resolveSettings jatuh ke flag CLI atau bawaan.
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
  const model = cleanString(raw.model)
  if (model) config.model = model
  return config
}

/**
 * Saring config global: hanya blok anchordb yang berarti di sini.
 */
export function normalizeGlobalConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const anchordb = normalizeAnchordb(raw.anchordb)
  return anchordb ? { anchordb } : null
}

/**
 * Samakan bentuk blok anchordb: string "wire://host:port?token=..." atau
 * objek lengkap. Mengembalikan null bila tidak layak dipakai.
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
  // Hadir berarti aktif (termasuk sinkron graf saat start); sync: false untuk opt-out.
  anchordb.sync = raw.sync !== false
  if (Array.isArray(raw.relations)) {
    const relations = raw.relations.map((r) => cleanString(r)).filter(Boolean)
    if (relations.length) anchordb.relations = relations
  }
  return anchordb
}

/**
 * Nama project untuk namespace model AnchorDB: field "name" package.json
 * bila ada, kalau tidak nama folder project. Dibersihkan jadi slug aman.
 */
export function projectSlug(cwd = process.cwd()) {
  let name = null
  try {
    const parsed = JSON.parse(fsSync.readFileSync(path.join(cwd, 'package.json'), 'utf8'))
    if (typeof parsed?.name === 'string') name = parsed.name
  } catch {
    // Tanpa package.json, nama folder project yang dipakai.
  }
  if (!name || !name.trim()) name = path.basename(path.resolve(cwd))
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug || 'project'
}

/**
 * Namespace model: "{projectname}-{model}". Nama yang sudah berawalan slug
 * project dilewati apa adanya supaya tidak dobel.
 */
export function qualifyModel(model, slug) {
  const base = cleanString(model) || DEFAULT_MODEL
  if (base.startsWith(`${slug}-`)) return base
  return `${slug}-${base}`
}

/**
 * Gabungkan flag CLI, config project, config global, dan bawaan.
 *
 * - path/port/host: CLI > config project > bawaan
 * - anchordb: flag --anchordb > config global; mati total bila tidak ada
 *   keduanya (project tanpa config global tidak pernah menyentuh AnchorDB)
 * - model: config project > model di URL > bawaan, lalu di-namespace
 *   "{projectname}-{model}"
 */
export function resolveSettings({ cli = {}, project = null, global: globalConfig = null, projectName = 'project' } = {}) {
  const p = project || {}
  const g = globalConfig || {}
  const anchordb = cli.anchordb !== undefined
    ? normalizeAnchordb(cli.anchordb)
    : normalizeAnchordb(g.anchordb)
  if (anchordb) anchordb.model = qualifyModel(anchordb.model || p.model, projectName)

  return {
    path: pickString(cli.path, p.path) ?? DEFAULT_SETTINGS.path,
    port: pickString(cli.port, p.port) ?? DEFAULT_SETTINGS.port,
    host: pickString(cli.host, p.host) ?? DEFAULT_SETTINGS.host,
    anchordb
  }
}

/**
 * Susun opsi klien AnchorWire dari blok anchordb yang sudah di-resolve.
 * Field config menang atas nilai di query URL.
 */
export function anchordbClientOptions(anchordb) {
  if (!anchordb?.url) return null
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
  options.model = anchordb.model || parsed.searchParams.get('model') || DEFAULT_MODEL
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
