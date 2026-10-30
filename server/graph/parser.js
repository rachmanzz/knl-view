import { promises as fs } from 'node:fs'
import path from 'node:path'
import { GraphNode, GraphEdge, DirectedGraph } from './model.js'

const MD_EXTS = new Set(['.md', '.markdown', '.prd'])

/**
 * Simple (YAML-like) frontmatter extraction and the first heading.
 */
export function extractFrontmatterAndTitle(content) {
  let metadata = {}
  let body = content
  let title = null

  if (content.startsWith('---')) {
    const endIdx = content.indexOf('\n---', 3)
    if (endIdx !== -1) {
      const rawFm = content.slice(3, endIdx).trim()
      body = content.slice(endIdx + 4)
      metadata = parseSimpleYaml(rawFm)
    }
  }

  if (metadata.title) {
    title = String(metadata.title).trim()
  } else {
    // Take the first H1 as the title
    const match = body.match(/^#\s+(.+)$/m)
    if (match) {
      title = match[1].trim()
    }
  }

  return { metadata, body, title }
}

function parseSimpleYaml(text) {
  const result = {}
  const lines = text.split('\n')
  for (const line of lines) {
    const match = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/)
    if (!match) continue
    const key = match[1].trim()
    let val = match[2].trim()

    // Handle array format [a, b, c]
    if (val.startsWith('[') && val.endsWith(']')) {
      const items = val.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
      result[key] = items
    } else {
      // Strip quotes when present
      val = val.replace(/^['"]|['"]$/g, '')
      result[key] = val
    }
  }
  return result
}

/**
 * Parse a knowledge Markdown file (e.g. docs/xxx.md or features/xxx.md).
 */
export function parseKnowledgeContent(relPath, content) {
  const { metadata, body, title } = extractFrontmatterAndTitle(content)
  const id = relPath.replace(/\\/g, '/')
  const node = new GraphNode({
    id,
    title: title || path.basename(relPath),
    type: 'knowledge',
    path: id,
    metadata
  })

  const edges = []

  // Parse dependencies from the frontmatter
  const deps = Array.isArray(metadata.depends_on) ? metadata.depends_on : (metadata.depends_on ? [metadata.depends_on] : [])
  for (const dep of deps) {
    edges.push(new GraphEdge({
      from: id,
      to: String(dep).trim(),
      type: 'depends_on'
    }))
  }

  // Parse references from the frontmatter
  const refs = Array.isArray(metadata.references) ? metadata.references : (metadata.references ? [metadata.references] : [])
  for (const ref of refs) {
    edges.push(new GraphEdge({
      from: id,
      to: String(ref).trim(),
      type: 'references'
    }))
  }

  // Parse plain markdown links [text](target.md)
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g
  let linkMatch
  while ((linkMatch = linkRegex.exec(body)) !== null) {
    const targetUrl = linkMatch[2].trim()
    // Ignore external web links (http/https/mailto)
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://') && !targetUrl.startsWith('mailto:') && !targetUrl.startsWith('#')) {
      const cleanTarget = targetUrl.split('#')[0].split('?')[0].replace(/^\.\//, '')
      if (cleanTarget) {
        const docDir = path.dirname(relPath).replace(/\\/g, '/')
        const resolvedTarget = (docDir && docDir !== '.' && !cleanTarget.startsWith('/'))
          ? path.posix.normalize(`${docDir}/${cleanTarget}`)
          : cleanTarget.replace(/^\//, '')

        if (resolvedTarget && resolvedTarget !== id) {
          edges.push(new GraphEdge({
            from: id,
            to: resolvedTarget,
            type: 'references',
            metadata: { text: linkMatch[1] }
          }))
        }
      }
    }
  }

  return { node, edges }
}

/**
 * Parse decision blocks from a decision file (decisionskills format: <!-- decision:start -->).
 */
export function parseDecisionBlocks(relPath, content) {
  const nodes = []
  const edges = []

  const blockRegex = /<!--\s*decision:start\s*-->([\s\S]*?)<!--\s*decision:end\s*-->/g
  let match

  while ((match = blockRegex.exec(content)) !== null) {
    const rawBlock = match[1]
    const parsed = parseSingleDecisionBlock(relPath, rawBlock)
    if (parsed) {
      nodes.push(parsed.node)
      edges.push(...parsed.edges)
    }
  }

  return { nodes, edges }
}

// Helper for list fields that may repeat: the lines "- references: a" then
// "- references: b" produce [a, b], not just [b].
function appendList(existing, val) {
  const items = val.split(',').map(s => s.trim().replace(/^`|`$/g, '')).filter(Boolean)
  return existing.concat(items.filter((item) => !existing.includes(item)))
}

function parseSingleDecisionBlock(relPath, rawBlock) {  const lines = rawBlock.split('\n')
  let title = 'Untitled Decision'
  let id = null
  let decidedAt = null
  let scope = null
  let tags = []
  let supersedes = []
  let related = []
  let references = []
  let decisionText = ''

  let currentSection = null

  for (const line of lines) {
    const trimmed = line.trim()

    // Title heading (## Title)
    if (trimmed.startsWith('## ')) {
      title = trimmed.slice(3).trim()
      continue
    }

    // Section header (### Section)
    if (trimmed.startsWith('### ')) {
      currentSection = trimmed.slice(4).trim().toLowerCase()
      continue
    }

    // Metadata bullet items (- Field: Value)
    const metaMatch = trimmed.match(/^-\s+([^:]+):\s*(.*)$/)
    if (metaMatch && !currentSection) {
      const field = metaMatch[1].trim().toLowerCase()
      const val = metaMatch[2].trim().replace(/^`|`$/g, '')

      if (val === 'none' || !val) continue

      if (field === 'id') id = val
      else if (field === 'decided at') decidedAt = val
      else if (field === 'scope') scope = val
      else if (field === 'tags') tags = val.split(',').map(s => s.trim().replace(/^`|`$/g, '')).filter(Boolean)
      // List fields may repeat across lines; the second line appends,
      // it does not overwrite the first.
      else if (field === 'supersedes') supersedes = appendList(supersedes, val)
      else if (field === 'related') related = appendList(related, val)
      else if (field === 'references') references = appendList(references, val)
      continue
    }

    // Body content per section
    if (currentSection === 'decision' && trimmed) {
      decisionText += (decisionText ? ' ' : '') + trimmed
    }
  }

  if (!id) return null

  const node = new GraphNode({
    id,
    title,
    type: 'decision',
    path: relPath.replace(/\\/g, '/'),
    metadata: {
      decided_at: decidedAt,
      scope,
      tags,
      decision: decisionText
    }
  })

  const edges = []

  for (const sup of supersedes) {
    edges.push(new GraphEdge({
      from: id,
      to: sup,
      type: 'supersedes'
    }))
  }

  for (const rel of related) {
    edges.push(new GraphEdge({
      from: id,
      to: rel,
      type: 'related_to'
    }))
  }

  // References are resolved relative to the decision file's own folder,
  // the same rule markdown links follow: a decision in decisions/2026-10.md
  // writing `ref/DEC-x.md` points at decisions/ref/DEC-x.md. Absolute and
  // URL-shaped values are kept as-is.
  const docDir = path.posix.dirname(relPath.replace(/\\/g, '/'))
  for (const ref of references) {
    const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(ref)
    const isDocRef = !isUrl && (ref.endsWith('.md') || ref.includes('/'))
    let target = ref
    if (isDocRef && !ref.startsWith('/')) {
      target = (docDir && docDir !== '.')
        ? path.posix.normalize(`${docDir}/${ref}`)
        : ref.replace(/^\//, '')
    }
    edges.push(new GraphEdge({
      from: id,
      to: target,
      type: isDocRef ? 'affects_knowledge' : 'references'
    }))
  }

  return { node, edges }
}

/**
 * Build the full graph recursively from the knowledge base root folder (.knowledges).
 */
export async function buildGraphFromRoot(rootAbs) {
  const graph = new DirectedGraph()
  await walkDir(rootAbs, '', async (absPath, relPath) => {
    const ext = path.extname(absPath).toLowerCase()
    if (!MD_EXTS.has(ext)) return

    let content
    try {
      content = await fs.readFile(absPath, 'utf8')
    } catch {
      return
    }

    const normRel = relPath.replace(/\\/g, '/')

    // Check whether this is a decision file (under the decisions/ folder)
    if (normRel.startsWith('decisions/')) {
      const { nodes, edges: decisionEdges } = parseDecisionBlocks(normRel, content)
      for (const n of nodes) graph.addNode(n)
      for (const e of decisionEdges) graph.addEdge(e)
      // A decision file with no blocks is a plain document (for example
      // reference material under decisions/ref/): keep it in the graph as
      // a knowledge node so decisions can point at it by path.
      if (nodes.length === 0) {
        const { node } = parseKnowledgeContent(normRel, content)
        graph.addNode(node)
      }
    } else {
      const { node, edges } = parseKnowledgeContent(normRel, content)
      graph.addNode(node)
      for (const e of edges) graph.addEdge(e)
    }
  })

  return graph
}

async function walkDir(baseDir, currentRel, visitor) {
  let entries
  try {
    entries = await fs.readdir(path.join(baseDir, currentRel), { withFileTypes: true })
  } catch {
    return
  }

  for (const ent of entries) {
    if (ent.name.startsWith('.')) {
      continue
    }

    const nextRel = currentRel ? path.join(currentRel, ent.name) : ent.name
    const fullPath = path.join(baseDir, nextRel)

    if (ent.isDirectory()) {
      await walkDir(baseDir, nextRel, visitor)
    } else if (ent.isFile()) {
      await visitor(fullPath, nextRel)
    }
  }
}
