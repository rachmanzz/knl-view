import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import {
  releaseAssetName,
  generateToken,
  verifySha256,
  mergeGlobalAnchordb,
  availableContainerRuntimes,
  detectContainerRuntime,
  detectRunningDaemon,
  binaryServerPids,
  inspectContainerStatus,
  startContainer,
  stopContainer,
  removeContainer,
  detectGraphify,
  checkDecisionSkillsStatus,
  installDecisionSkills,
  isPortAvailable,
  findNextAvailablePort,
  resolveAnchorPorts,
  HTTP_PORT_DEFAULT,
  WIRE_PORT_DEFAULT
} from '../server/install.js'

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'knl-install-'))
}

describe('releaseAssetName', () => {
  test('maps platform and arch to the release asset pattern', () => {
    assert.equal(releaseAssetName('0.1.3', 'linux', 'x64'), 'anchordb_0.1.3_linux_amd64.tar.gz')
    assert.equal(releaseAssetName('0.1.3', 'linux', 'arm64'), 'anchordb_0.1.3_linux_arm64.tar.gz')
    assert.equal(releaseAssetName('0.1.3', 'darwin', 'x64'), 'anchordb_0.1.3_darwin_amd64.tar.gz')
  })
})

describe('generateToken', () => {
  test('returns 64 hex characters, unique per call', () => {
    const a = generateToken()
    const b = generateToken()
    assert.match(a, /^[0-9a-f]{64}$/)
    assert.notEqual(a, b)
  })
})

describe('verifySha256', () => {
  test('accepts a file listed with the correct digest', async () => {
    const dir = makeHome()
    const file = path.join(dir, 'anchordb_0.1.3_linux_amd64.tar.gz')
    fs.writeFileSync(file, 'payload')
    const sums = [
      '0000000000000000000000000000000000000000000000000000000000000000  other.tar.gz',
      `${await sha256Of(file)}  anchordb_0.1.3_linux_amd64.tar.gz`
    ].join('\n')
    const digest = await verifySha256(file, sums)
    assert.equal(digest, await sha256Of(file))
  })

  test('rejects a wrong digest', async () => {
    const dir = makeHome()
    const file = path.join(dir, 'anchordb.tar.gz')
    fs.writeFileSync(file, 'payload')
    const sums = `${'0'.repeat(64)}  anchordb.tar.gz`
    await assert.rejects(() => verifySha256(file, sums), /SHA256 mismatch/)
  })

  test('rejects a file missing from the sums list', async () => {
    const dir = makeHome()
    const file = path.join(dir, 'mystery.tar.gz')
    fs.writeFileSync(file, 'payload')
    await assert.rejects(() => verifySha256(file, '0'.repeat(64) + '  other.tar.gz'), /not in SHA256SUMS/)
  })
})

describe('mergeGlobalAnchordb', () => {
  test('creates config and keeps unrelated fields on merge', async () => {
    const home = makeHome()
    await mergeGlobalAnchordb(home, { url: 'wire://127.0.0.1:7448', token: 't1', sync: true })
    await mergeGlobalAnchordb(home, { url: 'wire://127.0.0.1:7448', token: 't2', sync: true })

    const raw = JSON.parse(fs.readFileSync(path.join(home, '.knlview', 'knl-config.json'), 'utf8'))
    assert.equal(raw.anchordb.token, 't2')
    assert.equal(raw.anchordb.url, 'wire://127.0.0.1:7448')
    if (process.platform !== 'win32') {
      const stat = fs.statSync(path.join(home, '.knlview', 'knl-config.json'))
      assert.equal(stat.mode & 0o777, 0o600)
    }
  })

  test('stores daemon and container metadata', async () => {
    const home = makeHome()
    await mergeGlobalAnchordb(home, {
      url: 'wire://127.0.0.1:7448',
      token: 't-daemon',
      sync: true,
      daemon: 'podman',
      container_name: 'anchordb-knlview',
      container_id: 'podman-id-abc',
      container_created_on: '2026-10-31T12:00:00Z'
    })

    const raw = JSON.parse(fs.readFileSync(path.join(home, '.knlview', 'knl-config.json'), 'utf8'))
    assert.equal(raw.anchordb.daemon, 'podman')
    assert.equal(raw.anchordb.container_name, 'anchordb-knlview')
    assert.equal(raw.anchordb.container_id, 'podman-id-abc')
    assert.equal(raw.anchordb.container_created_on, '2026-10-31T12:00:00Z')
  })

  test('survives a broken existing config', async () => {
    const home = makeHome()
    fs.mkdirSync(path.join(home, '.knlview'), { recursive: true })
    fs.writeFileSync(path.join(home, '.knlview', 'knl-config.json'), '{ broken', 'utf8')
    const before = await mergeGlobalAnchordb(home, { url: 'wire://x', token: 't', sync: true })
    assert.equal(before, '{ broken')
    const raw = JSON.parse(fs.readFileSync(path.join(home, '.knlview', 'knl-config.json'), 'utf8'))
    assert.equal(raw.anchordb.token, 't')
  })
})

describe('detectContainerRuntime and availableContainerRuntimes', () => {
  test('returns available runtimes matching which predicate', async () => {
    const which = async (cmd) => cmd === 'docker'
    const available = await availableContainerRuntimes(which)
    assert.deepEqual(available, ['docker'])

    const detected = await detectContainerRuntime(which)
    assert.equal(detected, 'docker')
  })

  test('detects preferred runtime when available', async () => {
    const which = async (cmd) => ['docker', 'podman'].includes(cmd)
    const available = await availableContainerRuntimes(which)
    assert.deepEqual(available, ['docker', 'podman'])

    const podman = await detectContainerRuntime(which, 'podman')
    assert.equal(podman, 'podman')

    const docker = await detectContainerRuntime(which, 'docker')
    assert.equal(docker, 'docker')

    const unavailable = await detectContainerRuntime(which, 'nerdctl')
    assert.equal(unavailable, null)
  })
})

describe('detectRunningDaemon', () => {
  test('detects running container daemon with env and metadata', async () => {
    const mockExec = async (cmd, args) => {
      if (cmd === 'podman' && args[0] === 'inspect') {
        const id = 'podman-cid-999'
        const created = '2026-10-31T10:00:00Z'
        const status = 'running'
        const running = 'true'
        const envs = JSON.stringify(['ANCHORDB_AUTH_TOKEN=secret-123', 'ANCHORDB_WIRE_PORT=7448'])
        return { stdout: `${id}|${created}|${status}|${running}|${envs}\n` }
      }
      throw new Error('command failed')
    }

    const meta = await detectRunningDaemon(mockExec)
    assert.deepEqual(meta, {
      daemon: 'podman',
      container_name: 'anchordb-knlview',
      container_id: 'podman-cid-999',
      container_created_on: '2026-10-31T10:00:00Z',
      token: 'secret-123',
      wire_port: '7448'
    })
  })

  test('detects binary process when no container matches', async () => {
    const mockExec = async (cmd, args) => {
      if (cmd === 'pgrep' && args[1] === 'anchordb-server') {
        return { stdout: '12345\n' }
      }
      throw new Error('not found')
    }

    const meta = await detectRunningDaemon(mockExec)
    assert.deepEqual(meta, { daemon: 'binary' })
  })

  test('returns null when neither container nor binary is active', async () => {
    const mockExec = async () => {
      throw new Error('not found')
    }

    const meta = await detectRunningDaemon(mockExec)
    assert.equal(meta, null)
  })
})

describe('inspectContainerStatus', () => {
  test('returns stopped status when container exited', async () => {
    const mockExec = async (cmd, args) => {
      if (cmd === 'docker' && args[0] === 'inspect') {
        return { stdout: 'docker-cid-123456789012|2026-10-31T08:00:00Z|exited|false|[]\n' }
      }
      throw new Error('not found')
    }

    const res = await inspectContainerStatus(mockExec)
    assert.equal(res.exists, true)
    assert.equal(res.running, false)
    assert.equal(res.valid, true)
    assert.equal(res.runtime, 'docker')
  })

  test('marks dead/corrupted container as invalid', async () => {
    const mockExec = async (cmd, args) => {
      if (cmd === 'podman' && args[0] === 'inspect') {
        return { stdout: 'podman-cid-dead123456789|2026-10-31T08:00:00Z|dead|false|[]\n' }
      }
      throw new Error('not found')
    }

    const res = await inspectContainerStatus(mockExec)
    assert.equal(res.exists, true)
    assert.equal(res.valid, false)
    assert.equal(res.status, 'dead')
  })

  test('reports exists: false when container not found', async () => {
    const mockExec = async () => {
      throw new Error('no such container')
    }

    const res = await inspectContainerStatus(mockExec)
    assert.equal(res.exists, false)
    assert.equal(res.running, false)
  })

  test('parses token, wire port, and HTTP port from the container env', async () => {
    const envs = JSON.stringify(['ANCHORDB_AUTH_TOKEN=secret-123', 'ANCHORDB_PORT=17447', 'ANCHORDB_WIRE_PORT=17448'])
    const mockExec = async (cmd, args) => {
      if (cmd === 'podman' && args[0] === 'inspect') {
        return { stdout: `podman-cid-abcdef123456|2026-10-31T08:00:00Z|running|true|${envs}\n` }
      }
      throw new Error('not found')
    }

    const res = await inspectContainerStatus(mockExec)
    assert.equal(res.token, 'secret-123')
    assert.equal(res.wire_port, '17448')
    assert.equal(res.http_port, '17447')
  })
})

describe('container lifecycle actions and detectGraphify', () => {
  test('startContainer invokes start with name', async () => {
    let invoked = null
    const mockExec = async (cmd, args) => {
      invoked = { cmd, args }
      return { stdout: '' }
    }
    await startContainer(mockExec, 'docker', 'my-container')
    assert.deepEqual(invoked, { cmd: 'docker', args: ['start', 'my-container'] })
  })

  test('removeContainer invokes rm -f with name', async () => {
    let invoked = null
    const mockExec = async (cmd, args) => {
      invoked = { cmd, args }
      return { stdout: '' }
    }
    await removeContainer(mockExec, 'podman', 'my-container')
    assert.deepEqual(invoked, { cmd: 'podman', args: ['rm', '-f', 'my-container'] })
  })

  test('stopContainer invokes stop with name', async () => {
    let invoked = null
    const mockExec = async (cmd, args) => {
      invoked = { cmd, args }
      return { stdout: '' }
    }
    await stopContainer(mockExec, 'docker', 'my-container')
    assert.deepEqual(invoked, { cmd: 'docker', args: ['stop', 'my-container'] })
  })

  test('binaryServerPids parses pgrep output into numbers', async () => {
    const mockExec = async (cmd, args) => {
      assert.equal(cmd, 'pgrep')
      assert.deepEqual(args, ['-f', 'anchordb-server'])
      return { stdout: '4242\n828\n' }
    }
    assert.deepEqual(await binaryServerPids(mockExec), [4242, 828])
  })

  test('binaryServerPids returns an empty list when pgrep finds nothing', async () => {
    const mockExec = async () => {
      const err = new Error('exit code 1')
      err.code = 1
      throw err
    }
    assert.deepEqual(await binaryServerPids(mockExec), [])
  })

  test('detectGraphify returns true when which succeeds', async () => {
    const mockExec = async (cmd, args) => {
      if (cmd === 'which' && args[0] === 'graphify') return { stdout: '/usr/bin/graphify\n' }
      throw new Error('not found')
    }
    assert.equal(await detectGraphify(mockExec), true)
  })

  test('detectGraphify returns false when which fails', async () => {
    const mockExec = async () => {
      throw new Error('not found')
    }
    assert.equal(await detectGraphify(mockExec), false)
  })
})

describe('checkDecisionSkillsStatus and installDecisionSkills', () => {
  test('detects not_installed when skill is missing', async () => {
    const temp = makeHome()
    const res = await checkDecisionSkillsStatus({ cwd: temp, home: temp })
    assert.equal(res.status, 'not_installed')
    assert.equal(res.hasProject, false)
    assert.equal(res.hasGlobal, false)
  })

  test('detects installed when skill exists in project', async () => {
    const temp = makeHome()
    const skillFile = path.join(temp, '.agents', 'skills', 'decision-history', 'SKILL.md')
    fs.mkdirSync(path.dirname(skillFile), { recursive: true })
    fs.writeFileSync(skillFile, '# Decision History\n')

    const res = await checkDecisionSkillsStatus({ cwd: temp, home: temp })
    assert.equal(res.status, 'installed')
    assert.equal(res.hasProject, true)
  })

  test('detects installed when skill exists in global agent dir', async () => {
    const temp = makeHome()
    const codexSkill = path.join(temp, '.codex', 'skills', 'decision-history', 'SKILL.md')
    fs.mkdirSync(path.dirname(codexSkill), { recursive: true })
    fs.writeFileSync(codexSkill, '# Decision History\n')

    const res = await checkDecisionSkillsStatus({ cwd: temp, home: temp })
    assert.equal(res.status, 'installed')
    assert.equal(res.hasGlobal, true)
  })

  test('installDecisionSkills invokes npx skills add with correct args', async () => {
    const calls = []
    const mockExec = async (cmd, args, opts) => {
      calls.push({ cmd, args, opts })
      return { stdout: '' }
    }

    const temp = makeHome()
    await installDecisionSkills({ scope: 'project', cwd: temp, home: temp, exec: mockExec })
    assert.ok(calls.some((c) => c.cmd === 'npx' && c.args.includes('rachmanzz/decisionskills') && !c.args.includes('-g')))

    await installDecisionSkills({ scope: 'global', cwd: temp, home: temp, exec: mockExec })
    assert.ok(calls.some((c) => c.cmd === 'npx' && c.args.includes('rachmanzz/decisionskills') && c.args.includes('-g')))
  })
})

describe('port detection and resolution', () => {
  test('constants define safe non-crowded ports in 10001-32767 range', () => {
    assert.equal(HTTP_PORT_DEFAULT, 17447)
    assert.equal(WIRE_PORT_DEFAULT, 17448)
  })

  test('isPortAvailable checks port availability', async () => {
    const available = await isPortAvailable(17448)
    assert.equal(typeof available, 'boolean')
  })

  test('findNextAvailablePort finds open port and validates boundaries', async () => {
    const port = await findNextAvailablePort(17448)
    assert.ok(port >= 17448 && port <= 65535)
    await assert.rejects(
      async () => findNextAvailablePort(0),
      /Invalid start port/
    )
    await assert.rejects(
      async () => findNextAvailablePort(70000),
      /Invalid start port/
    )
  })

  test('resolveAnchorPorts returns ports and availability', async () => {
    const res = await resolveAnchorPorts({ desiredWirePort: 17448, desiredHttpPort: 17447 })
    assert.equal(res.wirePort, 17448)
    assert.equal(res.httpPort, 17447)
    assert.equal(typeof res.wireAvailable, 'boolean')
    assert.equal(typeof res.httpAvailable, 'boolean')
    assert.equal(typeof res.suggestedWirePort, 'number')
    assert.equal(typeof res.suggestedHttpPort, 'number')
    assert.notEqual(res.suggestedWirePort, res.suggestedHttpPort)
  })

  test('resolveAnchorPorts resolves collision when desired wire and http ports are identical', async () => {
    const res = await resolveAnchorPorts({ desiredWirePort: 17448, desiredHttpPort: 17448 })
    assert.notEqual(res.suggestedWirePort, res.suggestedHttpPort)
  })
})

async function sha256Of(file) {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}
