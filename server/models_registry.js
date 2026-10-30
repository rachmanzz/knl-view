import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// Registry global nama model AnchorDB: ~/.knlview/models.json.
//
// Nama model boleh acak; yang membuat nama acak itu bermakna adalah
// registry ini — pemetaan nama → project, peran, dan lokasi project.
// Kode knl-view tidak pernah menebak nama model: ia hanya tahu peran
// (knowledges, consensus, dst.) dan membaca perannya dari map project.

const REGISTRY_FILE = 'models.json'

export function modelRegistryPath(home = process.env.HOME) {
  return path.join(home || '', '.knlview', REGISTRY_FILE)
}

/**
 * Nama acak untuk model: 8 karakter Crockford base32 (tanpa I, L, O, U
 * supaya tidak rancu saat dibaca/diketik manusia).
 */
export function generateModelName() {
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz'
  const bytes = crypto.randomBytes(8)
  let name = ''
  for (const byte of bytes) name += alphabet[byte % alphabet.length]
  return name
}

/**
 * Baca registry. File hilang/rusak = registry kosong, bukan error.
 * @returns {Promise<{models: object, error: string|null}>}
 */
export async function readModelRegistry(home = process.env.HOME) {
  try {
    const parsed = JSON.parse(await fs.readFile(modelRegistryPath(home), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { models: {}, error: 'isi registry bukan objek' }
    }
    const models = {}
    for (const [name, entry] of Object.entries(parsed)) {
      if (entry && typeof entry === 'object' && typeof entry.role === 'string') {
        models[name] = entry
      }
    }
    return { models, error: null }
  } catch (err) {
    if (err?.code === 'ENOENT') return { models: {}, error: null }
    return { models: {}, error: err.message }
  }
}

/**
 * Daftarkan (atau perbarui) satu model di registry. Mengembalikan pemilik
 * sebelumnya bila nama sudah diklaim project lain — pemanggil yang
 * memutuskan mau memperingatkan atau tidak.
 * @returns {Promise<{previous: object|null, written: boolean, error: string|null}>}
 */
export async function registerModel(name, { role, project, cwd }, home = process.env.HOME) {
  const { models, error } = await readModelRegistry(home)
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
    const file = modelRegistryPath(home)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify(models, null, 2) + '\n', 'utf8')
    return { previous: null, written: true, error: null }
  } catch (err) {
    return { previous: null, written: false, error: err.message }
  }
}
