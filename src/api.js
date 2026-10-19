async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) {
    let message = `Request ${url} failed (HTTP ${res.status})`
    try {
      const body = await res.json()
      if (body?.error) message = body.error
    } catch {
      // Balasan bukan JSON: pesan HTTP sudah cukup.
    }
    throw new Error(message)
  }
  return res.json()
}

export const fetchMeta = () => getJson('/api/meta')
export const fetchTree = () => getJson('/api/tree')
export const fetchDoc = (path) => getJson(`/api/doc?path=${encodeURIComponent(path)}`)
