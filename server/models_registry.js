import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { knlGlobalDir } from './config.js'

// Global registry of AnchorDB model names:
// - %APPDATA%\knlview\models.json on Windows
// - ~/.knlview/models.json on Linux and macOS
//
// Model names may be random; what makes a random name meaningful is this
// registry: the mapping of name → project, role, and project location.
// knl-view code never guesses model names: it only knows roles (knowledges,
// consensus, etc.) and reads each role from the project map.

const REGISTRY_FILE = 'models.json'

export function modelRegistryPath(home = null, options = {}) {
  return path.join(knlGlobalDir(home, options), REGISTRY_FILE)
}

/**
 * Random name for a model: 8 Crockford base32 characters (no I, L, O, U
 * so humans never misread/mistype them).
 */
export function generateModelName() {
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz'
  const bytes = crypto.randomBytes(8)
  let name = ''
  for (const byte of bytes) name += alphabet[byte % alphabet.length]
  return name
}

/**
 * Read the registry. Missing/broken file = empty registry, not an error.
 * @returns {Promise<{models: object, error: string|null}>}
 */
export async function readModelRegistry(home = null, options = {}) {
  const primary = modelRegistryPath(home, options)
  let content = null
  try {
    content = await fs.readFile(primary, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') {
      const platform = options.platform || process.platform
      const env = options.env || process.env
      if (platform === 'win32' && !home) {
        const winHome = env.USERPROFILE || env.HOME || (typeof os.homedir === 'function' ? os.homedir() : null)
        if (winHome) {
          try {
            content = await fs.readFile(path.join(winHome, '.knlview', REGISTRY_FILE), 'utf8')
          } catch {}
        }
      }
      if (!content) return { models: {}, error: null }
    } else {
      return { models: {}, error: err.message }
    }
  }

  try {
    const parsed = JSON.parse(content)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { models: {}, error: 'registry contents are not an object' }
    }
    const models = {}
    for (const [name, entry] of Object.entries(parsed)) {
      if (entry && typeof entry === 'object' && typeof entry.role === 'string') {
        models[name] = entry
      }
    }
    return { models, error: null }
  } catch (err) {
    return { models: {}, error: err.message }
  }
}

/**
 * Register (or update) one model in the registry. Returns the previous owner
 * when the name is already claimed by another project; the caller decides
 * whether to warn.
 * @returns {Promise<{previous: object|null, written: boolean, error: string|null}>}
 */
export async function registerModel(name, { role, project, cwd }, home = null, options = {}) {
  const { models, error } = await readModelRegistry(home, options)
  if (error) return { previous: null, written: false, error }

  const previous = models[name] || null
  const sameOwner = previous && path.resolve(previous.cwd || '') === path.resolve(cwd)
  if (previous && !sameOwner) {
    return { previous, written: false, error: null }
  }

  models[name] = {
    role,
    project,
    cwd: path.resolve(cwd),
    registeredAt: new Date().toISOString()
  }

  try {
    const file = modelRegistryPath(home, options)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify(models, null, 2) + '\n', 'utf8')
    return { previous: null, written: true, error: null }
  } catch (err) {
    return { previous: null, written: false, error: err.message }
  }
}
