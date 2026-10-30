import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// AnchorDB installer for knl-view. Two paths:
// - Linux: binary from GitHub Releases (tar.gz per architecture, verified
//   against the release's official SHA256SUMS.txt).
// - Non-Linux: AnchorDB needs Linux mmap, so the path is the
//   ghcr.io/rachmanzz/anchordb:<version> container via docker/podman.
// Everything here is as pure/deterministic as possible; interactive
// orchestration (prompts, spawn) stays in bin/knl-view.js.

export const GHCR_IMAGE = 'ghcr.io/rachmanzz/anchordb'
export const HTTP_PORT_DEFAULT = 7447
export const WIRE_PORT_DEFAULT = 7448
export const CONTAINER_NAME = 'anchordb-knlview'

/** Release asset name for a platform/architecture, per the AnchorDB release pattern. */
export function releaseAssetName(version, platform = process.platform, arch = process.arch) {
  const archName = arch === 'arm64' ? 'arm64' : 'amd64'
  const platformName = platform === 'darwin' ? 'darwin' : 'linux'
  return `anchordb_${version}_${platformName}_${archName}.tar.gz`
}

/** Random token for ANCHORDB_AUTH_TOKEN: 32 bytes of hex. */
export function generateToken() {
  return crypto.randomBytes(32).toString('hex')
}

/** Fetch the latest release from the GitHub API. */
export async function latestRelease(repo = 'rachmanzz/anchordb') {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`)
  if (!res.ok) throw new Error(`GitHub API ${res.status}: failed to read the latest release`)
  const body = await res.json()
  if (!body.tag_name) throw new Error('Latest release has no tag_name')
  const version = String(body.tag_name).replace(/^v/, '')
  return { tag: body.tag_name, version }
}

/** Download one file to disk. */
export async function downloadFile(url, dest) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await fs.writeFile(dest, buf)
  return buf.length
}

/**
 * Verify a file against SHA256SUMS.txt contents in the standard format:
 * "<hash>  <name>" per line. Throws an Error when the name is missing or
 * the hash does not match.
 */
export async function verifySha256(filePath, sumsText) {
  const fileName = path.basename(filePath)
  const line = String(sumsText)
    .split('\n')
    .find((l) => l.trim().endsWith(fileName))
  if (!line) throw new Error(`${fileName} is not in SHA256SUMS.txt`)
  const expected = line.trim().split(/\s+/)[0].toLowerCase()
  const actual = crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex')
  if (actual !== expected) {
    throw new Error(`SHA256 mismatch for ${fileName}\n  wanted  ${expected}\n  got     ${actual}`)
  }
  return expected
}

/**
 * Merge the anchordb block into the global config (~/.knlview/knl-config.json)
 * without dropping other fields that may live there. Returns the config
 * contents before the overwrite (as a backup, in case the caller shows it).
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
    // Missing/broken file: start from an empty object.
  }
  raw.anchordb = anchordb
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(raw, null, 2) + '\n', 'utf8')
  return before
}

/** Pick an available container runtime: podman first, then docker. */
export async function detectContainerRuntime(which) {
  for (const runtime of ['podman', 'docker']) {
    if (await which(runtime)) return runtime
  }
  return null
}
