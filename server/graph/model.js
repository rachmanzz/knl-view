// Directed graph (DAG) data model for knowledges-view: knowledge nodes and
// decision nodes.

export class GraphNode {
  constructor({ id, title, type = 'knowledge', path = '', metadata = {} }) {
    this.id = id
    this.title = title || id
    this.type = type // 'knowledge' | 'decision'
    this.path = path
    this.metadata = metadata
  }

  toJSON() {
    return {
      id: this.id,
      title: this.title,
      type: this.type,
      path: this.path,
      metadata: this.metadata
    }
  }
}

export class GraphEdge {
  constructor({ from, to, type, metadata = {} }) {
    this.from = from
    this.to = to
    this.type = type // 'depends_on' | 'references' | 'supersedes' | 'related_to' | 'affects_knowledge'
    this.metadata = metadata
  }

  toJSON() {
    return {
      from: this.from,
      to: this.to,
      type: this.type,
      metadata: this.metadata
    }
  }
}

export class DirectedGraph {
  constructor() {
    this.nodes = new Map()
    this.edges = []
    this.outgoing = new Map() // nodeId -> Array of edges
    this.incoming = new Map() // nodeId -> Array of edges
  }

  addNode(node) {
    if (!node || !node.id) return
    this.nodes.set(node.id, node)
    if (!this.outgoing.has(node.id)) this.outgoing.set(node.id, [])
    if (!this.incoming.has(node.id)) this.incoming.set(node.id, [])
  }

  addEdge(edge) {
    if (!edge || !edge.from || !edge.to) return
    // Make sure the nodes exist in the outgoing/incoming maps
    if (!this.outgoing.has(edge.from)) this.outgoing.set(edge.from, [])
    if (!this.incoming.has(edge.to)) this.incoming.set(edge.to, [])

    this.edges.push(edge)
    this.outgoing.get(edge.from).push(edge)
    this.incoming.get(edge.to).push(edge)
  }

  getNode(id) {
    return this.nodes.get(id) || null
  }

  getOutgoingEdges(id) {
    return this.outgoing.get(id) || []
  }

  getIncomingEdges(id) {
    return this.incoming.get(id) || []
  }

  // Radius-based N-hop sub-graph extraction (cheap enough to feed to an LLM).
  //
  // `direction` selects which edges the BFS may walk, mechanically relative
  // to the edges themselves — never interpreted as cause and effect:
  //   'out'  — edges leaving the target (what it supersedes / depends_on / affects)
  //   'in'   — edges entering the target (what references or replaces it)
  //   'both' — the default; the full neighborhood as before
  // Each returned node carries `via`: how it connects to the center
  // ('center', 'in', 'out', or 'in+out' when reachable both ways).
  extractSubGraph(startId, maxHops = 2, direction = 'both') {
    const walkOut = direction !== 'in'
    const walkIn = direction !== 'out'
    const reachedVia = new Map() // id -> 'in' | 'out' | 'in+out' | 'center'
    const setVia = (id, via) => {
      const prev = reachedVia.get(id)
      if (prev === undefined) reachedVia.set(id, via)
      else if (prev !== via && prev !== 'center' && via !== 'center') reachedVia.set(id, 'in+out')
    }
    setVia(startId, 'center')
    const collectedEdges = []
    const seenEdges = new Set()
    const queue = [{ id: startId, hop: 0 }]

    while (queue.length > 0) {
      const { id, hop } = queue.shift()
      if (hop >= maxHops) continue

      if (walkOut) {
        for (const edge of this.getOutgoingEdges(id)) {
          const edgeKey = `${edge.from}->${edge.to}:${edge.type}`
          if (!seenEdges.has(edgeKey)) {
            seenEdges.add(edgeKey)
            collectedEdges.push(edge)
          }
          if (!reachedVia.has(edge.to)) {
            queue.push({ id: edge.to, hop: hop + 1 })
          }
          setVia(edge.to, 'out')
        }
      }

      if (walkIn) {
        for (const edge of this.getIncomingEdges(id)) {
          const edgeKey = `${edge.from}->${edge.to}:${edge.type}`
          if (!seenEdges.has(edgeKey)) {
            seenEdges.add(edgeKey)
            collectedEdges.push(edge)
          }
          if (!reachedVia.has(edge.from)) {
            queue.push({ id: edge.from, hop: hop + 1 })
          }
          setVia(edge.from, 'in')
        }
      }
    }

    const subNodes = []
    for (const [id, via] of reachedVia) {
      const node = this.getNode(id)
      if (node) subNodes.push({ ...node.toJSON(), via })
    }

    return {
      center: startId,
      maxHops,
      direction,
      nodes: subNodes,
      edges: collectedEdges.map(e => e.toJSON())
    }
  }

  toJSON() {
    return {
      nodes: Array.from(this.nodes.values()).map(n => n.toJSON()),
      edges: this.edges.map(e => e.toJSON())
    }
  }
}
