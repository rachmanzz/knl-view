import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import {
  scanSourceFiles,
  resolveImportSpecifier,
  resolveJsSpecifiers,
  resolveGoSpecifiers,
  resolvePySpecifiers,
  resolveRustSpecifiers,
  goModulePath,
  buildSourcesGraph,
  resolveCallTargets,
  desiredSourceEdgeKeys,
  labelContent,
  writeLabelFiles,
  syncSourcesToAnchorDB,
  traceSources,
  readSourcesSyncState,
  writeSourcesSyncState,
  staleWarning,
  annotateTrace,
  traceHonesty,
  collectorHttpUrl,
  purgeArchivedRecords,
  SOURCE_RELATIONS
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

  test('TS: interfaces, types, enums, functions, and imports', async () => {
    const code = [
      "import { config, run as exec } from './core.js'",
      "import type { Settings } from './types.js'",
      "import def from './default.js'",
      'export interface User { id: string; name: string }',
      'export type UserID = string',
      'export enum Status { Active, Inactive }',
      'export class Manager {',
      '  handle() { exec() }',
      '}',
      'export function init() { def() }'
    ].join('\n')
    const { imports, importNames, symbols, calls } = await extractCode('.ts', code)
    assert.deepEqual(imports.sort(), ['./core.js', './default.js', './types.js'])
    assert.deepEqual(importNames.sort(), ['Settings', 'config', 'def', 'exec'])
    const byName = Object.fromEntries(symbols.map((s) => [s.name, s]))
    assert.deepEqual(Object.keys(byName).sort(), ['Manager', 'Manager.handle', 'Status', 'User', 'UserID', 'init'])
    assert.equal(byName.User.kind, 'interface')
    assert.equal(byName.UserID.kind, 'type')
    assert.equal(byName.Status.kind, 'enum')
    assert.equal(byName.Manager.kind, 'class')
    assert.equal(byName['Manager.handle'].kind, 'method')
    assert.equal(byName.init.kind, 'function')
    const callNames = calls.map((c) => c.name).sort()
    assert.deepEqual(callNames, ['def', 'exec'])
  })

  test('TSX: components and calls', async () => {
    const code = [
      "import React from 'react'",
      "import { Button } from './ui/button.js'",
      'export function App() {',
      '  Button()',
      '  return null',
      '}'
    ].join('\n')
    const { imports, symbols, calls } = await extractCode('.tsx', code)
    assert.deepEqual(imports.sort(), ['./ui/button.js', 'react'])
    assert.equal(symbols[0].name, 'App')
    assert.equal(symbols[0].kind, 'function')
    assert.equal(calls[0].name, 'Button')
  })

  test('Python: imports, classes, functions, methods, and calls', async () => {
    const code = [
      'import os',
      'import sys as system',
      'from .local import helper, util as u',
      'from pkg.sub import something',
      '',
      'class Greeter:',
      '    def greet(self):',
      '        helper()',
      '        u.call()',
      '',
      'def top_func():',
      '    pass'
    ].join('\n')
    const { imports, importNames, symbols, calls } = await extractCode('.py', code)
    assert.deepEqual(imports.sort(), [
      '.local',
      '.local.helper',
      '.local.util',
      'os',
      'pkg.sub',
      'pkg.sub.something',
      'sys'
    ])
    assert.deepEqual(importNames.sort(), ['helper', 'os', 'something', 'system', 'u'])
    const byName = Object.fromEntries(symbols.map((s) => [s.name, s]))
    assert.deepEqual(Object.keys(byName).sort(), ['Greeter', 'Greeter.greet', 'top_func'])
    assert.equal(byName.Greeter.kind, 'class')
    assert.equal(byName['Greeter.greet'].kind, 'method')
    assert.equal(byName.top_func.kind, 'function')
    const plainCall = calls.find((c) => c.name === 'helper')
    assert.equal(plainCall.recv, null)
    const attrCall = calls.find((c) => c.name === 'call')
    assert.equal(attrCall.recv, 'u')
  })

  test('Rust: use, mod, structs, traits, impl methods, and calls', async () => {
    const code = [
      'mod helper;',
      'use crate::utils::{calc, format as fmt};',
      'use super::parent_item;',
      'use std::collections::HashMap;',
      '',
      'pub struct Config {',
      '    pub name: String,',
      '}',
      '',
      'pub trait Processor {',
      '    fn process(&self);',
      '}',
      '',
      'impl Config {',
      '    pub fn new() -> Self {',
      '        calc();',
      '        fmt.format();',
      '        Config { name: String::new() }',
      '    }',
      '}',
      '',
      'pub fn run() {}'
    ].join('\n')
    const { imports, importNames, symbols, calls } = await extractCode('.rs', code)
    assert.deepEqual(imports.sort(), [
      './helper',
      'crate::utils::calc',
      'crate::utils::format',
      'std::collections::HashMap',
      'super::parent_item'
    ])
    assert.deepEqual(importNames.sort(), ['HashMap', 'calc', 'fmt', 'helper', 'parent_item'])
    const byName = Object.fromEntries(symbols.map((s) => [s.name, s]))
    assert.deepEqual(Object.keys(byName).sort(), ['Config', 'Config.new', 'Processor', 'run'])
    assert.equal(byName.Config.kind, 'struct')
    assert.equal(byName.Processor.kind, 'trait')
    assert.equal(byName['Config.new'].kind, 'method')
    assert.equal(byName.run.kind, 'function')
    const plainCall = calls.find((c) => c.name === 'calc')
    assert.equal(plainCall.recv, null)
    const fieldCall = calls.find((c) => c.name === 'format')
    assert.equal(fieldCall.recv, 'fmt')
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
    'src/lib/c/index.js': {},
    'src/component.tsx': {},
    'src/service.ts': {}
  }

  test('exact, extension, and index resolution relative to the importer', () => {
    assert.equal(resolveImportSpecifier('src/main.js', './a.js', files), 'src/a.js')
    assert.equal(resolveImportSpecifier('src/main.js', './a', files), 'src/a.js')
    assert.equal(resolveImportSpecifier('src/x.js', './lib/b.js', files), 'src/lib/b.js')
    assert.equal(resolveImportSpecifier('src/x.js', './lib/c', files), 'src/lib/c/index.js')
    assert.equal(resolveImportSpecifier('src/x.js', '../other/missing.js', files), null)
  })

  test('resolves .js specifiers to .ts or .tsx files on disk for TS ESM', () => {
    assert.equal(resolveImportSpecifier('src/main.ts', './service.js', files), 'src/service.ts')
    assert.equal(resolveImportSpecifier('src/main.ts', './component.js', files), 'src/component.tsx')
    assert.equal(resolveImportSpecifier('src/main.ts', './component', files), 'src/component.tsx')
  })
})

describe('resolvePySpecifiers', () => {
  const files = {
    'app/services/auth.py': {},
    'app/services/helper.py': {},
    'app/utils.py': {},
    'app/__init__.py': {},
    'main.py': {}
  }

  test('resolves relative dots and package paths', () => {
    assert.deepEqual(resolvePySpecifiers('app/services/auth.py', ['.helper'], files), ['app/services/helper.py'])
    assert.deepEqual(resolvePySpecifiers('app/services/auth.py', ['..utils'], files), ['app/utils.py'])
    assert.deepEqual(resolvePySpecifiers('main.py', ['app.utils'], files), ['app/utils.py'])
    assert.deepEqual(resolvePySpecifiers('main.py', ['app.services.auth'], files), ['app/services/auth.py'])
  })

  test('external and missing imports resolve to empty list', () => {
    assert.deepEqual(resolvePySpecifiers('main.py', ['os', 'sys', 'numpy'], files), [])
    assert.deepEqual(resolvePySpecifiers('main.py', ['.missing'], files), [])
  })
})

describe('resolveRustSpecifiers', () => {
  const files = {
    'src/main.rs': {},
    'src/utils.rs': {},
    'src/services/auth.rs': {},
    'src/services/helper.rs': {},
    'src/models/user.rs': {}
  }

  test('resolves crate::, super::, self::, and mod relative paths', () => {
    assert.deepEqual(resolveRustSpecifiers('src/services/auth.rs', ['crate::models::user'], files), ['src/models/user.rs'])
    assert.deepEqual(resolveRustSpecifiers('src/services/auth.rs', ['crate::utils'], files), ['src/utils.rs'])
    assert.deepEqual(resolveRustSpecifiers('src/services/auth.rs', ['super::utils'], files), ['src/utils.rs'])
    assert.deepEqual(resolveRustSpecifiers('src/services/auth.rs', ['./helper'], files), ['src/services/helper.rs'])
  })

  test('external crates resolve to empty list', () => {
    assert.deepEqual(resolveRustSpecifiers('src/main.rs', ['std::fmt', 'tokio::sync::Mutex'], files), [])
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

  test('TypeScript repo: builds imports, defines, and calls edges', async () => {
    const root = makeRepo()
    write(root, 'src/service.ts', "export function calculate() { return 42 }\n")
    write(root, 'src/main.ts', [
      "import { calculate } from './service.js'",
      "export function run() {",
      "  calculate()",
      "}"
    ].join('\n'))

    const { nodes, edges } = await buildSourcesGraph(root)
    const pairs = edges.map((e) => `${e.from}->${e.to}:${e.type}`).sort()
    assert.deepEqual(pairs, [
      'src/main.ts#run->src/service.ts#calculate:calls',
      'src/main.ts->src/main.ts#run:defines',
      'src/main.ts->src/service.ts:imports',
      'src/service.ts->src/service.ts#calculate:defines'
    ])
    assert.equal(nodes.length, 4) // 2 files + 2 symbols
  })

  test('Python repo: builds imports, defines, and calls edges', async () => {
    const root = makeRepo()
    write(root, 'app/helper.py', "def help():\n    pass\n")
    write(root, 'app/main.py', [
      "from .helper import help",
      "def run():",
      "    help()"
    ].join('\n'))

    const { nodes, edges } = await buildSourcesGraph(root)
    const pairs = edges.map((e) => `${e.from}->${e.to}:${e.type}`).sort()
    assert.deepEqual(pairs, [
      'app/helper.py->app/helper.py#help:defines',
      'app/main.py#run->app/helper.py#help:calls',
      'app/main.py->app/helper.py:imports',
      'app/main.py->app/main.py#run:defines'
    ])
    assert.equal(nodes.length, 4) // 2 files + 2 symbols
  })

  test('Rust repo: builds mod/use imports, defines, and calls edges', async () => {
    const root = makeRepo()
    write(root, 'src/helper.rs', "pub fn help() {}\n")
    write(root, 'src/main.rs', [
      "mod helper;",
      "use crate::helper::help;",
      "pub fn run() {",
      "    help();",
      "}"
    ].join('\n'))

    const { nodes, edges } = await buildSourcesGraph(root)
    const pairs = edges.map((e) => `${e.from}->${e.to}:${e.type}`).sort()
    assert.deepEqual(pairs, [
      'src/helper.rs->src/helper.rs#help:defines',
      'src/main.rs#run->src/helper.rs#help:calls',
      'src/main.rs->src/helper.rs:imports',
      'src/main.rs->src/main.rs#run:defines'
    ])
    assert.equal(nodes.length, 4) // 2 files + 2 symbols
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
  test('first sync links both directions and saves every record', async () => {
    const root = makeRepo()
    write(root, 'a.js', "import './b.js'\n")
    write(root, 'b.js', '')
    const client = statefulClient()
    const result = await syncSourcesToAnchorDB(client, root)

    assert.deepEqual(result, {
      linked: 2, unlinked: 0, saved: 2, tombstoned: 0, failed: 0, orphans: 0,
      files: 2, symbols: 0, edges: 1, bytes: 1, labels: { written: 0, deleted: 0 }
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
    // main.js's label is rewritten too: its call to boot() flips from
    // "1 linked" to "1 skipped (external-callee)" in the resolution note.
    write(root, 'lib/boot.js', '')
    const second = await syncSourcesToAnchorDB(client, root)
    assert.equal(second.tombstoned, 1)
    assert.equal(client.records.get('lib/boot.js#boot').tombstone, 2)
    assert.deepEqual(second.labels, { written: 1, deleted: 1 })
    assert.ok(!fs.existsSync(path.join(root, '.knowledges/.knl-data/lib/boot.js.md')))

    // The file disappears too: its own record is tombstoned as well.
    // main.js's label is rewritten again: its import flips from
    // "1 exact" to unresolved in the lineage line.
    fs.rmSync(path.join(root, 'lib/boot.js'))
    const third = await syncSourcesToAnchorDB(client, root)
    assert.equal(client.records.get('lib/boot.js').tombstone, 2)
    assert.deepEqual(third.labels, { written: 1, deleted: 0 })
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

  test('a dead server reads as serverError, not as "no callers"', async () => {
    const dead = {
      async causalChain() {
        throw new Error('ECONNREFUSED')
      }
    }
    const trace = await traceSources(dead, 'main.js', 'both', 2)
    assert.deepEqual(trace.out, [])
    assert.deepEqual(trace.in, [])
    assert.equal(trace.serverError, 'ECONNREFUSED')
  })

  test('a live server reports serverError null', async () => {
    const trace = await traceSources(chainClient([
      ['main.js', 'imports', 'lib/boot.js'],
      ['lib/boot.js', 'imported_by', 'main.js']
    ]), 'main.js', 'both', 2)
    assert.equal(trace.serverError, null)
    assert.deepEqual(trace.out, [['lib/boot.js', 1]])
  })
})

describe('sources sync-state and staleness', () => {
  test('write then read round-trips; a foreign model reads as null', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knl-state-'))
    try {
      await writeSourcesSyncState('sources', { files: 57, symbols: 333, edges: 851, bytes: 4096 }, home)
      const state = await readSourcesSyncState('sources', home)
      assert.equal(state.model, 'sources')
      assert.equal(state.files, 57)
      assert.equal(state.symbols, 333)
      assert.equal(state.edges, 851)
      assert.equal(state.bytes, 4096)
      assert.match(state.syncedAt, /^\d{4}-\d{2}-\d{2}T/)

      assert.equal(await readSourcesSyncState('other-model', home), null)
      assert.equal(await readSourcesSyncState('missing', path.join(home, 'nope')), null)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  test('drift warning fires only past one unit of drift, with the exact counts', () => {
    const state = { model: 'sources', syncedAt: '2026-11-04T08:00:00Z', files: 57, symbols: 333, edges: 851, bytes: 4096 }
    assert.equal(staleWarning(state, 58, 4096), null)
    assert.equal(staleWarning(state, 56, 4097), null)
    assert.equal(
      staleWarning(state, 59, 4096),
      'graph drift-suspect: 2 files differ since last sync'
    )
    assert.equal(
      staleWarning(state, 57, 4100),
      'graph drift-suspect: 4 KB differ since last sync'
    )
    assert.equal(
      staleWarning(state, 60, 4200),
      'graph drift-suspect: 3 files differ, 104 KB differ since last sync'
    )
    // An old sync-state without bytes: the file count still guards alone.
    assert.equal(
      staleWarning({ model: 'sources', files: 57 }, 60),
      'graph drift-suspect: 3 files differ since last sync'
    )
    assert.equal(staleWarning(null, 57, 4096), null)
    assert.equal(staleWarning(state, undefined, 4096), null)
  })
})

describe('same-file receiver resolution', () => {
  test('sources.trace.receiver-same-file: methods on own types link from the same file', async () => {
    const root = makeRepo()
    write(root, 'sup.js', [
      'class Supervisor {',
      '  start() { return 1 }',
      '}',
      'function runIt() {',
      '  Supervisor.start()',
      '  bogus.start()',
      '}'
    ].join('\n'))

    const { edges } = await buildSourcesGraph(root)
    const calls = edges.filter((e) => e.type === 'calls').map((e) => `${e.from}->${e.to}`).sort()
    assert.deepEqual(calls, [
      'sup.js#runIt->sup.js#Supervisor.start'
    ])
  })

  test('sources.trace.skipped-reason: matched plus skipped covers every call site', () => {
    const symbolIndex = new Map([
      ['Supervisor.start', ['a.js#Supervisor.start']],
      ['run', ['a.js#run']]
    ])
    const file = {
      ext: '.js',
      importNames: [],
      symbols: [
        { name: 'Supervisor', kind: 'class', line: 1, lines: 3, id: 'a.js#Supervisor' },
        { name: 'run', kind: 'function', line: 4, lines: 4, id: 'a.js#run' }
      ],
      calls: [
        { name: 'start', recv: 'Supervisor', row: 4 },
        { name: 'start', recv: 'w', row: 4 },
        { name: 'missing', recv: null, row: 4 },
        { name: 'run', recv: null, row: 4 }
      ]
    }

    const { targets, resolution } = resolveCallTargets('a.js', file, symbolIndex, {})
    assert.deepEqual(targets, [{ from: 'a.js#run', to: 'a.js#Supervisor.start' }])
    assert.deepEqual(resolution.get('a.js#run'), {
      matched: 1,
      skipped: 3,
      skippedReasons: { 'local-receiver': 1, 'external-callee': 1, 'self-call': 1 }
    })
  })

  test('unresolvable qualified names count as skipped, not matched', () => {
    const symbolIndex = new Map([
      ['Supervisor.start', ['lib/x.js#Supervisor.start', 'lib2/o.js#Supervisor.start']]
    ])
    const file = {
      ext: '.js',
      importNames: [],
      symbols: [
        { name: 'Supervisor', kind: 'class', line: 1, lines: 2, id: 'a.js#Supervisor' },
        { name: 'run', kind: 'function', line: 3, lines: 2, id: 'a.js#run' }
      ],
      calls: [{ name: 'start', recv: 'Supervisor', row: 3 }]
    }

    const { targets, resolution } = resolveCallTargets('a.js', file, symbolIndex, {})
    assert.deepEqual(targets.map(e=>e.to), [])
    assert.equal(resolution.get('a.js#run').matched, 0)
    assert.equal(resolution.get('a.js#run').skipped, 1)
    assert.equal(resolution.get('a.js#run').skippedReasons['ambiguous-callee'], 1)
  })

  test('external and ambiguous callees get different skip reasons', () => {
    // missing() is defined nowhere (external); dup() twice project-wide
    // (ambiguous). Same skip count, different diagnosis for the reader.
    const symbolIndex = new Map([
      ['dup', ['x.js#dup', 'y.js#dup']]
    ])
    const file = {
      ext: '.js',
      importNames: [],
      symbols: [
        { name: 'run', kind: 'function', line: 1, lines: 4, id: 'a.js#run' }
      ],
      calls: [
        { name: 'missing', recv: null, row: 1 },
        { name: 'dup', recv: null, row: 2 }
      ]
    }

    const { targets, resolution } = resolveCallTargets('a.js', file, symbolIndex, {})
    assert.deepEqual(targets, [])
    assert.equal(resolution.get('a.js#run').skipped, 2)
    assert.equal(resolution.get('a.js#run').skippedReasons['external-callee'], 1)
    assert.equal(resolution.get('a.js#run').skippedReasons['ambiguous-callee'], 1)
  })

  test('label files carry the resolution note', () => {
    const resolution = new Map([
      ['main.js#start', { matched: 1, skipped: 2, skippedReasons: { 'local-receiver': 2 } }]
    ])
    const text = labelContent('main.js', [
      { name: 'start', kind: 'function', line: 1, lines: 3, id: 'main.js#start' }
    ], resolution)
    assert.equal(text, '# main.js\n\n- `start` (function, line 1) calls 1 linked, 2 skipped (local-receiver 2)\n')
  })

  test('sync persists the note into the label file', async () => {
    const root = makeRepo()
    try {
      write(root, 'sup.js', [
        'class Supervisor {',
        '  start() {}',
        '}',
        'function run() {',
        '  w.start()',
        '  bogus.start()',
        '}'
      ].join('\n'))
      const client = statefulClient()
      await syncSourcesToAnchorDB(client, root)
      const text = fs.readFileSync(path.join(root, '.knowledges/.knl-data/sup.js.md'), 'utf8')
      assert.ok(text.includes('- `Supervisor` (class, line 1)\n'))
      assert.ok(text.includes('- `run` (function, line 4) calls 0 linked, 2 skipped (local-receiver 2)\n'))
      // Idempotent: an unchanged second sync rewrites nothing.
      const second = await syncSourcesToAnchorDB(client, root)
      assert.deepEqual(second.labels, { written: 0, deleted: 0 })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('sources.trace.receiver-this: this.method() in JS/TS links to method on the same class', async () => {
    const root = makeRepo()
    try {
      write(root, 'server.js', [
        'class Server {',
        '  initRouter() { return 1 }',
        '  start() {',
        '    this.initRouter()',
        '  }',
        '}'
      ].join('\n'))

      const { edges } = await buildSourcesGraph(root)
      const calls = edges.filter((e) => e.type === 'calls').map((e) => `${e.from}->${e.to}`)
      assert.deepEqual(calls, ['server.js#Server.start->server.js#Server.initRouter'])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('sources.trace.receiver-type-match: variable matching type name links method (e.g. stitcher.RegisterRoute)', async () => {
    const root = makeRepo()
    try {
      write(root, 'stitcher.js', [
        'class Stitcher {',
        '  RegisterRoute() { return 1 }',
        '}',
        'function main() {',
        '  const stitcher = new Stitcher()',
        '  stitcher.RegisterRoute()',
        '}'
      ].join('\n'))

      const { edges } = await buildSourcesGraph(root)
      const calls = edges.filter((e) => e.type === 'calls').map((e) => `${e.from}->${e.to}`).sort()
      assert.deepEqual(calls, [
        'stitcher.js#main->stitcher.js#Stitcher',
        'stitcher.js#main->stitcher.js#Stitcher.RegisterRoute'
      ])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('sources.trace.receiver-go-method: Go method receiver s.method() links to method on same struct', async () => {
    const root = makeRepo()
    try {
      write(root, 'server.go', [
        'package main',
        'type Server struct{}',
        'func (s *Server) initRouter() {}',
        'func (s *Server) Start() {',
        '  s.initRouter()',
        '}'
      ].join('\n'))

      const { edges } = await buildSourcesGraph(root)
      const calls = edges.filter((e) => e.type === 'calls').map((e) => `${e.from}->${e.to}`)
      assert.deepEqual(calls, ['server.go#Server.Start->server.go#Server.initRouter'])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('SOURCE_RELATIONS', () => {
  test('the two mirrored directions', () => {
    assert.deepEqual(SOURCE_RELATIONS, ['imports', 'imported_by'])
  })
})

describe('import lineage quality', () => {
  test('JS: relative imports exact, bare packages declared and unresolved', async () => {
    const root = makeRepo()
    write(root, 'main.js', "import { boot } from './lib/boot.js'\nimport fs from 'node:fs'\nimport 'x-package'\n")
    write(root, 'lib/boot.js', 'export function boot() { return 1 }\n')

    const { importQuality, importSpecs } = await buildSourcesGraph(root)
    assert.equal(importQuality.get('main.js').get('lib/boot.js'), 'exact')
    assert.deepEqual([...importQuality.get('main.js').keys()], ['lib/boot.js'])
    assert.deepEqual(importSpecs.get('main.js'), { declared: 3, unresolved: 2, exact: 1, lazy: 0 })
    assert.equal(importSpecs.get('lib/boot.js'), undefined)
    fs.rmSync(root, { recursive: true, force: true })
  })

  test('Go: a package import fans out lazy; external stays unresolved', async () => {
    const root = makeRepo()
    fs.writeFileSync(path.join(root, 'go.mod'), 'module github.com/acme/app\n\ngo 1.22\n', 'utf8')
    write(root, 'main.go', 'package main\n\nimport (\n\t"fmt"\n\t"github.com/acme/app/internal/queue"\n)\n\nfunc main() { queue.Run() }\n')
    write(root, 'internal/queue/queue.go', 'package queue\n\nimport "fmt"\n\nfunc Run() { fmt.Println("q") }\n')
    write(root, 'internal/queue/helper.go', 'package queue\n\nfunc help() {}\n')

    const { importQuality, importSpecs } = await buildSourcesGraph(root)
    assert.equal(importQuality.get('main.go').get('internal/queue/queue.go'), 'lazy')
    assert.equal(importQuality.get('main.go').get('internal/queue/helper.go'), 'lazy')
    assert.deepEqual(importSpecs.get('main.go'), { declared: 2, unresolved: 1, exact: 0, lazy: 2 })
    assert.deepEqual(importSpecs.get('internal/queue/queue.go'), { declared: 1, unresolved: 1, exact: 0, lazy: 0 })
    fs.rmSync(root, { recursive: true, force: true })
  })

  test('Rust mod and Python module imports stay exact', async () => {
    const root = makeRepo()
    write(root, 'src/main.rs', 'mod utils;\nfn main() { utils::run() }\n')
    write(root, 'src/utils.rs', 'pub fn run() {}\n')
    write(root, 'app/service.py', 'from .helper import value\n')
    write(root, 'app/helper.py', 'value = 1\n')

    const { importQuality } = await buildSourcesGraph(root)
    assert.equal(importQuality.get('src/main.rs').get('src/utils.rs'), 'exact')
    assert.equal(importQuality.get('app/service.py').get('app/helper.py'), 'exact')
    fs.rmSync(root, { recursive: true, force: true })
  })

  test('label files record the classification at sync time', () => {
    const text = labelContent('main.go', [
      { name: 'main', kind: 'function', line: 5, lines: 3, id: 'main.go#main' }
    ], null, { declared: 3, unresolved: 1, exact: 1, lazy: 1 })
    assert.equal(text,
      '# main.go\n\n' +
      '- imports: 1 exact, 1 lazy (1 specifier unresolved)\n' +
      '- `main` (function, line 5)\n')
  })

  test('annotateTrace marks file edges and warns on resolution-caused emptiness', () => {
    const local = {
      importQuality: new Map([
        ['main.go', new Map([['internal/queue/queue.go', 'lazy']])]
      ]),
      importSpecs: new Map([
        ['main.go', { declared: 2, unresolved: 1, exact: 0, lazy: 1 }],
        ['isolated.js', { declared: 2, unresolved: 2, exact: 0, lazy: 0 }]
      ])
    }
    const trace = {
      out: [['internal/queue/queue.go', 1], ['main.go#main', 1]],
      in: []
    }

    const both = annotateTrace(trace, 'main.go', local, 'both')
    assert.equal(both.out[0].lineage, 'lazy')
    assert.equal(both.out[0].resolution, undefined)
    assert.equal(both.out[1].lineage, undefined) // symbol edge: calls carry no marker
    assert.equal(both.in.length, 0)
    assert.deepEqual(both.warnings, [])

    const empty = annotateTrace({ out: [], in: [] }, 'isolated.js', local, 'both')
    assert.deepEqual(empty.warnings, [
      'out is empty: 2 import specifiers resolved to no project file; external packages are not graph nodes'
    ])

    // direction=in leaves out unqueried: the emptiness is by construction.
    const incoming = annotateTrace({ out: [], in: [] }, 'isolated.js', local, 'in')
    assert.deepEqual(incoming.warnings, [])
  })

  test('traceHonesty: shared envelope for CLI and HTTP', () => {
    const local = {
      nodes: [{ type: 'file' }, { type: 'file' }, { type: 'symbol' }],
      fileBytes: 500
    }
    const dead = traceHonesty('ECONNREFUSED', local, { syncedAt: '2026-11-04T00:00:00Z', files: 2, bytes: 500 })
    assert.equal(dead.server, 'unavailable')
    assert.equal(dead.asOf, '2026-11-04T00:00:00Z')
    assert.equal(dead.asOfSource, 'local')
    assert.equal(dead.drift, null)

    // Drift: the synced count is far off, the scan shows the real one.
    const drifted = traceHonesty(null, local, { syncedAt: '2026-11-04T00:00:00Z', files: 5, bytes: 10 })
    assert.equal(drifted.server, 'reachable')
    assert.match(drifted.drift, /^graph drift-suspect: 3 files differ, 490 KB differ since last sync$/)

    // Never synced: asOf stays null, no drift signal is invented.
    const fresh = traceHonesty(null, local, null)
    assert.equal(fresh.asOf, null)
    assert.equal(fresh.drift, null)

    // No local scan (custom server setup): no invented counts.
    const bare = traceHonesty(null, {}, { syncedAt: '2026-11-04T00:00:00Z', files: 10, bytes: 10 })
    assert.equal(bare.drift, null)
  })
})

describe('sources trace CLI honesty', () => {
  // A fake HOME whose AnchorDB points at a dead port: the CLI must still
  // print the local trace with server "unavailable" (exit 0), and only
  // --strict turns that into a failure.
  function deadHome() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'knl-cli-'))
    fs.mkdirSync(path.join(home, '.knlview'), { recursive: true })
    fs.writeFileSync(
      path.join(home, '.knlview', 'knl-config.json'),
      JSON.stringify({ anchordb: { url: 'wire://127.0.0.1:1', token: 'x', sync: false } }),
      'utf8'
    )
    return home
  }

  test('default: local trace still prints, server unavailable, exit 0', () => {
    const home = deadHome()
    try {
      const res = spawnSync(process.execPath, [path.resolve('bin/knl-view.js'),
        'sources', 'trace', '--target=README.md'], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home },
        timeout: 60000
      })
      assert.equal(res.status, 0, res.stderr)
      const data = JSON.parse(res.stdout)
      assert.equal(data.server, 'unavailable')
      assert.equal(data.asOfSource, 'local')
      assert.match(res.stderr, /sources graph unavailable/)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  test('--strict: same output, exit 1', () => {
    const home = deadHome()
    try {
      const res = spawnSync(process.execPath, [path.resolve('bin/knl-view.js'),
        'sources', 'trace', '--target=README.md', '--strict'], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home },
        timeout: 60000
      })
      assert.equal(res.status, 1)
      assert.equal(JSON.parse(res.stdout).server, 'unavailable')
      assert.match(res.stderr, /sources graph unavailable/)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
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

  test('writeLabelFiles throws when labelDir escapes root', async () => {
    const root = makeRepo()
    try {
      await assert.rejects(
        () => writeLabelFiles(root, '../../escaped', new Map()),
        /resolves outside the project root/
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('scanSourceFiles handles special regex characters in .gitignore without crash', async () => {
    const root = makeRepo()
    try {
      write(root, '.gitignore', '*(special)[unclosed*\n*.temp\n')
      write(root, 'main.js', 'console.log(1)')
      write(root, 'foo.temp', 'temp')
      const files = await scanSourceFiles(root)
      assert.ok('main.js' in files)
      assert.ok(!('foo.temp' in files))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('scanSourceFiles respects custom exclude (truly excludes)', async () => {
    const root = makeRepo()
    try {
      write(root, 'src/main.js', 'console.log(1)')
      write(root, 'src/legacy/old.js', 'console.log(2)')
      write(root, 'tests/main.test.js', 'test()')
      const files = await scanSourceFiles(root, { exclude: ['src/legacy', '*.test.js'] })
      assert.ok('src/main.js' in files)
      assert.ok(!('src/legacy/old.js' in files))
      assert.ok(!('tests/main.test.js' in files))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('scanSourceFiles allows including files from default-ignored directories', async () => {
    const root = makeRepo()
    try {
      write(root, 'src/main.js', 'console.log(1)')
      write(root, 'dist/bundle.js', 'console.log(2)')
      write(root, 'dist/chunk.js', 'console.log(3)')
      write(root, '.hidden/tool.js', 'console.log(4)')
      const files = await scanSourceFiles(root, {
        include: ['src/**', 'dist/bundle.js', '.hidden/**']
      })
      assert.ok('src/main.js' in files)
      assert.ok('dist/bundle.js' in files)
      assert.ok(!('dist/chunk.js' in files))
      assert.ok('.hidden/tool.js' in files)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('exclude takes precedence over include (truly excludes)', async () => {
    const root = makeRepo()
    try {
      write(root, 'src/allowed.js', 'console.log(1)')
      write(root, 'src/secret.js', 'console.log(2)')
      write(root, 'dist/bundle.js', 'console.log(3)')
      write(root, 'dist/bundle.test.js', 'console.log(4)')
      const files = await scanSourceFiles(root, {
        include: ['src/**', 'dist/**'],
        exclude: ['src/secret.js', '*.test.js']
      })
      assert.ok('src/allowed.js' in files)
      assert.ok(!('src/secret.js' in files))
      assert.ok('dist/bundle.js' in files)
      assert.ok(!('dist/bundle.test.js' in files))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
