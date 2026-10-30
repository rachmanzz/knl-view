import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import {
  scanSourceFiles,
  parseJsImports,
  resolveImportSpecifier,
  buildSourcesGraph,
  desiredSourceEdgeKeys,
  syncSourcesToAnchorDB,
  SOURCE_RELATIONS
} from '../server/graph/sources.js'
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

describe('parseJsImports', () => {
  test('finds ESM, dynamic, and CJS relative imports only', () => {
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
    const specs = parseJsImports(code)
    assert.deepEqual(specs.sort(), [
      '../lib/b.js', './a.js', './c.js', './d.js', './e.js', './side-effect.js'
    ])
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
    const edges = new Map()
    const ops = { linked: [], unlinked: [], saved: [] }
    return {
      ops,
      records,
      edges,
      async list() {
        return {
          totalCount: records.size,
          hasMore: false,
          items: [...records].map(([name, props]) => ({ name, props }))
        }
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
        ops.saved.push(name)
      }
    }
  }

  test('first sync links both directions and saves every record', async () => {
    const root = makeRepo()
    write(root, 'a.js', "import './b.js'\n")
    write(root, 'b.js', '')
    const client = statefulClient()
    const result = await syncSourcesToAnchorDB(client, root)

    assert.deepEqual(result, { linked: 2, unlinked: 0, saved: 2, tombstoned: 0, failed: 0, nodes: 2, edges: 1 })
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
    // The record itself is not deletable in the protocol; the tombstone
    // attribute marks it gone, so later syncs and traces skip it.
    assert.equal(client.records.get('b.js').tombstone, 2)
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
  })
})

describe('SOURCE_RELATIONS', () => {
  test('the two mirrored directions', () => {
    assert.deepEqual(SOURCE_RELATIONS, ['imports', 'imported_by'])
  })
})
