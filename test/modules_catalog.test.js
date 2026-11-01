import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import {
  modulesCatalogDir,
  defaultEcosystemModel,
  formatModuleKey,
  formatExternalPackageNodeId,
  formatExternalSymbolNodeId,
  readModulesCatalog,
  updateModulesCatalog,
  isModuleSynced,
  detectProjectManifests,
  resolveModuleLocation,
  isValidModuleName,
  SUPPORTED_ECOSYSTEMS
} from '../server/graph/modules_catalog.js'

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'knl-catalog-test-'))
}

describe('modulesCatalogDir and formatters', () => {
  test('resolves under global home dir', () => {
    const dir = modulesCatalogDir('/custom/home')
    assert.equal(dir, path.join('/custom/home', '.knlview', 'modules'))
  })

  test('defaultEcosystemModel prefixes modules-', () => {
    assert.equal(defaultEcosystemModel('npm'), 'modules-npm')
    assert.equal(defaultEcosystemModel('cargo'), 'modules-cargo')
    assert.equal(defaultEcosystemModel('go'), 'modules-go')
    assert.equal(defaultEcosystemModel('pypi'), 'modules-pypi')
    assert.deepEqual([...SUPPORTED_ECOSYSTEMS].sort(), ['cargo', 'go', 'npm', 'pypi'])
  })

  test('formatters construct standard ids', () => {
    assert.equal(formatModuleKey('express', '4.19.2'), 'express@4.19.2')
    assert.equal(formatExternalPackageNodeId('npm', 'express', '4.19.2'), 'ext:npm/express@4.19.2')
    assert.equal(formatExternalSymbolNodeId('npm', 'express', '4.19.2', 'Router'), 'ext:npm/express@4.19.2#Router')
  })
})

describe('catalog read and update', () => {
  test('read empty catalog when file is missing', async () => {
    const home = makeTempDir()
    try {
      const res = await readModulesCatalog('npm', { home })
      assert.deepEqual(res, {})
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  test('updateModulesCatalog records modules and records symbolCount', async () => {
    const home = makeTempDir()
    try {
      await updateModulesCatalog('npm', {
        'express@4.19.2': {
          name: 'express',
          version: '4.19.2',
          symbols: ['Router', 'json']
        }
      }, { home })

      const first = await readModulesCatalog('npm', { home })
      assert.ok(first['express@4.19.2'])
      assert.equal(first['express@4.19.2'].name, 'express')
      assert.equal(first['express@4.19.2'].version, '4.19.2')
      assert.equal(first['express@4.19.2'].model, 'modules-npm')
      assert.equal(first['express@4.19.2'].nodeId, 'ext:npm/express@4.19.2')
      assert.equal(first['express@4.19.2'].symbolCount, 2)
      assert.ok(typeof first['express@4.19.2'].syncedAt === 'number')

      assert.equal(await isModuleSynced('npm', 'express', '4.19.2', { home }), true)
      assert.equal(await isModuleSynced('npm', 'express', '5.0.0', { home }), false)

      // Update symbol count
      await updateModulesCatalog('npm', {
        'express@4.19.2': {
          name: 'express',
          version: '4.19.2',
          symbolCount: 5
        }
      }, { home })

      const second = await readModulesCatalog('npm', { home })
      assert.equal(second['express@4.19.2'].symbolCount, 5)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('detectProjectManifests', () => {
  test('detects npm, go, cargo, and python manifests', async () => {
    const root = makeTempDir()
    try {
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
        dependencies: { express: '^4.19.2' },
        devDependencies: { typescript: '~5.4.0' }
      }))
      fs.writeFileSync(path.join(root, 'go.mod'), [
        'module example.com/app',
        '',
        'go 1.22',
        '',
        'require github.com/gin-gonic/gin v1.9.1',
        '',
        'require (',
        '\tgithub.com/google/uuid v1.6.0',
        ')'
      ].join('\n'))
      fs.writeFileSync(path.join(root, 'Cargo.toml'), [
        '[package]',
        'name = "demo"',
        'version = "0.1.0"',
        '',
        '[dependencies]',
        'tokio = "1.38.0"',
        'serde = { version = "1.0.200", features = ["derive"] }'
      ].join('\n'))
      fs.writeFileSync(path.join(root, 'requirements.txt'), [
        'pydantic==2.7.0',
        'fastapi>=0.110.0',
        '# a comment',
        'requests'
      ].join('\n'))

      const manifests = await detectProjectManifests(root)
      assert.equal(manifests.npm.express, '4.19.2')
      assert.equal(manifests.npm.typescript, '5.4.0')
      assert.equal(manifests.go['github.com/gin-gonic/gin'], 'v1.9.1')
      assert.equal(manifests.go['github.com/google/uuid'], 'v1.6.0')
      assert.equal(manifests.cargo.tokio, '1.38.0')
      assert.equal(manifests.cargo.serde, '1.0.200')
      assert.equal(manifests.pypi.pydantic, '2.7.0')
      assert.equal(manifests.pypi.fastapi, '0.110.0')
      assert.equal(manifests.pypi.requests, 'unknown')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('handles missing manifests gracefully', async () => {
    const root = makeTempDir()
    try {
      const manifests = await detectProjectManifests(root)
      assert.deepEqual(manifests, { npm: {}, go: {}, cargo: {}, pypi: {} })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('resolveModuleLocation', () => {
  test('resolves npm module in node_modules with package.json version', async () => {
    const root = makeTempDir()
    try {
      const modDir = path.join(root, 'node_modules', 'express')
      fs.mkdirSync(modDir, { recursive: true })
      fs.writeFileSync(path.join(modDir, 'package.json'), JSON.stringify({
        name: 'express',
        version: '4.19.2'
      }))

      const resolved = await resolveModuleLocation('npm', 'express', { projectRoot: root })
      assert.ok(resolved)
      assert.equal(resolved.name, 'express')
      assert.equal(resolved.version, '4.19.2')
      assert.equal(resolved.location, modDir)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('resolves go module in vendor', async () => {
    const root = makeTempDir()
    try {
      const modDir = path.join(root, 'vendor', 'github.com/gin-gonic/gin')
      fs.mkdirSync(modDir, { recursive: true })
      fs.writeFileSync(path.join(root, 'go.mod'), 'module app\nrequire github.com/gin-gonic/gin v1.9.1\n')

      const resolved = await resolveModuleLocation('go', 'github.com/gin-gonic/gin', { projectRoot: root })
      assert.ok(resolved)
      assert.equal(resolved.name, 'github.com/gin-gonic/gin')
      assert.equal(resolved.version, 'v1.9.1')
      assert.equal(resolved.location, modDir)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('returns null when module cannot be found', async () => {
    const root = makeTempDir()
    try {
      const resolved = await resolveModuleLocation('npm', 'non-existent', { projectRoot: root })
      assert.equal(resolved, null)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('security: rejects path traversal and invalid module names', async () => {
    assert.equal(isValidModuleName('../secret'), false)
    assert.equal(isValidModuleName('../../etc/passwd'), false)
    assert.equal(isValidModuleName('pkg/../../../etc'), false)
    assert.equal(isValidModuleName('bad\0name'), false)
    assert.equal(isValidModuleName('/absolute/path'), false)
    assert.equal(isValidModuleName('.'), false)
    assert.equal(isValidModuleName('..'), false)
    assert.equal(isValidModuleName('express'), true)
    assert.equal(isValidModuleName('@scope/pkg'), true)
    assert.equal(isValidModuleName('github.com/gin-gonic/gin'), true)

    const root = makeTempDir()
    try {
      // Path traversal should return null immediately
      const resolved = await resolveModuleLocation('npm', '../../../../etc', { projectRoot: root })
      assert.equal(resolved, null)

      // Unsupported ecosystem returns null
      const unsupp = await resolveModuleLocation('malicious', 'express', { projectRoot: root })
      assert.equal(unsupp, null)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('security: readModulesCatalog rejects unsupported ecosystem', async () => {
    const res = await readModulesCatalog('../knl-config')
    assert.deepEqual(res, {})
    assert.throws(() => defaultEcosystemModel('invalid_eco'), /Unsupported ecosystem/)
  })
})
