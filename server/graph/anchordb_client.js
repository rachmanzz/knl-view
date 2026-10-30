import { connectWire } from '@rahmantech/anchorwire'

/**
 * Modul jembatan opsional ke backend AnchorDB via protokol AnchorWire (wire://).
 * Mematuhi prinsip KISS: hanya aktif jika dikonfigurasikan, dengan fallback graceful.
 */

/**
 * Membuka koneksi klien AnchorWire.
 * @param {string|object} urlOrOptions - Contoh: 'wire://127.0.0.1:7448?model=knowledges'
 */
export async function createAnchorWireClient(urlOrOptions) {
  try {
    const client = await connectWire(urlOrOptions)
    return client
  } catch (err) {
    const target = typeof urlOrOptions === 'string'
      ? urlOrOptions
      : `${urlOrOptions?.host || '?'}:${urlOrOptions?.port || '?'}`
    throw new Error(`Gagal terhubung ke AnchorDB (${target}): ${err.message}`)
  }
}

/**
 * Menyinkronkan seluruh simpul dan relasi dari DirectedGraph ke AnchorDB model.
 * @param {import('@rahmantech/anchorwire').AnchorWireClient} client
 * @param {import('./model.js').DirectedGraph} graph
 * @returns {Promise<{linked: number, failed: number}>}
 */
export async function syncGraphToAnchorDB(client, graph) {
  if (!client || !graph) return { linked: 0, failed: 0 }

  let linked = 0
  let failed = 0

  // Sinkronisasi setiap relasi (edge) via binary link call. Kegagalan satu
  // edge tidak menghentikan sisanya, tapi dihitung supaya status sync jujur.
  for (const edge of graph.edges) {
    try {
      await client.link(edge.from, edge.type, edge.to, 1.0)
      linked += 1
    } catch {
      failed += 1
    }
  }
  return { linked, failed }
}

/**
 * Menelusuran rantai kausal multi-hop terdistribusi di server AnchorDB.
 *
 * Klien AnchorWire memakai array relasi sebagai RANTAI hop berurutan (hop
 * kedua lewat relasi kedua), bukan "salah satu dari". Untuk graf pengetahuan
 * yang mau kita telusuri UNION relasi (DEC --supersedes--> X atau
 * --affects_knowledge--> Y), tiap relasi ditelusuri sendiri per hop lalu
 * digabung: dedupe per simpul, skor tertinggi menang, skor hop selanjutnya
 * dikalikan skor orang tuanya.
 *
 * @param {import('@rahmantech/anchorwire').AnchorWireClient} client
 * @param {string} seedId - ID simpul pusat kueri
 * @param {string|string[]} relations - Relasi yang diikuti (misal: ['supersedes', 'affects_knowledge', 'depends_on'])
 * @param {number} limitK - Batas hasil per panggilan server
 * @param {number} maxHops - Radius hop penelusuran
 */
export async function traceCausalChain(client, seedId, relations = ['supersedes', 'affects_knowledge', 'depends_on'], limitK = 20, maxHops = 2) {
  if (!client) throw new Error('AnchorWire client tidak tersedia.')
  const rels = (Array.isArray(relations) ? relations : [relations]).filter(Boolean)
  if (!rels.length) return []

  const best = new Map() // word -> { word, score }
  let frontier = [{ word: seedId, score: 1 }]

  for (let hop = 1; hop <= Math.max(1, maxHops) && frontier.length; hop++) {
    const nextFrontier = []
    for (const { word, score } of frontier) {
      const perRelation = await Promise.all(
        rels.map((rel) => client.causalChain([word], rel, limitK).catch(() => []))
      )
      for (const results of perRelation) {
        for (const item of results) {
          if (!item?.word || item.word === seedId) continue
          const reached = { word: item.word, score: score * (item.score || 1) }
          const prev = best.get(reached.word)
          if (!prev || reached.score > prev.score) {
            best.set(reached.word, reached)
            nextFrontier.push(reached)
          }
        }
      }
    }
    frontier = nextFrontier
  }

  return Array.from(best.values()).sort((a, b) => b.score - a.score)
}
