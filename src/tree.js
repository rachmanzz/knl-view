export function indexTree(tree) {
  const files = new Set()
  const dirs = new Set()
  const nodes = new Map()
  const parents = new Map()

  const walk = (list, parentPath) => {
    for (const node of list) {
      nodes.set(node.path, node)
      parents.set(node.path, parentPath)
      if (node.type === 'dir') {
        dirs.add(node.path)
        walk(node.children, node.path)
      } else {
        files.add(node.path)
      }
    }
  }

  walk(tree, null)
  return { files, dirs, nodes, parents }
}

export function ancestorDirs(path) {
  const parts = path.split('/')
  const out = []
  for (let i = 1; i < parts.length; i += 1) {
    out.push(parts.slice(0, i).join('/'))
  }
  return out
}

export function isUnder(path, dirPath) {
  return path === dirPath || path.startsWith(`${dirPath}/`)
}

export function directFiles(node) {
  if (!node || node.type !== 'dir') return []
  return node.children.filter((child) => child.type === 'file')
}

export function directDirs(node) {
  if (!node || node.type !== 'dir') return []
  return node.children.filter((child) => child.type === 'dir')
}

export function findRootReadme(list) {
  return list.find(
    (node) => node.type === 'file' && /^readme(\.(md|markdown|prd))?$/i.test(node.name)
  ) || null
}

export function findReadme(node) {
  if (!node || node.type !== 'dir') return null
  return findRootReadme(node.children)
}

const byName = (a, b) => a.name.localeCompare(b.name, 'id', { numeric: true, sensitivity: 'base' })

// Satu aturan urut untuk semua daftar indeks: dokumen dulu, baru folder.
// Bila peta menetapkan `order`, entri ber-order lebih dulu (menaik); sisanya
// jatuh ke aturan nama seperti biasa. Peta hanya menghias urutan, bukan
// keanggotaan — daftar tetap lahir dari isi disk.
export function orderForIndex(nodes) {
  const withOrder = nodes.filter((n) => n.order != null)
  const withoutOrder = nodes.filter((n) => n.order == null)

  const byPeta = [...withOrder].sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return byName(a, b)
  })

  return [...byPeta, ...withoutOrder.filter((n) => n.type === 'file').sort(byName), ...withoutOrder.filter((n) => n.type === 'dir').sort(byName)]
}

export function countFilesRecursive(node) {
  if (node.type === 'file') return 1
  return node.children.reduce((total, child) => total + countFilesRecursive(child), 0)
}

export function subtreeMtime(node) {
  if (node.type === 'file') return node.mtime || 0
  const times = node.children.map(subtreeMtime)
  return Math.max(node.mtime || 0, ...times)
}

export function allFiles(tree) {
  const out = []
  const walk = (nodes) => {
    for (const node of nodes) {
      if (node.type === 'file') out.push(node)
      else walk(node.children)
    }
  }
  walk(tree)
  return out
}
