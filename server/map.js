import { promises as fs } from 'node:fs'
import path from 'node:path'

// The optional map (map.json): pure annotation on top of the disk structure.
// Principle: the disk is the truth, the map is an overlay. The map NEVER
// defines the existence of files/folders. A file missing from disk stays
// missing from the viewer even when the map still lists it (orphan entries
// are silently ignored). The map only decorates: title, order, metadata.

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
    // A broken map must never bring the viewer down: ignore it quietly.
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return parsed
}

// Normalize shapes: the map may write the title in `title` (root/files),
// `sections`/`dirs` (folders), and `docs`/`files` (files). Only one clean
// representation matters for the overlay. Each entry may carry
// `ignore: true` to hide it (the disk still owns the file).
export function normalizeMap(map) {
  if (!map) return { title: null, entries: new Map() }
  const entries = new Map()

  const dirs = { ...asObject(map.sections), ...asObject(map.dirs) }
  for (const [key, value] of Object.entries(dirs)) {
    const entry = asObject(value)
    if (!entry) continue
    mergeEntry(entries, cleanKey(key), entry)
  }

  // `docs`/`files` can be placed per folder:
  // { "features/x": { "docs": { "a.md": {...} } } } or globally.
  // Both are written into the same file entries.
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

// Apply the overlay to one node. Returns a new node (without corrupting the
// original object from disk), or the same node when the map does not touch it.
export function decorateNode(node, norm) {
  const entry = norm?.entries?.get(node.path)
  let next = node

  const title = entry?.title
  if (title) {
    // A map title beats the heading title read from the file contents.
    // `titleFromMap` marks that this label came from the map, so the view
    // may use it directly as the label (not just as a subtitle).
    next = { ...next, title, titleFromMap: true }
  }
  const order = entry?.order
  if (order != null) next = { ...next, order }
  const meta = entry?.meta
  if (meta != null) next = { ...next, meta }

  // Children are already decorated by buildTree while walking the disk,
  // so here it is enough to touch this node only.
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
