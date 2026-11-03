import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import net from 'node:net'
import { globalConfigPath } from './config.js'

// AnchorDB installer for knl-view. Two paths:
// - Linux: binary from GitHub Releases (tar.gz per architecture, verified
//   against the release's official SHA256SUMS.txt).
// - Non-Linux: AnchorDB needs Linux mmap, so the path is the
//   ghcr.io/rachmanzz/anchordb:<version> container via docker/podman.
// Everything here is as pure/deterministic as possible; interactive
// orchestration (prompts, spawn) stays in bin/knl-view.js.

export const GHCR_IMAGE = 'ghcr.io/rachmanzz/anchordb'
export const HTTP_PORT_DEFAULT = 17447
export const WIRE_PORT_DEFAULT = 17448
export const CONTAINER_NAME = 'anchordb-knlview'

/** Check if a TCP port is currently free on a host. */
export async function isPortAvailable(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, host)
  })
}

/** Find the next available TCP port sequentially starting from startPort. */
export async function findNextAvailablePort(startPort, host = '127.0.0.1') {
  let port = Number(startPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError(`Invalid start port: ${startPort}`)
  }
  while (!(await isPortAvailable(port, host))) {
    port++
    if (port > 65535) {
      throw new Error(`No available port found up to 65535 starting from ${startPort}`)
    }
  }
  return port
}

/** Check desired AnchorDB ports and suggest alternatives if any is taken. */
export async function resolveAnchorPorts({
  desiredWirePort = WIRE_PORT_DEFAULT,
  desiredHttpPort = HTTP_PORT_DEFAULT,
  host = '127.0.0.1'
} = {}) {
  const wireAvailable = await isPortAvailable(desiredWirePort, host)
  const httpAvailable = desiredHttpPort !== desiredWirePort && (await isPortAvailable(desiredHttpPort, host))

  const suggestedWirePort = wireAvailable ? desiredWirePort : await findNextAvailablePort(desiredWirePort + 1, host)
  let candidateHttp = (httpAvailable && desiredHttpPort !== suggestedWirePort)
    ? desiredHttpPort
    : await findNextAvailablePort(desiredHttpPort + 1, host)
  if (candidateHttp === suggestedWirePort) {
    candidateHttp = await findNextAvailablePort(candidateHttp + 1, host)
  }

  return {
    wirePort: desiredWirePort,
    httpPort: desiredHttpPort,
    wireAvailable,
    httpAvailable,
    suggestedWirePort,
    suggestedHttpPort: candidateHttp
  }
}

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
 * Merge the anchordb block into the global config (knl-config.json)
 * without dropping other fields that may live there. Returns the config
 * contents before the overwrite (as a backup, in case the caller shows it).
 */
export async function mergeGlobalAnchordb(home, anchordb, options = {}) {
  const file = globalConfigPath(home, options)
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
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await fs.writeFile(file, JSON.stringify(raw, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  try { await fs.chmod(file, 0o600) } catch {}
  return before
}

/** List all available container runtimes on the system. */
export async function availableContainerRuntimes(which) {
  const found = []
  for (const runtime of ['docker', 'podman']) {
    if (await which(runtime)) found.push(runtime)
  }
  return found
}

/** Pick an available container runtime: preferred first, or first detected. */
export async function detectContainerRuntime(which, preferred = null) {
  if (preferred) {
    if (await which(preferred)) return preferred
    return null
  }
  const available = await availableContainerRuntimes(which)
  return available[0] || null
}

/**
 * Inspect detailed container lifecycle status across available runtimes.
 * Returns exists, runtime, running, valid, status, id, created, token, wire_port.
 */
export async function inspectContainerStatus(exec, name = CONTAINER_NAME) {
  for (const runtime of ['podman', 'docker']) {
    try {
      const { stdout } = await exec(runtime, [
        'inspect',
        '--format',
        '{{.Id}}|{{.Created}}|{{.State.Status}}|{{.State.Running}}|{{json .Config.Env}}',
        name
      ])
      const parts = stdout.trim().split('|')
      if (parts.length >= 4 && parts[0]) {
        const id = parts[0].trim()
        const created = parts[1].trim()
        const status = (parts[2] || '').trim().toLowerCase()
        const running = (parts[3] || '').trim().toLowerCase() === 'true'
        const valid = !['dead', 'removal', 'corrupt'].includes(status) && id.length >= 12
        const envStr = parts.slice(4).join('|')
        let token = null
        let port = String(WIRE_PORT_DEFAULT)
        let httpPort = String(HTTP_PORT_DEFAULT)
        try {
          const envs = JSON.parse(envStr)
          for (const e of envs) {
            if (e.startsWith('ANCHORDB_AUTH_TOKEN=')) token = e.slice('ANCHORDB_AUTH_TOKEN='.length)
            if (e.startsWith('ANCHORDB_WIRE_PORT=')) port = e.slice('ANCHORDB_WIRE_PORT='.length)
            if (e.startsWith('ANCHORDB_PORT=')) httpPort = e.slice('ANCHORDB_PORT='.length)
          }
        } catch {}

        return {
          exists: true,
          runtime,
          name,
          id,
          created,
          status,
          running,
          valid,
          token,
          wire_port: port,
          http_port: httpPort
        }
      }
    } catch {
      // not in this runtime
    }
  }

  return {
    exists: false,
    runtime: null,
    name,
    id: null,
    created: null,
    status: null,
    running: false,
    valid: false,
    token: null,
    wire_port: String(WIRE_PORT_DEFAULT),
    http_port: String(HTTP_PORT_DEFAULT)
  }
}

export async function startContainer(exec, runtime, name = CONTAINER_NAME) {
  await exec(runtime, ['start', name])
}

export async function stopContainer(exec, runtime, name = CONTAINER_NAME) {
  await exec(runtime, ['stop', name])
}

export async function removeContainer(exec, runtime, name = CONTAINER_NAME) {
  await exec(runtime, ['rm', '-f', name])
}

export async function detectGraphify(exec) {
  try {
    await exec('which', ['graphify'])
    return true
  } catch {
    return false
  }
}

export const DECISIONSKILLS_REPO = 'rachmanzz/decisionskills'

/**
 * Check if the decision-history skill (from rachmanzz/decisionskills) is
 * installed in project or global agent directories, and if an update is available.
 */
export async function checkDecisionSkillsStatus({ cwd = process.cwd(), home = process.env.HOME }) {
  const projectSkill = path.join(cwd, '.agents', 'skills', 'decision-history', 'SKILL.md')
  let hasProject = false
  try {
    await fs.stat(projectSkill)
    hasProject = true
  } catch {}

  const globalPaths = [
    path.join(home || '', '.codex', 'skills', 'decision-history', 'SKILL.md'),
    path.join(home || '', '.claude', 'skills', 'decision-history', 'SKILL.md'),
    path.join(home || '', '.config', 'opencode', 'skills', 'decision-history', 'SKILL.md'),
    path.join(home || '', '.gemini', 'config', 'plugins', 'decision-history', 'skills', 'decision-history', 'SKILL.md'),
    path.join(home || '', '.agents', 'skills', 'decision-history', 'SKILL.md')
  ]

  let hasGlobal = false
  for (const p of globalPaths) {
    try {
      await fs.stat(p)
      hasGlobal = true
      break
    } catch {}
  }

  let currentVersion = null
  let latestVersion = null
  let status = 'not_installed'

  if (hasProject || hasGlobal) {
    status = 'installed'
    const versionCandidates = [
      path.join(cwd, '.agents', 'skills', 'decision-history', 'VERSION'),
      path.join(home || '', '.gemini', 'config', 'plugins', 'decision-history', 'VERSION')
    ]
    for (const vFile of versionCandidates) {
      try {
        const text = await fs.readFile(vFile, 'utf8')
        if (text.trim()) {
          currentVersion = text.trim()
          break
        }
      } catch {}
    }

    try {
      const res = await fetch('https://raw.githubusercontent.com/rachmanzz/decisionskills/main/VERSION', {
        signal: AbortSignal.timeout(2000)
      })
      if (res.ok) {
        latestVersion = (await res.text()).trim()
        if (currentVersion && latestVersion && currentVersion !== latestVersion) {
          status = 'needs_update'
        }
      }
    } catch {}
  }

  return {
    hasProject,
    hasGlobal,
    status, // 'not_installed' | 'installed' | 'needs_update'
    currentVersion,
    latestVersion,
    projectPath: projectSkill
  }
}

/**
 * Install or update the decision-history skill from rachmanzz/decisionskills.
 * Scope: 'project' | 'global' | 'both'.
 */
export async function installDecisionSkills({
  scope = 'project',
  cwd = process.cwd(),
  home = process.env.HOME,
  exec
}) {
  const results = []

  const copyDir = async (src, dest) => {
    await fs.mkdir(dest, { recursive: true })
    const entries = await fs.readdir(src, { withFileTypes: true })
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name)
      const destPath = path.join(dest, entry.name)
      if (entry.isDirectory()) {
        await copyDir(srcPath, destPath)
      } else {
        await fs.copyFile(srcPath, destPath)
      }
    }
  }

  const doInstall = async (isGlobal) => {
    let success = false
    if (exec) {
      try {
        const args = ['--yes', 'skills', 'add', DECISIONSKILLS_REPO, '--skill', 'decision-history', '-y', '--copy']
        if (isGlobal) args.push('-g')
        await exec('npx', args, { cwd })
        success = true
      } catch {}
    }

    if (!success) {
      const fallbackSources = [
        path.join(home || '', '.gemini', 'config', 'plugins', 'decision-history', 'skills', 'decision-history'),
        path.join(home || '', '.agents', 'skills', 'decision-history'),
        path.join(home || '', '.codex', 'skills', 'decision-history')
      ]
      let srcDir = null
      for (const candidate of fallbackSources) {
        try {
          await fs.stat(path.join(candidate, 'SKILL.md'))
          srcDir = candidate
          break
        } catch {}
      }

      if (srcDir) {
        const dest = isGlobal
          ? path.join(home || '', '.agents', 'skills', 'decision-history')
          : path.join(cwd, '.agents', 'skills', 'decision-history')
        await copyDir(srcDir, dest)
        success = true
      }
    }

    if (isGlobal && exec) {
      const agyDir = path.join(home || '', '.gemini', 'config', 'plugins', 'decision-history')
      try {
        await fs.stat(agyDir)
        await exec('git', ['pull'], { cwd: agyDir })
      } catch {
        try {
          await fs.mkdir(path.dirname(agyDir), { recursive: true })
          await exec('git', ['clone', 'https://github.com/rachmanzz/decisionskills.git', agyDir])
        } catch {}
      }
    }

    return success
  }

  if (scope === 'project' || scope === 'both') {
    const ok = await doInstall(false)
    results.push({ scope: 'project', success: ok })
  }
  if (scope === 'global' || scope === 'both') {
    const ok = await doInstall(true)
    results.push({ scope: 'global', success: ok })
  }

  return results
}

/**
 * Detect a running AnchorDB daemon on the system (docker, podman, or binary).
 * Inspects containers for CONTAINER_NAME or checks running processes.
 */
export async function detectRunningDaemon(exec) {
  const container = await inspectContainerStatus(exec)
  if (container.exists && container.running && container.valid) {
    return {
      daemon: container.runtime,
      deamon: container.runtime,
      container_name: container.name,
      container_id: container.id,
      container_created_on: container.created,
      token: container.token,
      wire_port: container.wire_port
    }
  }

  // Check if binary process is running
  try {
    const { stdout } = await exec('pgrep', ['-f', 'anchordb-server'])
    if (stdout.trim()) {
      return { daemon: 'binary', deamon: 'binary' }
    }
  } catch {}

  return null
}

/**
 * PIDs of running anchordb-server processes (the binary daemon), via pgrep.
 * Empty when none is running or pgrep is unavailable.
 */
export async function binaryServerPids(exec) {
  try {
    const { stdout } = await exec('pgrep', ['-f', 'anchordb-server'])
    return stdout
      .trim()
      .split('\n')
      .map((row) => Number(row.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
  } catch {
    return []
  }
}
