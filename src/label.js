import { t } from './i18n.js'

// Satu tempat untuk label tampilan. Aturannya:
// - disk menentukan keberadaan, peta boleh mengganti label (`title`);
// - README adalah `index` di mana pun ia berada;
// - ekstensi `.md` tidak ditampilkan (ekstensi lain tetap, mis. `.prd`).
export function displayLabel(node) {
  if (!node) return ''
  if (node.type === 'dir') return node.title || node.name
  if (node.titleFromMap && node.title) return node.title
  const name = node.name || ''
  if (/^readme(\.(md|markdown|prd))?$/i.test(name)) return t('index.index')
  return /\.md$/i.test(name) ? name.replace(/\.md$/i, '') : name
}

// Baris kedua (judul heading) hanya berguna kalau label utamanya bukan
// judul itu sendiri. Judul dari peta sudah jadi label, jadi jangan diulang.
export function displaySub(node) {
  if (!node || node.type === 'dir') return null
  if (!node.title || node.titleFromMap) return null
  return node.title
}
