import { getLang } from './i18n.js'

const formatters = new Map()

function formatter(kind) {
  const locale = getLang() === 'id' ? 'id-ID' : 'en-GB'
  const key = `${kind}:${locale}`
  if (!formatters.has(key)) {
    formatters.set(
      key,
      kind === 'date'
        ? new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' })
        : new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false })
    )
  }
  return formatters.get(key)
}

export function formatDate(ms) {
  if (!ms) return '-'
  return formatter('date').format(new Date(ms))
}

export function formatDateTime(ms) {
  if (!ms) return '-'
  return `${formatter('date').format(new Date(ms))}, ${formatter('time').format(new Date(ms))}`
}

export function formatBytes(bytes) {
  if (bytes == null) return '-'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = value < 10 ? 1 : 0
  const decimal = getLang() === 'id' ? ',' : '.'
  return `${value.toFixed(digits).replace('.', decimal)} ${units[unit]}`
}

export function countLabel(count, word) {
  return `${count} ${word}`
}
