import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import {
  releaseAssetName,
  generateToken,
  verifySha256,
  mergeGlobalAnchordb
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
    await assert.rejects(() => verifySha256(file, sums), /SHA256 tidak cocok/)
  })

  test('rejects a file missing from the sums list', async () => {
    const dir = makeHome()
    const file = path.join(dir, 'misterius.tar.gz')
    fs.writeFileSync(file, 'payload')
    await assert.rejects(() => verifySha256(file, '0'.repeat(64) + '  lain.tar.gz'), /tidak ada di SHA256SUMS/)
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

async function sha256Of(file) {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}
