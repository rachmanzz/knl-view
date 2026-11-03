
// One place for display labels. Its rules:
// - the disk decides existence, the map may replace the label (`title`);
// - README is `index` wherever it lives;
// - the `.md` extension is not shown (other extensions stay, e.g. `.prd`).
export function displayLabel(node) {
  if (!node) return ''
  if (node.type === 'dir') return node.title || node.name
  if (node.titleFromMap && node.title) return node.title
  const name = node.name || ''
  if (/^readme(\.(md|markdown|prd))?$/i.test(name)) return 'index'
  return /\.md$/i.test(name) ? name.replace(/\.md$/i, '') : name
}

// The second line (heading title) is only useful when the main label is not
// that title itself. A title from the map is already the label, so no repeat.
export function displaySub(node) {
  if (!node || node.type === 'dir') return null
  if (!node.title || node.titleFromMap) return null
  return node.title
}
