import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// Installer AnchorDB untuk knl-view. Dua jalur:
// - Linux: binary dari GitHub Releases (tar.gz sesuai arsitektur,
//   diverifikasi dengan SHA256SUMS.txt resmi rilis).
// - Non-Linux: AnchorDB butuh mmap Linux, jadi jalurnya container
//   ghcr.io/rachmanzz/anchordb:<versi> via docker/podman.
// Semua fungsi di sini murni/deterministik sebisa mungkin; orkestrasi
// interaktif (pertanyaan, spawn) tinggal di bin/knl-view.js.

export const GHCR_IMAGE = 'ghcr.io/rachmanzz/anchordb'
export const HTTP_PORT_DEFAULT = 7447
export const WIRE_PORT_DEFAULT = 7448
export const CONTAINER_NAME = 'anchordb-knlview'

/** Nama aset rilis untuk platform/arsitektur, sesuai pola rilis AnchorDB. */
export function releaseAssetName(version, platform = process.platform, arch = process.arch) {
  const archName = arch === 'arm64' ? 'arm64' : 'amd64'
  const platformName = platform === 'darwin' ? 'darwin' : 'linux'
  return `anchordb_${version}_${platformName}_${archName}.tar.gz`
}

/** Token acak untuk ANCHORDB_AUTH_TOKEN: 32 byte hex. */
export function generateToken() {
  return crypto.randomBytes(32).toString('hex')
}

/** Ambil rilis terbaru dari GitHub API. */
export async function latestRelease(repo = 'rachmanzz/anchordb') {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`)
  if (!res.ok) throw new Error(`GitHub API ${res.status}: gagal membaca rilis terbaru`)
  const body = await res.json()
  if (!body.tag_name) throw new Error('Rilis terbaru tidak memiliki tag_name')
  const version = String(body.tag_name).replace(/^v/, '')
  return { tag: body.tag_name, version }
}

/** Unduh satu file ke disk. */
export async function downloadFile(url, dest) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`Unduhan gagal (${res.status}): ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await fs.writeFile(dest, buf)
  return buf.length
}

/**
 * Verifikasi file terhadap isi SHA256SUMS.txt format standar:
 * "<hash>  <nama>" per baris. Melempar Error bila nama tidak ada atau
 * hash tidak cocok.
 */
export async function verifySha256(filePath, sumsText) {
  const fileName = path.basename(filePath)
  const line = String(sumsText)
    .split('\n')
    .find((l) => l.trim().endsWith(fileName))
  if (!line) throw new Error(`${fileName} tidak ada di SHA256SUMS.txt`)
  const expected = line.trim().split(/\s+/)[0].toLowerCase()
  const actual = crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex')
  if (actual !== expected) {
    throw new Error(`SHA256 tidak cocok untuk ${fileName}\n  harap  ${expected}\n  dapat  ${actual}`)
  }
  return expected
}

/**
 * Gabungkan blok anchordb ke config global (~/.knlview/knl-config.json)
 * tanpa menghapus field lain yang mungkin ada di sana. Mengembalikan isi
 * config sebelum ditimpa (untuk cadangan bila pemanggil mau menampilkan).
 */
export async function mergeGlobalAnchordb(home, anchordb) {
  const file = path.join(home, '.knlview', 'knl-config.json')
  let before = null
  let raw = {}
  try {
    const text = await fs.readFile(file, 'utf8')
    before = text
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed
  } catch {
    // File hilang/rusak: mulai dari objek kosong.
  }
  raw.anchordb = anchordb
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(raw, null, 2) + '\n', 'utf8')
  return before
}

/** Pilih runtime container yang tersedia: podman lebih dulu, lalu docker. */
export async function detectContainerRuntime(which) {
  for (const runtime of ['podman', 'docker']) {
    if (await which(runtime)) return runtime
  }
  return null
}
