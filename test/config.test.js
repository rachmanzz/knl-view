import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import {
  readProjectConfig,
  readGlobalConfig,
  globalConfigPath,
  normalizeProjectConfig,
  normalizeGlobalConfig,
  normalizeAnchordb,
  projectSlug,
  qualifyModel,
  resolveSettings,
  anchordbClientOptions,
  DEFAULT_SETTINGS
} from '../server/config.js'

function makeDir(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knl-config-'))
  for (const [name, content] of Object.entries(files)) {
    const abs = path.join(dir, name)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf8')
  }
  return dir
}

describe('readProjectConfig', () => {
  test('missing file is not an error', async () => {
    const dir = makeDir()
    const { config, error } = await readProjectConfig(dir)
    assert.equal(config, null)
    assert.equal(error, null)
  })

  test('broken JSON is ignored with an error message', async () => {
    const dir = makeDir({ 'knl-config.json': '{ "port": 8085,,' })
    const { config, error } = await readProjectConfig(dir)
    assert.equal(config, null)
    assert.match(error, /JSON tidak valid/)
  })

  test('valid file is normalized, including model', async () => {
    const dir = makeDir({
      'knl-config.json': JSON.stringify({
        path: 'docs/base',
        port: 9001,
        host: '0.0.0.0',
        model: 'decisions'
      })
    })
    const { config, error } = await readProjectConfig(dir)
    assert.equal(error, null)
    assert.deepEqual(config, { path: 'docs/base', port: '9001', host: '0.0.0.0', model: 'decisions' })
  })

  test('unknown and invalid fields are dropped, not fatal', async () => {
    const dir = makeDir({
      'knl-config.json': JSON.stringify({ port: 'abc', host: 42, path: [], anchordb: 'wire://h:1', model: 7 })
    })
    const { config } = await readProjectConfig(dir)
    assert.deepEqual(config, {})
  })
})

describe('readGlobalConfig', () => {
  test('reads ~/.knlview/knl-config.json', async () => {
    const home = makeDir({
      '.knlview/knl-config.json': JSON.stringify({
        anchordb: { url: 'wire://127.0.0.1:7448', token: 't1', sync: true }
      })
    })
    assert.equal(globalConfigPath(home), path.join(home, '.knlview', 'knl-config.json'))
    const { config, error } = await readGlobalConfig(home)
    assert.equal(error, null)
    assert.equal(config.anchordb.url, 'wire://127.0.0.1:7448')
    assert.equal(config.anchordb.token, 't1')
    assert.equal(config.anchordb.sync, true)
  })

  test('missing global file means AnchorDB off', async () => {
    const home = makeDir()
    const { config, error } = await readGlobalConfig(home)
    assert.equal(config, null)
    assert.equal(error, null)
  })

  test('global fields other than anchordb are ignored', async () => {
    const home = makeDir({
      '.knlview/knl-config.json': JSON.stringify({ port: 1234, anchordb: 'wire://h:1' })
    })
    const { config } = await readGlobalConfig(home)
    assert.deepEqual(config, { anchordb: { url: 'wire://h:1', sync: true } })
  })
})

describe('normalizeAnchordb', () => {
  test('accepts a compact wire:// string', () => {
    const a = normalizeAnchordb('wire://127.0.0.1:7448?token=secret')
    assert.equal(a.url, 'wire://127.0.0.1:7448?token=secret')
    assert.equal(a.sync, true)
  })

  test('rejects a value without wire:// or tcp:// scheme', () => {
    assert.equal(normalizeAnchordb({ url: 'http://127.0.0.1:7448' }), null)
    assert.equal(normalizeAnchordb('http://127.0.0.1:7448'), null)
    assert.equal(normalizeAnchordb({}), null)
    assert.equal(normalizeAnchordb(null), null)
  })

  test('keeps token, model, sync, and relations', () => {
    const a = normalizeAnchordb({
      url: 'tcp://localhost:7448',
      token: 't1',
      model: 'knowledges',
      sync: false,
      relations: ['supersedes', ' ', 'depends_on']
    })
    assert.deepEqual(a, {
      url: 'tcp://localhost:7448',
      token: 't1',
      model: 'knowledges',
      sync: false,
      relations: ['supersedes', 'depends_on']
    })
  })

  test('sync defaults to true', () => {
    assert.equal(normalizeAnchordb({ url: 'wire://h:1' }).sync, true)
    assert.equal(normalizeAnchordb({ url: 'wire://h:1', sync: false }).sync, false)
  })
})

describe('projectSlug and qualifyModel', () => {
  test('slug prefers package.json name, falls back to folder name', () => {
    const withPkg = makeDir({ 'package.json': JSON.stringify({ name: '@scope/My_App' }) })
    assert.equal(projectSlug(withPkg), 'scope-my-app')
    const plain = path.join(os.tmpdir(), 'knl-config-slug-proj')
    fs.rmSync(plain, { recursive: true, force: true })
    fs.mkdirSync(plain, { recursive: true })
    assert.equal(projectSlug(plain), 'knl-config-slug-proj')
  })

  test('qualifyModel namespaces and never double-prefixes', () => {
    assert.equal(qualifyModel('decisions', 'chitchat'), 'chitchat-decisions')
    assert.equal(qualifyModel('', 'chitchat'), 'chitchat-knowledges')
    assert.equal(qualifyModel('chitchat-decisions', 'chitchat'), 'chitchat-decisions')
  })
})

describe('resolveSettings', () => {
  test('falls back to defaults without any config', () => {
    assert.deepEqual(resolveSettings({}), {
      path: DEFAULT_SETTINGS.path,
      port: DEFAULT_SETTINGS.port,
      host: DEFAULT_SETTINGS.host,
      anchordb: null
    })
  })

  test('project config fills what CLI omits', () => {
    const settings = resolveSettings({ project: { port: '9001', path: 'x/base' } })
    assert.equal(settings.port, '9001')
    assert.equal(settings.path, 'x/base')
    assert.equal(settings.host, DEFAULT_SETTINGS.host)
    assert.equal(settings.anchordb, null)
  })

  test('explicit CLI wins over project config', () => {
    const cli = { port: '7777', path: 'cli/base', host: '0.0.0.0' }
    const project = { port: '9001', path: 'cfg/base', host: '10.0.0.1' }
    assert.deepEqual(resolveSettings({ cli, project }), {
      path: 'cli/base',
      port: '7777',
      host: '0.0.0.0',
      anchordb: null
    })
  })

  test('global config activates anchordb, model comes from project config', () => {
    const settings = resolveSettings({
      global: { anchordb: { url: 'wire://127.0.0.1:7448', token: 't1' } },
      project: { model: 'decisions' },
      projectName: 'chitchat'
    })
    assert.equal(settings.anchordb.url, 'wire://127.0.0.1:7448')
    assert.equal(settings.anchordb.model, 'chitchat-decisions')
  })

  test('without project model the default is namespaced too', () => {
    const settings = resolveSettings({
      global: { anchordb: 'wire://127.0.0.1:7448?token=t' },
      projectName: 'knlview'
    })
    assert.equal(settings.anchordb.model, 'knlview-knowledges')
  })

  test('CLI anchordb overrides global config, project model still wins', () => {
    const settings = resolveSettings({
      cli: { anchordb: 'wire://10.0.0.9:7448?model=experiment' },
      global: { anchordb: { url: 'wire://127.0.0.1:7448', token: 't1' } },
      project: { model: 'decisions' },
      projectName: 'knlview'
    })
    assert.equal(settings.anchordb.url, 'wire://10.0.0.9:7448?model=experiment')
    assert.equal(settings.anchordb.model, 'knlview-decisions')
  })

  test('invalid CLI anchordb resolves to null so the CLI can reject it', () => {
    const settings = resolveSettings({
      cli: { anchordb: 'http://not-wire' },
      global: { anchordb: { url: 'wire://127.0.0.1:7448' } }
    })
    assert.equal(settings.anchordb, null)
  })
})

describe('anchordbClientOptions', () => {
  test('splits host, port, token, and model from the URL', () => {
    const opts = anchordbClientOptions({ url: 'wire://127.0.0.1:7448?token=abc', model: 'kn' })
    assert.deepEqual(opts, { host: '127.0.0.1', port: 7448, token: 'abc', model: 'kn' })
  })

  test('resolved model wins over the URL query', () => {
    const opts = anchordbClientOptions({
      url: 'wire://127.0.0.1:7448?token=fromurl&model=fromurl',
      token: 'fromfield',
      model: 'chitchat-knowledges'
    })
    assert.equal(opts.token, 'fromfield')
    assert.equal(opts.model, 'chitchat-knowledges')
  })

  test('returns null for unusable input', () => {
    assert.equal(anchordbClientOptions(null), null)
    assert.equal(anchordbClientOptions({}), null)
  })
})
