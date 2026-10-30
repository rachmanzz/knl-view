import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import {
  modelRegistryPath,
  generateModelName,
  readModelRegistry,
  registerModel
} from '../server/models_registry.js'

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'knl-registry-'))
}

describe('generateModelName', () => {
  test('returns 8 unambiguous base32 characters', () => {
    const name = generateModelName()
    assert.match(name, /^[0-9a-hjkmnp-tv-z]{8}$/)
    assert.doesNotMatch(name, /[ilo]/)
  })

  test('generates different names across calls', () => {
    const seen = new Set([generateModelName(), generateModelName(), generateModelName()])
    assert.equal(seen.size, 3)
  })
})

describe('readModelRegistry', () => {
  test('missing file means empty registry, no error', async () => {
    const home = makeHome()
    const { models, error } = await readModelRegistry(home)
    assert.deepEqual(models, {})
    assert.equal(error, null)
  })

  test('broken file is reported, not fatal', async () => {
    const home = makeHome()
    fs.mkdirSync(path.join(home, '.knlview'), { recursive: true })
    fs.writeFileSync(path.join(home, '.knlview', 'models.json'), '{ broken', 'utf8')
    const { models, error } = await readModelRegistry(home)
    assert.deepEqual(models, {})
    assert.match(error, /Unexpected|JSON/)
  })

  test('entries without a role are dropped', async () => {
    const home = makeHome()
    fs.mkdirSync(path.join(home, '.knlview'), { recursive: true })
    fs.writeFileSync(path.join(home, '.knlview', 'models.json'), JSON.stringify({
      vx42k9: { role: 'knowledges', project: 'a', cwd: '/a' },
      junk: { project: 'b' }
    }), 'utf8')
    const { models } = await readModelRegistry(home)
    assert.deepEqual(Object.keys(models), ['vx42k9'])
  })
})

describe('registerModel', () => {
  test('registers a new name and persists it', async () => {
    const home = makeHome()
    const { previous, written, error } = await registerModel('vx42k9', {
      role: 'knowledges', project: 'proj-a', cwd: '/tmp/proj-a'
    }, home)
    assert.equal(previous, null)
    assert.equal(written, true)
    assert.equal(error, null)

    const { models } = await readModelRegistry(home)
    assert.equal(models.vx42k9.role, 'knowledges')
    assert.equal(models.vx42k9.project, 'proj-a')
  })

  test('same owner re-registration updates the entry', async () => {
    const home = makeHome()
    await registerModel('vx42k9', { role: 'knowledges', project: 'proj-a', cwd: '/tmp/proj-a' }, home)
    const { previous, written } = await registerModel('vx42k9', {
      role: 'knowledges', project: 'proj-a-renamed', cwd: '/tmp/proj-a'
    }, home)
    assert.equal(previous, null)
    assert.equal(written, true)
    const { models } = await readModelRegistry(home)
    assert.equal(models.vx42k9.project, 'proj-a-renamed')
  })

  test('name claimed by another project is refused, registry untouched', async () => {
    const home = makeHome()
    await registerModel('vx42k9', { role: 'knowledges', project: 'proj-a', cwd: '/tmp/proj-a' }, home)
    const { previous, written } = await registerModel('vx42k9', {
      role: 'knowledges', project: 'proj-b', cwd: '/tmp/proj-b'
    }, home)
    assert.equal(written, false)
    assert.equal(previous.cwd, '/tmp/proj-a')

    const { models } = await readModelRegistry(home)
    assert.equal(models.vx42k9.project, 'proj-a')
  })

  test('registryPath lives under ~/.knlview', () => {
    assert.equal(modelRegistryPath('/home/u'), path.join('/home/u', '.knlview', 'models.json'))
  })
})
