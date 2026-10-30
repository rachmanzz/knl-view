// Model data graf terarah (Directed Graph / DAG) untuk knowledges-view.
// Menyimpan simpul pengetahuan (Knowledge Nodes) dan simpul keputusan (Decision Nodes).

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
    // Pastikan simpul terdaftar di outgoing/incoming maps
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

  // Ekstraksi sub-graf terarah berbasis radius N-hop (Sangat hemat token untuk LLM)
  extractSubGraph(startId, maxHops = 2) {
    const visitedNodes = new Set()
    const collectedEdges = []
    const seenEdges = new Set()
    const queue = [{ id: startId, hop: 0 }]

    while (queue.length > 0) {
      const { id, hop } = queue.shift()
      if (visitedNodes.has(id)) continue
      visitedNodes.add(id)

      if (hop >= maxHops) continue

      const outEdges = this.getOutgoingEdges(id)
      for (const edge of outEdges) {
        const edgeKey = `${edge.from}->${edge.to}:${edge.type}`
        if (!seenEdges.has(edgeKey)) {
          seenEdges.add(edgeKey)
          collectedEdges.push(edge)
        }
        if (!visitedNodes.has(edge.to)) {
          queue.push({ id: edge.to, hop: hop + 1 })
        }
      }

      const inEdges = this.getIncomingEdges(id)
      for (const edge of inEdges) {
        const edgeKey = `${edge.from}->${edge.to}:${edge.type}`
        if (!seenEdges.has(edgeKey)) {
          seenEdges.add(edgeKey)
          collectedEdges.push(edge)
        }
        if (!visitedNodes.has(edge.from)) {
          queue.push({ id: edge.from, hop: hop + 1 })
        }
      }
    }

    const subNodes = []
    for (const id of visitedNodes) {
      const node = this.getNode(id)
      if (node) subNodes.push(node)
    }

    return {
      center: startId,
      maxHops,
      nodes: subNodes.map(n => n.toJSON()),
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
