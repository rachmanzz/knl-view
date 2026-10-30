import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import {
  scanSourceFiles,
  resolveImportSpecifier,
  resolveJsSpecifiers,
  resolveGoSpecifiers,
  goModulePath,
  resolveCallTargets,
  buildSourcesGraph,
  desiredSourceEdgeKeys,
  labelContent,
  writeLabelFiles,
  syncSourcesToAnchorDB,
  traceSources,
  collectorHttpUrl,
  purgeArchivedRecords,
  SOURCE_RELATIONS,
  SYMBOL_RELATIONS
} from '../server/graph/sources.js'
import { extractCode } from '../server/graph/syntax.js'
import { edgeKey } from '../server/graph/anchordb_client.js'

function makeRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'knl-sources-'))
}

function write(root, rel, content) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf8')
}

describe('scanSourceFiles', () => {
  test('collects files, skips dot folders except .github', async () => {
    const root = makeRepo()
    write(root, 'bin/cli.js', '')
    write(root, 'server/index.js', '')
    write(root, '.github/workflows/ci.yml', '')
    write(root, '.agents/skills/x.md', '')
    write(root, '.git/config', '')
    const files = await scanSourceFiles(root)
    assert.ok(files['bin/cli.js'])
    assert.ok(files['.github/workflows/ci.yml'])
    assert.equal(files['.agents/skills/x.md'], undefined)
    assert.equal(files['.git/config'], undefined)
  })

  test('default ignores and .gitignore patterns are honored', async () => {
    const root = makeRepo()
    write(root, 'dist/bundle.js', '')
    write(root, 'node_modules/pkg/index.js', '')
    write(root, 'src/keep.js', '')
    write(root, 'src/skip.log', '')
    write(root, '.gitignore', '*.log\n')
    const files = await scanSourceFiles(root)
    assert.ok(files['src/keep.js'])
    assert.equal(files['dist/bundle.js'], undefined)
    assert.equal(files['node_modules/pkg/index.js'], undefined)
    assert.equal(files['src/skip.log'], undefined)
  })

  test('file attributes are numeric (KB size, day mtime)', async () => {
    const root = makeRepo()
    write(root, 'a.js', 'x'.repeat(4096))
    const files = await scanSourceFiles(root)
    assert.equal(files['a.js'].size, 4)
    assert.ok(Number.isInteger(files['a.js'].mtime))
  })
})

describe('extractCode (tree-sitter)', () => {
  test('JS: ESM, dynamic, and CJS specifiers, raw and unfiltered', async () => {
    const code = [
      "import x from './a.js'",
      "import { b } from '../lib/b.js'",
      "import './side-effect.js'",
      "export { c } from './c.js'",
      "const d = await import('./d.js')",
      "const e = require('./e.js')",
      "import fs from 'node:fs'",
      "import pkg from '@scope/pkg'",
      "const url = import('https://example.com/x.js')"
    ].join('\n')
    const { imports } = await extractCode('.js', code)
    assert.deepEqual(imports.sort(), [
      '../lib/b.js', './a.js', './c.js', './d.js', './e.js',
      './side-effect.js', '@scope/pkg', 'https://example.com/x.js', 'node:fs'
    ])
  })

  test('JS: comments and strings do not produce phantom imports', async () => {
    const code = [
      '// import x from "./fake.js"',
      "const s = \"import y from './also-fake.js'\"",
      "import real from './real.js'"
    ].join('\n')
    const { imports } = await extractCode('.js', code)
    assert.deepEqual(imports, ['./real.js'])
  })

  test('Go: every import_spec path, aliased or not', async () => {
    const code = [
      'package main',
      'import "fmt"',
      'import (',
      '\tq "github.com/acme/app/internal/queue"',
      '\t_ "github.com/acme/app/internal/boot"',
      ')'
    ].join('\n')
    const { imports } = await extractCode('.go', code)
    assert.deepEqual(imports.sort(), [
      'fmt', 'github.com/acme/app/internal/boot', 'github.com/acme/app/internal/queue'
    ])
  })

  test('importNames: JS bindings and Go aliases', async () => {
    const js = [
      "import s from './a.js'",
      "import * as ns from './b.js'",
      "import { one as uno } from './c.js'",
      "const d = require('./d.js')"
    ].join('\n')
    const { importNames } = await extractCode('.js', js)
    assert.deepEqual(importNames.sort(), ['d', 'ns', 's', 'uno'])

    const go = 'package main\nimport (\n\tq "path/queue"\n\t"fmt"\n)\n'
    const { importNames: goNames } = await extractCode('.go', go)
    assert.deepEqual(goNames.sort(), ['fmt', 'q'])
  })

  test('JS: named functions, classes, methods, and const functions', async () => {
    const code = [
      'export function alpha() {}',
      'async function beta() {}',
      'const gamma = () => {}',
      'const delta = async () => {}',
      'const plain = 4',
      'class Widget {',
      '  spin() {}',
      '  ["computed"]() {}',
      '}'
    ].join('\n')
    const { symbols } = await extractCode('.js', code)
    const byName = Object.fromEntries(symbols.map((s) => [s.name, s]))
    assert.deepEqual(Object.keys(byName).sort(), ['Widget', 'Widget.spin', 'alpha', 'beta', 'delta', 'gamma'])
    assert.equal(byName.alpha.kind, 'function')
    assert.equal(byName.Widget.kind, 'class')
    assert.equal(byName['Widget.spin'].kind, 'method')
    assert.ok(byName.Widget.lines >= 3)
    assert.ok(byName.alpha.line < byName.Widget.line)
  })

  test('Go: functions, receiver methods, and type declarations', async () => {
    const code = [
      'package queue',
      '',
      'type Queue struct {',
      '\tn int',
      '}',
      '',
      'func (q *Queue) Run() string {',
      '\treturn help()',
      '}',
      '',
      'func help() string { return "ok" }'
    ].join('\n')
    const { symbols } = await extractCode('.go', code)
    const byName = Object.fromEntries(symbols.map((s) => [s.name, s]))
    assert.deepEqual(Object.keys(byName).sort(), ['Queue', 'Queue.Run', 'help'])
    assert.equal(byName.Queue.kind, 'type')
    assert.equal(byName['Queue.Run'].kind, 'method')
    assert.equal(byName.help.kind, 'function')
  })

  test('calls are captured with position, receiver included', async () => {
    const code = [
      'function main() {',
      '  boot()',
      '  mod.start()',
      '  new Widget()',
      '}',
      'boot()'
    ].join('\n')
    const { calls } = await extractCode('.js', code)
    const inside = calls.filter((c) => c.row === 1)
    assert.deepEqual(inside.map((c) => `${c.recv || ''}.${c.name}`), ['.boot'])
    const qualified = calls.find((c) => c.row === 2)
    assert.equal(qualified.name, 'start')
    assert.equal(qualified.recv, 'mod')
    const constructed = calls.find((c) => c.row === 3)
    assert.equal(constructed.name, 'Widget')
    const outside = calls.find((c) => c.row === 5)
    assert.equal(outside.recv, null)
  })

  test('Go calls: identifier and package-qualified', async () => {
    const code = [
      'package queue',
      'func Run() {',
      '\thelp()',
      '\tlog.Print("x")',
      '}'
    ].join('\n')
    const { calls } = await extractCode('.go', code)
    const plain = calls.find((c) => c.name === 'help')
    assert.equal(plain.recv, null)
    const qualified = calls.find((c) => c.name === 'Print')
    assert.equal(qualified.recv, 'log')
  })

  test('a syntax error never throws; well-formed imports still come out', async () => {
    const code = "import a from './a.js'\nfunction broken( { no close\n"
    const { imports } = await extractCode('.js', code)
    assert.deepEqual(imports, ['./a.js'])
  })
})

describe('resolveJsSpecifiers', () => {
  const files = {
    'src/a.js': {},
    'src/lib/b.js': {},
    'src/lib/c/index.js': {}
  }

  test('keeps only specifiers that resolve to scanned files', () => {
    assert.deepEqual(
      resolveJsSpecifiers('src/main.js', ['./a.js', './missing.js', 'node:fs'], files),
      ['src/a.js']
    )
    assert.deepEqual(
      resolveJsSpecifiers('src/x.js', ['./lib/c'], files),
      ['src/lib/c/index.js']
    )
  })
})

describe('goModulePath and resolveGoSpecifiers', () => {
  test('module path comes from go.mod', async () => {
    const root = makeRepo()
    fs.writeFileSync(path.join(root, 'go.mod'), 'module github.com/acme/app\n\ngo 1.22\n', 'utf8')
    assert.equal(await goModulePath(root), 'github.com/acme/app')
    assert.equal(await goModulePath(makeRepo()), null)
  })

  const files = {
    'main.go': {},
    'cmd/serve/main.go': {},
    'internal/queue/queue.go': {},
    'internal/queue/helper.go': {},
    'internal/queue/README.md': {},
    'vendor/github.com/other/x.go': {}
  }

  test('module-internal imports resolve to the package directory files', () => {
    assert.deepEqual(
      resolveGoSpecifiers('github.com/acme/app/internal/queue', 'github.com/acme/app', files).sort(),
      ['internal/queue/helper.go', 'internal/queue/queue.go']
    )
    assert.deepEqual(
      resolveGoSpecifiers('github.com/acme/app', 'github.com/acme/app', files),
      ['main.go']
    )
  })

  test('external and stdlib imports resolve to nothing', () => {
    assert.deepEqual(resolveGoSpecifiers('fmt', 'github.com/acme/app', files), [])
    assert.deepEqual(resolveGoSpecifiers('github.com/other/x', 'github.com/acme/app', files), [])
  })

  test('no go.mod means no local resolution at all', () => {
    assert.deepEqual(resolveGoSpecifiers('github.com/acme/app/internal/queue', null, files), [])
  })
})

describe('resolveImportSpecifier', () => {
  const files = {
    'src/a.js': {},
    'src/lib/b.js': {},
    'src/lib/c/index.js': {}
  }

  test('exact, extension, and index resolution relative to the importer', () => {
    assert.equal(resolveImportSpecifier('src/main.js', './a.js', files), 'src/a.js')
    assert.equal(resolveImportSpecifier('src/main.js', './a', files), 'src/a.js')
    assert.equal(resolveImportSpecifier('src/x.js', './lib/b.js', files), 'src/lib/b.js')
    assert.equal(resolveImportSpecifier('src/x.js', './lib/c', files), 'src/lib/c/index.js')
    assert.equal(resolveImportSpecifier('src/x.js', '../other/missing.js', files), null)
  })
})

describe('buildSourcesGraph', () => {
  test('nodes for all files, imports edges for relative JS imports', async () => {
    const root = makeRepo()
    write(root, 'bin/cli.js', "import '../server/index.js'\n")
    write(root, 'server/index.js', "import './graph/parser.js'\n")
    write(root, 'server/graph/parser.js', "import './model.js'\nimport fs from 'node:fs'\n")
    write(root, 'server/graph/model.js', '')
    write(root, 'README.md', '# knl-view\n')

    const { nodes, edges } = await buildSourcesGraph(root)
    const ids = nodes.map((n) => n.id).sort()
    assert.deepEqual(ids, ['README.md', 'bin/cli.js', 'server/graph/model.js', 'server/graph/parser.js', 'server/index.js'])
    const pairs = edges.map((e) => `${e.from}->${e.to}`).sort()
    assert.deepEqual(pairs, [
      'bin/cli.js->server/index.js',
      'server/graph/parser.js->server/graph/model.js',
      'server/index.js->server/graph/parser.js'
    ])
  })
  test('Go repo: module-internal imports become edges, external do not', async () => {
    const root = makeRepo()
    fs.writeFileSync(path.join(root, 'go.mod'), 'module github.com/acme/app\n\ngo 1.22\n', 'utf8')
    write(root, 'main.go', 'package main\n\nimport (\n\t"fmt"\n\t"github.com/acme/app/internal/queue"\n)\n\nfunc main() { queue.Run() }\n')
    write(root, 'internal/queue/queue.go', 'package queue\n\nimport "fmt"\n\nfunc Run() { fmt.Println("q") }\n')
    write(root, 'internal/queue/helper.go', 'package queue\n\nfunc help() {}\n')
    write(root, 'README.md', '# app\n')

    const { nodes, edges } = await buildSourcesGraph(root)
    const pairs = edges.map((e) => `${e.from}->${e.to}:${e.type}`).sort()
    assert.deepEqual(pairs, [
      'internal/queue/helper.go->internal/queue/helper.go#help:defines',
      'internal/queue/queue.go->internal/queue/queue.go#Run:defines',
      'main.go#main->internal/queue/queue.go#Run:calls',
      'main.go->internal/queue/helper.go:imports',
      'main.go->internal/queue/queue.go:imports',
      'main.go->main.go#main:defines'
    ])
    assert.equal(nodes.length, 8) // 5 files (incl. go.mod) + 3 defined symbols
  })
})

describe('desiredSourceEdgeKeys', () => {
  test('stores both directions so inbound queries walk forward too', () => {
    const keys = desiredSourceEdgeKeys([{ from: 'a.js', to: 'b.js' }])
    assert.ok(keys.has(edgeKey('a.js', 'imports', 'b.js')))
    assert.ok(keys.has(edgeKey('b.js', 'imported_by', 'a.js')))
    assert.equal(keys.size, 2)
  })
})

describe('syncSourcesToAnchorDB', () => {
  // Stateful fake client: links, records, and walks mutate one shared
  // state, so several syncs run against the same "server" like in real use.
  function statefulClient() {
    const records = new Map()
    const operations = new Map()
    const edges = new Map()
    const ops = { linked: [], unlinked: [], saved: [], batches: [] }
    return {
      ops,
      records,
      operations,
      edges,
      async list() {
        const items = [...records]
          .filter(([name]) => operations.get(name) !== 2)
          .map(([name, props]) => ({ name, props }))
        return { totalCount: items.length, hasMore: false, items }
      },
      async causalChain([seed], relation) {
        return (edges.get(`${seed}\u0000${relation}`) || []).map((word) => ({ word }))
      },
      async link(from, type, to) {
        const key = `${from}\u0000${type}`
        edges.set(key, [...(edges.get(key) || []), to])
        ops.linked.push(`${from}\u0000${type}\u0000${to}`)
      },
      async unlink(from, type, to) {
        const key = `${from}\u0000${type}`
        edges.set(key, (edges.get(key) || []).filter((word) => word !== to))
        ops.unlinked.push(`${from}\u0000${type}\u0000${to}`)
      },
      async saveWithID(name, props) {
        records.set(name, props)
        operations.set(name, 1)
        ops.saved.push(name)
      },
      async saveBatch(items) {
        for (const item of items) {
          records.set(item.name, item.props)
          operations.set(item.name, item.operation ?? 1)
          ops.saved.push(item.name)
        }
        ops.batches.push(items.length)
      }
    }
  }

  test('first sync links both directions and saves every record', async () => {
    const root = makeRepo()
    write(root, 'a.js', "import './b.js'\n")
    write(root, 'b.js', '')
    const client = statefulClient()
    const result = await syncSourcesToAnchorDB(client, root)

    assert.deepEqual(result, {
      linked: 2, unlinked: 0, saved: 2, tombstoned: 0, failed: 0, orphans: 0,
      files: 2, symbols: 0, edges: 1, labels: { written: 0, deleted: 0 }
    })
    assert.ok(client.ops.linked.includes('a.js\u0000imports\u0000b.js'))
    assert.ok(client.ops.linked.includes('b.js\u0000imported_by\u0000a.js'))
  })

  test('second sync with unchanged disk does nothing', async () => {
    const root = makeRepo()
    write(root, 'a.js', "import './b.js'\n")
    write(root, 'b.js', '')
    const client = statefulClient()
    await syncSourcesToAnchorDB(client, root)
    const before = client.ops.linked.length + client.ops.unlinked.length + client.ops.saved.length
    const second = await syncSourcesToAnchorDB(client, root)

    assert.deepEqual(
      { linked: second.linked, unlinked: second.unlinked, saved: second.saved, failed: second.failed },
      { linked: 0, unlinked: 0, saved: 0, failed: 0 }
    )
    assert.equal(client.ops.linked.length + client.ops.unlinked.length + client.ops.saved.length, before)
  })

  test('a new import is picked up on the next sync', async () => {
    const root = makeRepo()
    write(root, 'a.js', "import './b.js'\n")
    write(root, 'b.js', '')
    const client = statefulClient()
    await syncSourcesToAnchorDB(client, root)

    write(root, 'b.js', "import './c.js'\n")
    write(root, 'c.js', '')
    const second = await syncSourcesToAnchorDB(client, root)
    assert.equal(second.linked, 2)
    assert.ok(client.ops.linked.includes('b.js\u0000imports\u0000c.js'))
    assert.ok(client.ops.linked.includes('c.js\u0000imported_by\u0000b.js'))
  })

  test('a removed file loses its edges and is tombstoned', async () => {
    const root = makeRepo()
    write(root, 'a.js', "import './b.js'\n")
    write(root, 'b.js', '')
    const client = statefulClient()
    await syncSourcesToAnchorDB(client, root)

    fs.rmSync(path.join(root, 'b.js'))
    const second = await syncSourcesToAnchorDB(client, root)
    assert.equal(second.unlinked, 2)
    assert.equal(second.tombstoned, 1)
    assert.ok(client.ops.unlinked.includes('a.js\u0000imports\u0000b.js'))
    assert.ok(client.ops.unlinked.includes('b.js\u0000imported_by\u0000a.js'))
    // Archived, not deleted: hidden from list and lookups.
    assert.equal(client.records.get('b.js').tombstone, 2)
    assert.equal(client.operations.get('b.js'), 2)
    const listed = await client.list({ limit: 100, offset: 0 })
    assert.deepEqual(listed.items.map((item) => item.name), ['a.js'])
  })

  test('a tombstoned record is invisible to the next sync', async () => {
    const root = makeRepo()
    write(root, 'a.js', "import './b.js'\n")
    write(root, 'b.js', '')
    const client = statefulClient()
    await syncSourcesToAnchorDB(client, root)
    fs.rmSync(path.join(root, 'b.js'))
    await syncSourcesToAnchorDB(client, root)
    const savesBefore = client.ops.saved.length

    const third = await syncSourcesToAnchorDB(client, root)
    assert.deepEqual(
      { linked: third.linked, unlinked: third.unlinked, saved: third.saved, tombstoned: third.tombstoned },
      { linked: 0, unlinked: 0, saved: 0, tombstoned: 0 }
    )
    assert.equal(client.ops.saved.length, savesBefore)
  })

  test('a reappearing file lifts the tombstone and relinks its edges', async () => {
    const root = makeRepo()
    write(root, 'a.js', "import './b.js'\n")
    write(root, 'b.js', '')
    const client = statefulClient()
    await syncSourcesToAnchorDB(client, root)
    fs.rmSync(path.join(root, 'b.js'))
    await syncSourcesToAnchorDB(client, root)

    write(root, 'b.js', '')
    const back = await syncSourcesToAnchorDB(client, root)
    assert.equal(back.linked, 2)
    assert.equal(back.saved, 1)
    const props = client.records.get('b.js')
    assert.equal(props.tombstone, 0)
    assert.ok(Number.isInteger(props.size) && Number.isInteger(props.mtime))
    // Revival is a normal save: back to the active opcode and visible again.
    assert.equal(client.operations.get('b.js'), 1)
    const listed = await client.list({ limit: 100, offset: 0 })
    assert.ok(listed.items.some((item) => item.name === 'b.js'))
  })

  test('a legacy attribute-only tombstone migrates to the native opcode', async () => {
    const root = makeRepo()
    write(root, 'a.js', '')
    const client = statefulClient()
    // A record written by an older knl-view: tombstone attribute, no opcode.
    client.records.set('b.js', { tombstone: 2 })

    const result = await syncSourcesToAnchorDB(client, root)
    assert.equal(result.tombstoned, 1)
    assert.equal(client.operations.get('b.js'), 2)
    const listed = await client.list({ limit: 100, offset: 0 })
    assert.ok(!listed.items.some((item) => item.name === 'b.js'))
  })

  test('pending records go through saveBatch in one transactional call', async () => {
    const root = makeRepo()
    write(root, 'a.js', "import './b.js'\n")
    write(root, 'b.js', '')
    const client = statefulClient()

    const result = await syncSourcesToAnchorDB(client, root)
    assert.deepEqual(client.ops.batches, [2])
    assert.equal(result.saved, 2)

    // Nothing changed: the second sync sends no batch at all.
    const second = await syncSourcesToAnchorDB(client, root)
    assert.equal(second.saved, 0)
    assert.deepEqual(client.ops.batches, [2])
  })

  test('edges whose endpoint failed to save are counted as orphans', async () => {
    const root = makeRepo()
    write(root, 'main.js', "import { boot } from './lib/boot.js'\nfunction start() { boot() }\n")
    write(root, 'lib/boot.js', 'export function boot() { return 1 }\n')
    const client = statefulClient()
    client.saveBatch = async () => {
      throw new Error('batch refused')
    }
    const realSave = client.saveWithID.bind(client)
    client.saveWithID = async (name, props) => {
      if (name === 'main.js') throw new Error('save rejected')
      return realSave(name, props)
    }

    const result = await syncSourcesToAnchorDB(client, root)
    assert.equal(result.failed, 1)
    // main.js is not live, so its imports edge and its defines edge dangle;
    // the calls edge lives on main.js#start, which saved fine.
    assert.equal(result.orphans, 2)
  })
})

describe('symbol graph', () => {
  function statefulClient() {
    const records = new Map()
    const operations = new Map()
    const edges = new Map()
    const ops = { linked: [], unlinked: [], saved: [], batches: [] }
    return {
      ops,
      records,
      operations,
      edges,
      async list() {
        const items = [...records]
          .filter(([name]) => operations.get(name) !== 2)
          .map(([name, props]) => ({ name, props }))
        return { totalCount: items.length, hasMore: false, items }
      },
      async causalChain([seed], relation) {
        return (edges.get(`${seed}\u0000${relation}`) || []).map((word) => ({ word }))
      },
      async link(from, type, to) {
        const key = `${from}\u0000${type}`
        edges.set(key, [...(edges.get(key) || []), to])
        ops.linked.push(`${from}\u0000${type}\u0000${to}`)
      },
      async unlink(from, type, to) {
        const key = `${from}\u0000${type}`
        edges.set(key, (edges.get(key) || []).filter((word) => word !== to))
        ops.unlinked.push(`${from}\u0000${type}\u0000${to}`)
      },
      async saveWithID(name, props) {
        records.set(name, props)
        operations.set(name, 1)
        ops.saved.push(name)
      },
      async saveBatch(items) {
        for (const item of items) {
          records.set(item.name, item.props)
          operations.set(item.name, item.operation ?? 1)
          ops.saved.push(item.name)
        }
        ops.batches.push(items.length)
      }
    }
  }

  test('buildSourcesGraph emits symbol nodes, defines, and unique-name calls', async () => {
    const root = makeRepo()
    write(root, 'main.js', "import { boot } from './lib/boot.js'\nfunction start() { boot() }\n")
    write(root, 'lib/boot.js', 'export function boot() { return 1 }\n')

    const { nodes, edges } = await buildSourcesGraph(root)
    const types = nodes.map((n) => `${n.type}:${n.id}`).sort()
    assert.deepEqual(types, [
      'file:lib/boot.js',
      'file:main.js',
      'symbol:lib/boot.js#boot',
      'symbol:main.js#start'
    ])
    const edgesById = edges.map((e) => `${e.from}->${e.to}:${e.type}`).sort()
    assert.deepEqual(edgesById, [
      'lib/boot.js->lib/boot.js#boot:defines',
      'main.js#start->lib/boot.js#boot:calls',
      'main.js->lib/boot.js:imports',
      'main.js->main.js#start:defines'
    ])
    // The symbol record's attributes stay numeric-only.
    const symbolNode = nodes.find((n) => n.type === 'symbol')
    assert.deepEqual(Object.keys(symbolNode.metadata).sort(), ['line', 'lines'])
  })

  test('Go calls resolve inside the package directory first', async () => {
    const root = makeRepo()
    fs.writeFileSync(path.join(root, 'go.mod'), 'module github.com/acme/app\n', 'utf8')
    write(root, 'main.go', 'package main\n\nimport "github.com/acme/app/internal/queue"\n\nfunc main() {\n\tqueue.Run()\n}\n')
    write(root, 'internal/queue/queue.go', 'package queue\n\nfunc Run() string {\n\treturn help()\n}\n\nfunc help() string { return "ok" }\n')

    const { edges } = await buildSourcesGraph(root)
    const calls = edges.filter((e) => e.type === 'calls').map((e) => `${e.from}->${e.to}`).sort()
    assert.deepEqual(calls, [
      'internal/queue/queue.go#Run->internal/queue/queue.go#help',
      'main.go#main->internal/queue/queue.go#Run'
    ])
  })

  test('ambiguous call names are skipped, never guessed', async () => {
    const root = makeRepo()
    write(root, 'a.js', 'function reset() { go() }\n')
    write(root, 'b.js', 'function go() {}\n')
    write(root, 'c.js', 'function go() {}\n')

    const { edges } = await buildSourcesGraph(root)
    const calls = edges.filter((e) => e.type === 'calls')
    assert.deepEqual(calls, [])
  })

  test('duplicate symbol names in one file get line-suffixed ids', async () => {
    const root = makeRepo()
    write(root, 'a.js', 'function walk() { helper() }\nfunction helper() { go() }\nfunction walk() { helper() }\nfunction go() {}\n')

    const { nodes, edges } = await buildSourcesGraph(root)
    const walkIds = nodes.filter((n) => n.id.startsWith('a.js#walk')).map((n) => n.id).sort()
    assert.deepEqual(walkIds, ['a.js#walk@1', 'a.js#walk@3'])
    // Every defines edge points at a distinct record.
    const defined = edges.filter((e) => e.type === 'defines').map((e) => e.to).sort()
    assert.deepEqual(defined, ['a.js#go', 'a.js#helper', 'a.js#walk@1', 'a.js#walk@3'])
    // Calls made from inside a duplicated symbol carry the suffixed id too:
    // an unsuffixed `a.js#walk` endpoint would dangle on the server.
    const calls = edges.filter((e) => e.type === 'calls').map((e) => `${e.from}->${e.to}`).sort()
    assert.deepEqual(calls, [
      'a.js#helper->a.js#go',
      'a.js#walk@1->a.js#helper',
      'a.js#walk@3->a.js#helper'
    ])
  })

  test('a receiver call without import evidence is skipped, not guessed', async () => {
    const root = makeRepo()
    write(root, 'lib/log.js', 'export function Log() {}\n')
    write(root, 'app.js', 'function run() { s.Log() }\n')

    const { edges } = await buildSourcesGraph(root)
    assert.deepEqual(edges.filter((e) => e.type === 'calls'), [])
  })

  test('a receiver call resolves when the receiver is an import binding', async () => {
    const root = makeRepo()
    write(root, 'lib/log.js', 'export function Log() { return 1 }\n')
    write(root, 'esm.js', "import s from './lib/log.js'\nfunction viaEsm() { s.Log() }\n")
    write(root, 'ns.js', "import * as ns from './lib/log.js'\nfunction viaNs() { ns.Log() }\n")
    write(root, 'cjs.js', "const s = require('./lib/log.js')\nfunction viaCjs() { s.Log() }\n")

    const { edges } = await buildSourcesGraph(root)
    const calls = edges.filter((e) => e.type === 'calls').map((e) => `${e.from}->${e.to}`).sort()
    assert.deepEqual(calls, [
      'cjs.js#viaCjs->lib/log.js#Log',
      'esm.js#viaEsm->lib/log.js#Log',
      'ns.js#viaNs->lib/log.js#Log'
    ])
  })

  test('Go: alias and last path segment count as receiver evidence', async () => {
    const root = makeRepo()
    fs.writeFileSync(path.join(root, 'go.mod'), 'module github.com/acme/app\n', 'utf8')
    write(root, 'main.go', [
      'package main',
      'import (',
      '\tq "github.com/acme/app/internal/queue"',
      '\t"github.com/acme/app/internal/other"',
      ')',
      'func main() {',
      '\tq.Run()',
      '\tother.Help()',
      '\tbogus.Run()',
      '}'
    ].join('\n'))
    write(root, 'internal/queue/queue.go', 'package queue\n\nfunc Run() {}\n')
    write(root, 'internal/other/other.go', 'package other\n\nfunc Help() {}\n')

    const { edges } = await buildSourcesGraph(root)
    const calls = edges.filter((e) => e.type === 'calls').map((e) => `${e.from}->${e.to}`).sort()
    assert.deepEqual(calls, [
      'main.go#main->internal/other/other.go#Help',
      'main.go#main->internal/queue/queue.go#Run'
    ])
  })

  test('desiredSourceEdgeKeys mirrors every relation type', () => {
    const keys = desiredSourceEdgeKeys([
      { from: 'a.js', to: 'b.js', type: 'imports' },
      { from: 'a.js', to: 'a.js#run', type: 'defines' },
      { from: 'a.js#run', to: 'b.js#go', type: 'calls' }
    ])
    assert.ok(keys.has(edgeKey('a.js', 'imports', 'b.js')))
    assert.ok(keys.has(edgeKey('b.js', 'imported_by', 'a.js')))
    assert.ok(keys.has(edgeKey('a.js', 'defines', 'a.js#run')))
    assert.ok(keys.has(edgeKey('a.js#run', 'defined_in', 'a.js')))
    assert.ok(keys.has(edgeKey('a.js#run', 'calls', 'b.js#go')))
    assert.ok(keys.has(edgeKey('b.js#go', 'called_by', 'a.js#run')))
    assert.equal(keys.size, 6)
  })

  test('labelContent lists one line per symbol', () => {
    const text = labelContent('lib/boot.js', [
      { name: 'boot', kind: 'function', line: 3, lines: 4 },
      { name: 'Boot.help', kind: 'method', line: 8, lines: 1 }
    ])
    assert.equal(text, '# lib/boot.js\n\n- `boot` (function, line 3)\n- `Boot.help` (method, line 8)\n')
  })

  test('sync stores symbols, links defines and calls, and writes label files', async () => {
    const root = makeRepo()
    write(root, 'main.js', "import { boot } from './lib/boot.js'\nfunction start() { boot() }\n")
    write(root, 'lib/boot.js', 'export function boot() { return 1 }\n')
    const client = statefulClient()

    const result = await syncSourcesToAnchorDB(client, root)
    assert.equal(result.files, 2)
    assert.equal(result.symbols, 2)
    assert.equal(result.labels.written, 2)
    assert.ok(client.ops.linked.includes('lib/boot.js\u0000defines\u0000lib/boot.js#boot'))
    assert.ok(client.ops.linked.includes('lib/boot.js#boot\u0000defined_in\u0000lib/boot.js'))
    assert.ok(client.ops.linked.includes('main.js#start\u0000calls\u0000lib/boot.js#boot'))
    assert.ok(client.ops.linked.includes('lib/boot.js#boot\u0000called_by\u0000main.js#start'))

    // Label files mirror the files, under .knowledges/.knl-data.
    const bootLabel = path.join(root, '.knowledges/.knl-data/lib/boot.js.md')
    assert.equal(
      fs.readFileSync(bootLabel, 'utf8'),
      '# lib/boot.js\n\n- `boot` (function, line 1)\n'
    )
    assert.ok(fs.existsSync(path.join(root, '.knowledges/.knl-data/main.js.md')))

    // Idempotent: a second unchanged sync writes and deletes nothing.
    const second = await syncSourcesToAnchorDB(client, root)
    assert.deepEqual(second.labels, { written: 0, deleted: 0 })
    assert.deepEqual(
      { linked: second.linked, unlinked: second.unlinked, saved: second.saved, failed: second.failed },
      { linked: 0, unlinked: 0, saved: 0, failed: 0 }
    )
  })

  test('a removed symbol is tombstoned; a removed file loses its label file', async () => {
    const root = makeRepo()
    write(root, 'main.js', "import { boot } from './lib/boot.js'\nfunction start() { boot() }\n")
    write(root, 'lib/boot.js', 'export function boot() { return 1 }\n')
    const client = statefulClient()
    await syncSourcesToAnchorDB(client, root)

    // The symbol disappears from the file: its record is tombstoned and
    // its label file is deleted (the file no longer defines any symbol).
    write(root, 'lib/boot.js', '')
    const second = await syncSourcesToAnchorDB(client, root)
    assert.equal(second.tombstoned, 1)
    assert.equal(client.records.get('lib/boot.js#boot').tombstone, 2)
    assert.deepEqual(second.labels, { written: 0, deleted: 1 })
    assert.ok(!fs.existsSync(path.join(root, '.knowledges/.knl-data/lib/boot.js.md')))

    // The file disappears too: its own record is tombstoned as well.
    fs.rmSync(path.join(root, 'lib/boot.js'))
    const third = await syncSourcesToAnchorDB(client, root)
    assert.equal(client.records.get('lib/boot.js').tombstone, 2)
    assert.deepEqual(third.labels, { written: 0, deleted: 0 })
  })
})

describe('traceSources', () => {
  // Fake server: edges keyed like the real causalChain walks.
  function chainClient(edges) {
    const map = new Map()
    for (const [from, type, to] of edges) {
      const key = `${from}\u0000${type}`
      map.set(key, [...(map.get(key) || []), { word: to }])
    }
    return {
      async causalChain([seed], relation) {
        return map.get(`${seed}\u0000${relation}`) || []
      }
    }
  }

  test('files trace imports; symbol ids trace calls', async () => {
    const edges = [
      ['main.js', 'imports', 'lib/boot.js'],
      ['lib/boot.js', 'imported_by', 'main.js'],
      ['main.js#boot', 'calls', 'lib/boot.js#boot'],
      ['lib/boot.js#boot', 'called_by', 'main.js#boot']
    ]
    const client = chainClient(edges)

    const fileTrace = await traceSources(client, 'main.js', 'out', 2)
    assert.deepEqual(fileTrace.out, [['lib/boot.js', 1]])

    const symbolTrace = await traceSources(client, 'main.js#boot', 'both', 2)
    assert.deepEqual(symbolTrace.out, [['lib/boot.js#boot', 1]])
    assert.deepEqual(symbolTrace.in, [])
  })
})

describe('SOURCE_RELATIONS', () => {
  test('the two mirrored directions', () => {
    assert.deepEqual(SOURCE_RELATIONS, ['imports', 'imported_by'])
  })
})

describe('collector helpers', () => {
  test('collectorHttpUrl maps the wire port to the REST port below it', () => {
    assert.equal(collectorHttpUrl('wire://127.0.0.1:7448'), 'http://127.0.0.1:7447/v1/collector/run')
    assert.equal(collectorHttpUrl('wire://localhost:7456'), 'http://localhost:7455/v1/collector/run')
    assert.equal(collectorHttpUrl('http://10.0.0.5:9000'), null)
  })

  test('purgeArchivedRecords posts the model-scoped collector request', async () => {
    const calls = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options })
      return {
        ok: true,
        json: async () => ({ success: true, purged_records: 7 })
      }
    }
    try {
      const purged = await purgeArchivedRecords('wire://127.0.0.1:7448', 'secret', 'mymodel')
      assert.equal(purged, 7)
    } finally {
      globalThis.fetch = originalFetch
    }
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'http://127.0.0.1:7447/v1/collector/run')
    assert.equal(calls[0].options.method, 'POST')
    assert.equal(calls[0].options.headers.Authorization, 'Bearer secret')
    assert.deepEqual(JSON.parse(calls[0].options.body), { model: 'mymodel' })
  })

  test('purgeArchivedRecords throws on a failed collector run', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) })
    try {
      await assert.rejects(
        purgeArchivedRecords('wire://127.0.0.1:7448', 't', 'mymodel'),
        /HTTP 500/
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
