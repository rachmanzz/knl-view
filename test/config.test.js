import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import {
  readProjectConfig,
  readGlobalConfig,
  globalConfigPath,
  knlGlobalDir,
  syncStatePath,
  normalizeModels,
  resolveModel,
  normalizeAnchordb,
  projectSlug,
  resolveSettings,
  createPathMatcher,
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
    assert.match(error, /invalid JSON/)
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

  test('normalizes include and exclude string arrays', async () => {
    const dir = makeDir({
      'knl-config.json': JSON.stringify({
        include: ['src/**', 'lib/util.js', '   '],
        exclude: 'dist'
      })
    })
    const { config } = await readProjectConfig(dir)
    assert.deepEqual(config.include, ['src/**', 'lib/util.js'])
    assert.deepEqual(config.exclude, ['dist'])
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

describe('knlGlobalDir and OS detection', () => {
  test('resolves to %APPDATA%/knlview on Windows (win32)', () => {
    const winDir = knlGlobalDir(null, {
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\Alice\\AppData\\Roaming' }
    })
    assert.equal(winDir, 'C:\\Users\\Alice\\AppData\\Roaming\\knlview')
    assert.equal(
      globalConfigPath(null, {
        platform: 'win32',
        env: { APPDATA: 'C:\\Users\\Alice\\AppData\\Roaming' }
      }),
      'C:\\Users\\Alice\\AppData\\Roaming\\knlview\\knl-config.json'
    )
  })

  test('resolves to ~/.knlview on Linux', () => {
    const linuxDir = knlGlobalDir(null, {
      platform: 'linux',
      env: { HOME: '/home/alice' }
    })
    assert.equal(linuxDir, '/home/alice/.knlview')
    assert.equal(
      globalConfigPath(null, {
        platform: 'linux',
        env: { HOME: '/home/alice' }
      }),
      '/home/alice/.knlview/knl-config.json'
    )
  })

  test('resolves to ~/.knlview on macOS (darwin)', () => {
    const macDir = knlGlobalDir(null, {
      platform: 'darwin',
      env: { HOME: '/Users/alice' }
    })
    assert.equal(macDir, '/Users/alice/.knlview')
    assert.equal(
      globalConfigPath(null, {
        platform: 'darwin',
        env: { HOME: '/Users/alice' }
      }),
      '/Users/alice/.knlview/knl-config.json'
    )
  })

  test('respects explicit home directory override across platforms', () => {
    const winOverride = knlGlobalDir('/custom/home', {
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\Alice\\AppData\\Roaming' }
    })
    assert.equal(winOverride, path.win32.join('/custom/home', '.knlview'))

    const unixOverride = knlGlobalDir('/custom/home', {
      platform: 'linux',
      env: { HOME: '/home/alice' }
    })
    assert.equal(unixOverride, path.posix.join('/custom/home', '.knlview'))
  })
})

describe('syncStatePath', () => {
  test('lives under ~/.knlview/sync-state and sanitizes the model name', () => {
    assert.equal(
      syncStatePath('knl-e2e-knowledges', '/home/u'),
      path.join('/home/u', '.knlview', 'sync-state', 'knl-e2e-knowledges.json')
    )
    assert.equal(
      syncStatePath('Weird Model/Name!', '/home/u'),
      path.join('/home/u', '.knlview', 'sync-state', 'weird-model-name.json')
    )
  })

  test('empty model falls back to a stable filename', () => {
    assert.equal(syncStatePath('', '/home/u'), path.join('/home/u', '.knlview', 'sync-state', 'model.json'))
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

  test('keeps numeric wire_port and http_port, drops invalid ones', () => {
    const a = normalizeAnchordb({ url: 'wire://127.0.0.1:17448', wire_port: 17448, http_port: 17447 })
    assert.equal(a.wire_port, 17448)
    assert.equal(a.http_port, 17447)
    const b = normalizeAnchordb({ url: 'wire://127.0.0.1:17448', wire_port: 'nope', http_port: 99999 })
    assert.equal(b.wire_port, undefined)
    assert.equal(b.http_port, undefined)
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

  test('maps the legacy "deamon" spelling to "daemon" on read', () => {
    const a = normalizeAnchordb({
      url: 'wire://127.0.0.1:7448',
      deamon: 'docker',
      container_name: 'anchordb-knlview',
      container_id: 'c-12345',
      container_created_on: '2026-10-31T10:00:00Z'
    })
    assert.equal(a.daemon, 'docker')
    assert.equal(a.deamon, undefined)
    assert.equal(a.container_name, 'anchordb-knlview')
    assert.equal(a.container_id, 'c-12345')
    assert.equal(a.container_created_on, '2026-10-31T10:00:00Z')
  })

  test('sync defaults to true', () => {
    assert.equal(normalizeAnchordb({ url: 'wire://h:1' }).sync, true)
    assert.equal(normalizeAnchordb({ url: 'wire://h:1', sync: false }).sync, false)
  })
})

describe('projectSlug', () => {
  test('slug prefers package.json name, falls back to folder name', () => {
    const withPkg = makeDir({ 'package.json': JSON.stringify({ name: '@scope/My_App' }) })
    assert.equal(projectSlug(withPkg), 'scope-my-app')
    const plain = path.join(os.tmpdir(), 'knl-config-slug-proj')
    fs.rmSync(plain, { recursive: true, force: true })
    fs.mkdirSync(plain, { recursive: true })
    assert.equal(projectSlug(plain), 'knl-config-slug-proj')
  })
})

describe('normalizeModels and resolveModel', () => {
  test('map of role to model name is kept, invalid entries dropped', () => {
    const models = normalizeModels({
      knowledges: 'vx42k9',
      consensus: 'm8qz1d',
      'Bad Role': 'x',
      broken: 'has space',
      '': 'whatever'
    })
    assert.deepEqual(models, { knowledges: 'vx42k9', consensus: 'm8qz1d' })
  })

  test('resolveModel returns the mapped name verbatim, null when unmapped', () => {
    const models = { knowledges: 'vx42k9' }
    assert.equal(resolveModel(models, 'knowledges'), 'vx42k9')
    assert.equal(resolveModel(models, 'consensus'), null)
    assert.equal(resolveModel(null, 'knowledges'), null)
    // Names are never transformed: that is why names stay stable even when
    // the project/folder is renamed.
  })

  test('project config accepts models map and legacy single model', async () => {
    const dir = makeDir({
      'knl-config.json': JSON.stringify({ models: { knowledges: 'vx42k9' }, model: 'old-way' })
    })
    const { config } = await readProjectConfig(dir)
    assert.deepEqual(config.models, { knowledges: 'vx42k9' })
    assert.equal(config.model, 'old-way')
  })
})

describe('resolveSettings', () => {
  test('falls back to defaults without any config', () => {
    assert.deepEqual(resolveSettings({}), {
      path: DEFAULT_SETTINGS.path,
      port: DEFAULT_SETTINGS.port,
      host: DEFAULT_SETTINGS.host,
      models: null,
      labelDir: null,
      include: null,
      exclude: null,
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
      models: null,
      labelDir: null,
      include: null,
      exclude: null,
      anchordb: null
    })
  })

  test('global config activates anchordb, model comes from the project map', () => {
    const settings = resolveSettings({
      global: { anchordb: { url: 'wire://127.0.0.1:7448', token: 't1' } },
      project: { models: { knowledges: 'vx42k9' } }
    })
    assert.equal(settings.anchordb.url, 'wire://127.0.0.1:7448')
    assert.equal(settings.anchordb.model, 'vx42k9')
    assert.deepEqual(settings.models, { knowledges: 'vx42k9' })
  })

  test('without a map entry the model stays unresolved (no silent default)', () => {
    const settings = resolveSettings({
      global: { anchordb: 'wire://127.0.0.1:7448?token=t' }
    })
    assert.equal(settings.anchordb.model, null)
    assert.equal(settings.models, null)
  })

  test('legacy single model field acts as models.knowledges', () => {
    const settings = resolveSettings({
      global: { anchordb: { url: 'wire://127.0.0.1:7448' } },
      project: { model: 'old-way' }
    })
    assert.equal(settings.anchordb.model, 'old-way')
    assert.deepEqual(settings.models, { knowledges: 'old-way' })
  })

  test('CLI anchordb overrides global config, project map still wins for the model', () => {
    const settings = resolveSettings({
      cli: { anchordb: 'wire://10.0.0.9:7448?model=fromurl' },
      global: { anchordb: { url: 'wire://127.0.0.1:7448', token: 't1' } },
      project: { models: { knowledges: 'vx42k9' } }
    })
    assert.equal(settings.anchordb.url, 'wire://10.0.0.9:7448?model=fromurl')
    // The map wins over ?model= in the URL: the model name belongs to the project, not the session.
    assert.equal(settings.anchordb.model, 'vx42k9')
  })

  test('invalid CLI anchordb resolves to null so the CLI can reject it', () => {
    const settings = resolveSettings({
      cli: { anchordb: 'http://not-wire' },
      global: { anchordb: { url: 'wire://127.0.0.1:7448' } }
    })
    assert.equal(settings.anchordb, null)
  })

  test('resolveSettings includes project include and exclude', () => {
    const settings = resolveSettings({
      project: { include: ['src/**'], exclude: ['dist'] }
    })
    assert.deepEqual(settings.include, ['src/**'])
    assert.deepEqual(settings.exclude, ['dist'])
  })
})

describe('createPathMatcher', () => {
  test('matches exact file and folder prefixes', () => {
    const matcher = createPathMatcher(['vendor', 'src/legacy.js'])
    assert.equal(matcher.matches('vendor'), true)
    assert.equal(matcher.matches('vendor/lib.js'), true)
    assert.equal(matcher.matches('src/legacy.js'), true)
    assert.equal(matcher.matches('src/other.js'), false)
  })

  test('matches wildcards and globstars', () => {
    const matcher = createPathMatcher(['*.test.js', 'dist/**'])
    assert.equal(matcher.matches('app.test.js'), true)
    assert.equal(matcher.matches('src/app.test.js'), true)
    assert.equal(matcher.matches('dist/bundle.js'), true)
    assert.equal(matcher.matches('dist/sub/chunk.js'), true)
    assert.equal(matcher.matches('src/app.js'), false)
  })

  test('isPrefixOfAny checks if path is ancestor of an include pattern', () => {
    const matcher = createPathMatcher(['node_modules/my-pkg/**'])
    assert.equal(matcher.isPrefixOfAny('node_modules'), true)
    assert.equal(matcher.isPrefixOfAny('src'), false)
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
