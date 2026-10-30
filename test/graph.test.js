import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { GraphNode, GraphEdge, DirectedGraph } from '../server/graph/model.js'
import { parseKnowledgeContent, parseDecisionBlocks, buildGraphFromRoot } from '../server/graph/parser.js'
import { createKnowledgeServer } from '../server/index.js'
import {
  createAnchorWireClient,
  syncGraphToAnchorDB,
  traceCausalChain,
  edgeKey,
  edgesOfGraph,
  diffEdges
} from '../server/graph/anchordb_client.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(here, '..')

describe('Graph Model & Subgraph Extraction', () => {
  test('DirectedGraph adds nodes and edges correctly', () => {
    const graph = new DirectedGraph()
    const nodeA = new GraphNode({ id: 'doc-a', title: 'Doc A', type: 'knowledge' })
    const nodeB = new GraphNode({ id: 'doc-b', title: 'Doc B', type: 'knowledge' })
    const edge = new GraphEdge({ from: 'doc-a', to: 'doc-b', type: 'depends_on' })

    graph.addNode(nodeA)
    graph.addNode(nodeB)
    graph.addEdge(edge)

    assert.equal(graph.nodes.size, 2)
    assert.equal(graph.edges.length, 1)
    assert.equal(graph.getOutgoingEdges('doc-a').length, 1)
    assert.equal(graph.getIncomingEdges('doc-b').length, 1)
  })

  test('extractSubGraph extracts limited hop radius for AI context', () => {
    const graph = new DirectedGraph()
    graph.addNode(new GraphNode({ id: 'DEC-001', title: 'Root Decision', type: 'decision' }))
    graph.addNode(new GraphNode({ id: 'DEC-002', title: 'Child Decision', type: 'decision' }))
    graph.addNode(new GraphNode({ id: 'features/auth.md', title: 'Auth Doc', type: 'knowledge' }))
    graph.addNode(new GraphNode({ id: 'unrelated.md', title: 'Unrelated', type: 'knowledge' }))

    graph.addEdge(new GraphEdge({ from: 'DEC-002', to: 'DEC-001', type: 'supersedes' }))
    graph.addEdge(new GraphEdge({ from: 'DEC-002', to: 'features/auth.md', type: 'affects_knowledge' }))

    const sub = graph.extractSubGraph('DEC-002', 1)
    assert.equal(sub.center, 'DEC-002')
    assert.equal(sub.nodes.length, 3)
    const nodeIds = sub.nodes.map(n => n.id)
    assert.ok(nodeIds.includes('DEC-001'))
    assert.ok(nodeIds.includes('DEC-002'))
    assert.ok(nodeIds.includes('features/auth.md'))
    assert.ok(!nodeIds.includes('unrelated.md'))
  })
})

describe('Knowledge & Decision Parsers', () => {
  test('parseKnowledgeContent extracts frontmatter, headings, and links', () => {
    const sampleMd = `---
title: Authentication Architecture
depends_on: [features/session.md]
references: [docs/security.md]
---
# Authentication Architecture

Sistem ini memakai auth token. Lihat juga [User Profile](features/profile.md).
`
    const { node, edges } = parseKnowledgeContent('features/auth.md', sampleMd)
    assert.equal(node.id, 'features/auth.md')
    assert.equal(node.title, 'Authentication Architecture')
    assert.equal(node.type, 'knowledge')

    assert.equal(edges.length, 3)
    const types = edges.map(e => e.type)
    assert.ok(types.includes('depends_on'))
    assert.ok(types.includes('references'))
  })

  test('parseDecisionBlocks extracts decisionskills blocks and relationships', () => {
    const sampleDecisionMd = `<!-- decision:start -->
## Use AnchorDB for Graph Processing

- ID: \`DEC-20261030-130000\`
- Decided at: \`2026-10-30T13:00:00+07:00\`
- Scope: \`architecture\`
- Tags: \`graph\`, \`ai\`
- Supersedes: \`DEC-20261028-100000\`
- Related: none
- References: \`docs/architecture.md\`

### Decision

Gunakan AnchorDB sebagai embedded in-memory graph engine.

### Rationale

Mendukung traversal multi-hop dan causal chain.
<!-- decision:end -->
`
    const { nodes, edges } = parseDecisionBlocks('decisions/2026-10.md', sampleDecisionMd)
    assert.equal(nodes.length, 1)
    assert.equal(nodes[0].id, 'DEC-20261030-130000')
    assert.equal(nodes[0].title, 'Use AnchorDB for Graph Processing')
    assert.equal(nodes[0].type, 'decision')

    assert.equal(edges.length, 2)
    const supEdge = edges.find(e => e.type === 'supersedes')
    assert.ok(supEdge)
    assert.equal(supEdge.to, 'DEC-20261028-100000')

    const refEdge = edges.find(e => e.type === 'affects_knowledge')
    assert.ok(refEdge)
    assert.equal(refEdge.to, 'docs/architecture.md')
  })

  test('buildGraphFromRoot scans existing .knowledges directory', async () => {
    const knlDir = path.join(rootDir, '.knowledges')
    const graph = await buildGraphFromRoot(knlDir)
    assert.ok(graph.nodes.size > 0)
    // Cek bahwa setidaknya README.md terbaca
    const readme = graph.getNode('README.md')
    assert.ok(readme)
    assert.equal(readme.type, 'knowledge')
  })
})

describe('Server Graph HTTP Endpoints', () => {
  test('/api/graph and /api/graph/trace respond with graph data', async () => {
    const knlDir = path.join(rootDir, '.knowledges')
    const server = createKnowledgeServer({ root: knlDir, port: 0 })

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const baseUrl = `http://127.0.0.1:${address.port}`

    try {
      // 1. Test /api/graph
      const resGraph = await fetch(`${baseUrl}/api/graph`)
      assert.equal(resGraph.status, 200)
      const graphData = await resGraph.json()
      assert.ok(Array.isArray(graphData.nodes))
      assert.ok(Array.isArray(graphData.edges))
      assert.ok(graphData.nodes.length > 0)

      // 2. Test /api/graph/trace with valid target
      const resTrace = await fetch(`${baseUrl}/api/graph/trace?target=README.md&hops=1`)
      assert.equal(resTrace.status, 200)
      const traceData = await resTrace.json()
      assert.equal(traceData.center, 'README.md')
      assert.ok(Array.isArray(traceData.nodes))

      // 3. Test /api/graph/trace with missing target (error handling)
      const resErr = await fetch(`${baseUrl}/api/graph/trace`)
      assert.equal(resErr.status, 400)
      const errData = await resErr.json()
      assert.ok(errData.error)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})

describe('CLI Graph Trace (Zero-File Intermediary)', () => {
  test('knl-view graph trace returns on-demand subgraph without writing files', async () => {
    const binPath = path.join(rootDir, 'bin', 'knl-view.js')
    const knlDir = path.join(rootDir, '.knowledges')

    const execFileAsync = promisify(execFile)
    const { stdout } = await execFileAsync(process.execPath, [
      binPath,
      'graph',
      'trace',
      '--target=README.md',
      '--hops=1',
      `--path=${knlDir}`
    ])

    const subGraph = JSON.parse(stdout)
    assert.equal(subGraph.center, 'README.md')
    assert.equal(subGraph.maxHops, 1)
    assert.ok(Array.isArray(subGraph.nodes))
    assert.ok(Array.isArray(subGraph.edges))

    // Pastikan tidak ada berkas perantara graph.json yang tercipta di disk
    const outGraph = path.join(knlDir, 'graph.json')
    assert.ok(!fs.existsSync(outGraph))
  })
})

describe('Incremental Sync', () => {
  const E = (from, type, to) => edgeKey(from, type, to)

  function makeGraph(edges) {
    return {
      edges: edges.map(([from, type, to]) => ({ from, type, to }))
    }
  }

  function fakeClient(existing = new Set()) {
    const calls = { linked: [], unlinked: [] }
    return {
      calls,
      existing,
      async link(from, type, to) {
        calls.linked.push(E(from, type, to))
        existing.add(E(from, type, to))
      },
      async unlink(from, type, to) {
        const key = E(from, type, to)
        if (!existing.has(key)) {
          throw new Error(`Unlink failed (400): edge not found: ${from} -[${type}]-> ${to}`)
        }
        existing.delete(key)
        calls.unlinked.push(key)
      },
      async causalChain([seed], relation, limitK = 10) {
        const words = []
        for (const key of existing) {
          const [from, type, to] = key.split('\u0000')
          if (from === seed && type === relation) words.push({ word: to, score: 1 })
          if (words.length >= limitK) break
        }
        return words
      }
    }
  }

  test('edgesOfGraph dedupes duplicate edges and skips malformed ones', () => {
    const edges = edgesOfGraph(makeGraph([
      ['A', 'supersedes', 'B'],
      ['A', 'supersedes', 'B'],
      ['A', '', 'B'],
      [null, 'r', 'B']
    ]))
    assert.deepEqual(edges, [E('A', 'supersedes', 'B')])
  })

  test('diffEdges splits new, removed, and unchanged edges', () => {
    const desired = [E('A', 'r', 'B'), E('B', 'r', 'C'), E('C', 'r', 'D')]
    const previous = [E('A', 'r', 'B'), E('C', 'r', 'D'), E('Z', 'r', 'GONE')]
    const { toLink, toUnlink } = diffEdges(desired, previous)
    assert.deepEqual(toLink, [E('B', 'r', 'C')])
    assert.deepEqual(toUnlink, [E('Z', 'r', 'GONE')])
  })

  test('diffEdges with no mirror means full link, nothing to unlink', () => {
    const { toLink, toUnlink } = diffEdges([E('A', 'r', 'B')], null)
    assert.deepEqual(toLink, [E('A', 'r', 'B')])
    assert.deepEqual(toUnlink, [])
  })

  test('first sync links everything; second sync with mirror sends nothing', async () => {
    const client = fakeClient()
    const graph = makeGraph([['A', 'supersedes', 'B'], ['A', 'related', 'C']])

    const first = await syncGraphToAnchorDB(client, graph, null)
    assert.equal(first.linked, 2)
    assert.equal(first.failed, 0)
    assert.equal(first.unlinked, 0)

    const second = await syncGraphToAnchorDB(client, graph, first.edges)
    assert.equal(second.linked, 0)
    assert.equal(second.unlinked, 0)
    assert.equal(second.kept, 2)
    assert.equal(second.failed, 0)
    assert.equal(client.calls.linked.length, 2) // tidak ada link ulang
  })

  test('removed markdown edges get unlinked, tolerating edge not found', async () => {
    const client = fakeClient(new Set([E('A', 'supersedes', 'B'), E('OLD', 'r', 'GONE')]))
    const graph = makeGraph([['A', 'supersedes', 'B']]) // OLD hilang dari markdown
    const previous = [E('A', 'supersedes', 'B'), E('OLD', 'r', 'GONE')]

    const result = await syncGraphToAnchorDB(client, graph, previous)
    assert.equal(result.unlinked, 1)
    assert.equal(result.failed, 0)
    assert.deepEqual(client.calls.unlinked, [E('OLD', 'r', 'GONE')])
  })

  test('server wiped fresh: probe rejects stale mirror, full link instead', async () => {
    // Server kosong (container baru), mirror masih menandai dua edge lama.
    // Probe causal tidak menemukan edge sampel → mirror dibuang → full link.
    const client = fakeClient(new Set())
    const graph = makeGraph([['A', 'supersedes', 'B']])
    const previous = [E('A', 'supersedes', 'B'), E('OLD', 'r', 'GONE')]

    const result = await syncGraphToAnchorDB(client, graph, previous)
    assert.equal(result.linked, 1)
    assert.equal(result.unlinked, 0) // tidak ada unlink: mirror dianggap tidak sah
    assert.equal(result.failed, 0)
    assert.deepEqual(result.edges, [E('A', 'supersedes', 'B')])
  })

  test('probe failure (network error) falls back to full link', async () => {
    const client = fakeClient(new Set())
    client.causalChain = async () => { throw new Error('connection lost') }
    const graph = makeGraph([['A', 'r', 'B']])
    const result = await syncGraphToAnchorDB(client, graph, [E('A', 'r', 'B')])
    assert.equal(result.linked, 1)
    assert.equal(result.failed, 0)
  })

  test('failed links are reported and mirror stays behind for retry', async () => {
    const client = fakeClient()
    client.link = async () => { throw new Error('boom') }
    const result = await syncGraphToAnchorDB(client, makeGraph([['A', 'r', 'B']]), null)
    assert.equal(result.failed, 1)
    assert.equal(result.linked, 0)
  })
})

describe('AnchorWire Client Integration', () => {
  test('anchordb_client functions are properly defined and handle connection errors gracefully', async () => {
    assert.equal(typeof createAnchorWireClient, 'function')
    assert.equal(typeof syncGraphToAnchorDB, 'function')
    assert.equal(typeof traceCausalChain, 'function')

    await assert.rejects(
      async () => {
        await createAnchorWireClient({ host: '127.0.0.1', port: 59999, connectTimeoutMs: 300 })
      },
      (err) => {
        assert.ok(err.message.includes('Gagal terhubung ke AnchorDB'))
        return true
      }
    )
  })
})
