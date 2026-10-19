import { promises as fs } from 'node:fs'
import path from 'node:path'

// Peta (map.json) opsional: murni anotasi di atas struktur disk.
// Prinsipnya — disk itu kebenaran, peta itu overlay. Peta TIDAK PERNAH
// mendefinisikan keberadaan berkas/folder. Berkas yang hilang dari disk
// tetap hilang dari viewer meski peta masih menyebutnya (entri yatim
// diabaikan diam-diam). Peta hanya menghias: judul, urutan, metadata.

const MAP_FILE = 'map.json'
const MAX_MAP_BYTES = 1024 * 1024

export async function readMap(rootAbs) {
  const abs = path.join(rootAbs, MAP_FILE)
  const stat = await statOrNull(abs)
  if (!stat || !stat.isFile() || stat.size > MAX_MAP_BYTES) return null

  let parsed
  try {
    parsed = JSON.parse(await fs.readFile(abs, 'utf8'))
  } catch {
    // Peta rusak tidak boleh menjatuhkan viewer: abaikan dengan tenang.
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return parsed
}

// Samakan bentuk: peta bisa menuliskan judul di `title` (untuk root/berkas)
// atau `sections`/`dirs` (folder) dan `docs`/`files` (berkas). Yang penting
// hanya satu representasi bersih yang dipakai overlay. Tiap entri boleh
// membawa `ignore: true` untuk menyembunyikan (disk tetap punya berkasnya).
export function normalizeMap(map) {
  if (!map) return { title: null, entries: new Map() }
  const entries = new Map()

  const dirs = { ...asObject(map.sections), ...asObject(map.dirs) }
  for (const [key, value] of Object.entries(dirs)) {
    const entry = asObject(value)
    if (!entry) continue
    mergeEntry(entries, cleanKey(key), entry)
  }

  // `docs`/`files` bisa ditaruh per-folder:
  // { "features/x": { "docs": { "a.md": {...} } } } atau global.
  // Keduanya ditulis ke entri berkas yang sama.
  const globalDocs = { ...asObject(map.docs), ...asObject(map.files) }
  applyDocs(entries, '', globalDocs)
  for (const [key, value] of Object.entries(dirs)) {
    const docs = asObject(asObject(value)?.docs)
    if (docs) applyDocs(entries, cleanKey(key), docs)
  }

  const ignoreList = Array.isArray(map.ignore) ? map.ignore : []
  for (const path of ignoreList) {
    if (typeof path !== 'string' || !path.trim()) continue
    mergeEntry(entries, cleanKey(path), { ignore: true })
  }

  return {
    title: typeof map.title === 'string' ? map.title.trim() : null,
    entries
  }
}

function applyDocs(entries, dirKey, docs) {
  for (const [name, value] of Object.entries(docs)) {
    const entry = asObject(value) || {}
    const key = dirKey ? `${dirKey}/${name}` : name
    mergeEntry(entries, cleanKey(key), entry)
  }
}

function mergeEntry(entries, key, entry) {
  const prev = entries.get(key) || {}
  entries.set(key, {
    title: typeof entry.title === 'string' ? entry.title.trim() : prev.title ?? null,
    order: toOrder(entry.order) ?? prev.order ?? null,
    meta: typeof entry.meta === 'string' ? entry.meta.trim() : prev.meta ?? null,
    ignore: entry.ignore === true || entry.hidden === true ? true : prev.ignore === true
  })
}

// Terapkan overlay ke satu simpul. Mengembalikan simpul baru (tanpa merusak
// objek asli dari disk), atau simpul yang sama kalau peta tidak menyentuhnya.
// Terapkan overlay ke satu simpul. Mengembalikan simpul baru (tanpa merusak
// objek asli dari disk), atau simpul yang sama kalau peta tidak menyentuhnya.
export function decorateNode(node, norm) {
  const entry = norm?.entries?.get(node.path)
  let next = node

  const title = entry?.title
  if (title) {
    // Judul peta mengalahkan judul heading yang dibaca dari isi berkas.
    // `titleFromMap` menandai bahwa label ini datang dari peta, sehingga
    // tampilan boleh memakainya langsung sebagai label (bukan sekadar sub).
    next = { ...next, title, titleFromMap: true }
  }
  const order = entry?.order
  if (order != null) next = { ...next, order }
  const meta = entry?.meta
  if (meta != null) next = { ...next, meta }

  // Anak-anak sudah dihias sendiri oleh buildTree saat menyusuri disk,
  // jadi di sini cukup menyentuh simpul ini saja.
  return next
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function cleanKey(key) {
  return String(key).replace(/^\.?\//, '').replace(/\/+$/, '')
}

function toOrder(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

async function statOrNull(abs) {
  try {
    return await fs.stat(abs)
  } catch {
    return null
  }
}
