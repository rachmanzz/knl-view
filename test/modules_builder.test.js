import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import {
  parseModuleSpecifier,
  scanModuleFiles,
  buildModuleGraph,
  syncModuleToAnchorDB,
  traceModuleSymbol
} from '../server/graph/modules_builder.js'
import { readModulesCatalog, isModuleSynced } from '../server/graph/modules_catalog.js'

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'knl-builder-test-'))
}

describe('parseModuleSpecifier', () => {
  test('parses ecosystem and module name', () => {
    assert.deepEqual(parseModuleSpecifier('npm::express'), {
      ecosystem: 'npm',
      moduleName: 'express'
    })
    assert.deepEqual(parseModuleSpecifier('npm::@nestjs/core'), {
      ecosystem: 'npm',
      moduleName: '@nestjs/core'
    })
    assert.deepEqual(parseModuleSpecifier('go::github.com/gin-gonic/gin'), {
      ecosystem: 'go',
      moduleName: 'github.com/gin-gonic/gin'
    })
    assert.deepEqual(parseModuleSpecifier('cargo::tokio'), {
      ecosystem: 'cargo',
      moduleName: 'tokio'
    })
    assert.deepEqual(parseModuleSpecifier('pypi::fastapi'), {
      ecosystem: 'pypi',
      moduleName: 'fastapi'
    })
  })

  test('returns null for invalid inputs', () => {
    assert.equal(parseModuleSpecifier(''), null)
    assert.equal(parseModuleSpecifier('express'), null)
    assert.equal(parseModuleSpecifier('::express'), null)
    assert.equal(parseModuleSpecifier('npm::'), null)
    assert.equal(parseModuleSpecifier(null), null)
  })
})

describe('scanModuleFiles', () => {
  test('scans source files and ignores tests/docs/node_modules', async () => {
    const dir = makeTempDir()
    try {
      fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
      fs.mkdirSync(path.join(dir, 'test'), { recursive: true })
      fs.mkdirSync(path.join(dir, 'node_modules', 'sub'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = {}')
      fs.writeFileSync(path.join(dir, 'lib', 'router.js'), 'export function Router() {}')
      fs.writeFileSync(path.join(dir, 'test', 'router.test.js'), 'test()')
      fs.writeFileSync(path.join(dir, 'node_modules', 'sub', 'a.js'), '')

      const files = await scanModuleFiles(dir, 'npm')
      assert.ok(files['index.js'])
      assert.ok(files['lib/router.js'])
      assert.equal(files['test/router.test.js'], undefined)
      assert.equal(files['node_modules/sub/a.js'], undefined)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('buildModuleGraph and syncModuleToAnchorDB', () => {
  test('builds graph and syncs to AnchorDB model', async () => {
    const dir = makeTempDir()
    const home = makeTempDir()
    try {
      fs.writeFileSync(path.join(dir, 'index.js'), [
        'export function start() { helper(); }',
        'export function helper() { return 42; }'
      ].join('\n'))

      const graph = await buildModuleGraph('npm', 'my-pkg', {
        location: dir,
        version: '1.2.3'
      })

      assert.equal(graph.name, 'my-pkg')
      assert.equal(graph.version, '1.2.3')
      assert.equal(graph.ecosystem, 'npm')
      assert.equal(graph.model, 'modules-npm')
      assert.equal(graph.moduleNode.id, 'ext:npm/my-pkg@1.2.3')
      assert.deepEqual(graph.symbols, ['helper', 'start'])

      const defines = graph.edges.filter((e) => e.type === 'defines')
      assert.equal(defines.length, 2)
      const calls = graph.edges.filter((e) => e.type === 'calls')
      assert.equal(calls.length, 1)
      assert.equal(calls[0].from, 'ext:npm/my-pkg@1.2.3#start')
      assert.equal(calls[0].to, 'ext:npm/my-pkg@1.2.3#helper')

      // Mock client
      const linked = []
      const saved = []
      const mockClient = {
        async link(from, type, to, weight) {
          linked.push({ from, type, to, weight })
        },
        async saveWithID(name, props) {
          saved.push({ name, props })
        }
      }

      const syncResult = await syncModuleToAnchorDB(mockClient, graph, { home })
      assert.equal(syncResult.symbols, 2)
      assert.equal(syncResult.model, 'modules-npm')
      assert.ok(syncResult.linked > 0)
      assert.ok(syncResult.saved > 0)

      // Verify recorded in catalog
      const synced = await isModuleSynced('npm', 'my-pkg', '1.2.3', { home })
      assert.equal(synced, true)

      const catalog = await readModulesCatalog('npm', { home })
      assert.ok(catalog['my-pkg@1.2.3'])
      assert.equal(catalog['my-pkg@1.2.3'].symbolCount, 2)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('traceModuleSymbol', () => {
  test('traces hops in module model via client causalChain', async () => {
    const mockClient = {
      async causalChain([seed], rel) {
        if (seed === 'ext:npm/my-pkg@1.2.3#start' && rel === 'calls') {
          return [{ word: 'ext:npm/my-pkg@1.2.3#helper', score: 1 }]
        }
        return []
      }
    }

    const res = await traceModuleSymbol(mockClient, 'ext:npm/my-pkg@1.2.3#start', {
      direction: 'out',
      maxHops: 2
    })
    assert.deepEqual(res, [
      { id: 'ext:npm/my-pkg@1.2.3#helper', hop: 1 }
    ])
  })
})
