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
 * Kunci stabil satu edge untuk diff dan mirror: "from\x00type\x00to".
 * NUL dipakai karena tidak mungkin muncul di ID markdown yang sehat.
 */
export function edgeKey(from, type, to) {
  return `${from}\u0000${type}\u0000${to}`
}

/**
 * Kumpulkan set edge unik dari DirectedGraph. Edge ganda di markdown
 * (satu keputusan menulis supersedes dua kali, misalnya) cukup dikirim
 * satu kali ke server.
 * @param {import('./model.js').DirectedGraph} graph
 * @returns {string[]} kunci edge terurut
 */
export function edgesOfGraph(graph) {
  const set = new Set()
  for (const edge of graph?.edges ?? []) {
    if (edge?.from && edge?.type && edge?.to) set.add(edgeKey(edge.from, edge.type, edge.to))
  }
  return Array.from(set).sort()
}

/**
 * Diff dua set edge: apa yang harus dikirim link dan unlink.
 * @param {string[]} desired - edge yang seharusnya ada (graf lokal kini)
 * @param {string[]|null} previous - edge menurut mirror sinkron terakhir;
 *   null berarti tidak ada mirror (server dianggap kosong → full link)
 * @returns {{toLink: string[], toUnlink: string[]}}
 */
export function diffEdges(desired, previous) {
  const now = new Set(desired)
  if (!previous) return { toLink: [...now], toUnlink: [] }
  const before = new Set(previous)
  return {
    toLink: desired.filter((k) => !before.has(k)),
    toUnlink: previous.filter((k) => !now.has(k))
  }
}

function isEdgeNotFound(err) {
  return /edge not found/i.test(err?.message || '')
}

/**
 * Cek murah apakah server masih mengenali satu edge sampel dari mirror.
 * Kalau target edge sampel tidak muncul dari causalChain, server dianggap
 * sudah berbeda (dipasang ulang, di-wipe, model direset) dan mirror harus
 * dibuang supaya sync jadi full link. Link memang upsert, jadi full link
 * selalu aman; yang berbahaya justru percaya mirror pada server kosong.
 */
async function mirrorStillValid(client, previousEdges) {
  if (!Array.isArray(previousEdges) || previousEdges.length === 0) return Boolean(previousEdges)
  const [from, type, to] = previousEdges[0].split('\u0000')
  try {
    const results = await client.causalChain([from], type, 5)
    return results.some((item) => item?.word === to)
  } catch {
    return false
  }
}

/**
 * Menyinkronkan graf ke AnchorDB secara INKREMENtal: hanya edge baru yang
 * di-link, edge yang hilang dari markdown di-unlink, sisanya dibiarkan.
 * Server tidak menyediakan enumerasi edge, jadi pembandingnya adalah
 * mirror hasil sync terakhir (`previousEdges` dari sync-state lokal) —
 * dan mirror diverifikasi dengan satu probe causal sebelum dipercaya.
 *
 * Unlink ke edge yang sudah tidak ada di server diperlakukan sebagai
 * berhasil (kasus: container/server dipasang ulang tapi mirror masih ada).
 *
 * @param {import('@rahmantech/anchorwire').AnchorWireClient} client
 * @param {import('./model.js').DirectedGraph} graph
 * @param {string[]|null} previousEdges - mirror sync terakhir (null = full sync)
 * @returns {Promise<{linked: number, unlinked: number, kept: number, failed: number, edges: string[]}>}
 *   `edges` = set edge penuh pasca-sync, untuk ditulis ke mirror BILA
 *   `failed === 0`. Kegagalan sebagian tidak menulis mirror supaya start
 *   berikutnya mengulang bagian yang gagal.
 */
export async function syncGraphToAnchorDB(client, graph, previousEdges = null) {
  if (!client || !graph) return { linked: 0, unlinked: 0, kept: 0, failed: 0, edges: [] }

  const edges = edgesOfGraph(graph)
  if (previousEdges && !(await mirrorStillValid(client, previousEdges))) {
    previousEdges = null
  }
  const { toLink, toUnlink } = diffEdges(edges, previousEdges)
  let linked = 0
  let unlinked = 0
  let failed = 0

  for (const key of toLink) {
    const [from, type, to] = key.split('\u0000')
    try {
      await client.link(from, type, to, 1.0)
      linked += 1
    } catch {
      failed += 1
    }
  }

  for (const key of toUnlink) {
    const [from, type, to] = key.split('\u0000')
    try {
      await client.unlink(from, type, to)
      unlinked += 1
    } catch (err) {
      // Edge sudah tidak ada di server: hasil akhirnya sama dengan yang
      // kita mau, jadi dihitung berhasil.
      if (isEdgeNotFound(err)) unlinked += 1
      else failed += 1
    }
  }

  return { linked, unlinked, kept: edges.length - linked, failed, edges }
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
