import { useEffect, useState } from 'react'

export function encodePath(path) {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

export function docHref(path) {
  return `#/f/${encodePath(path)}`
}

export function dirHref(path) {
  return `#/d/${encodePath(path)}`
}

// Rute alias: halaman bikinan sistem yang tidak punya berkas di disk.
export function contentsHref() {
  return '#/a/contents'
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

export function parseHash(hash) {
  const raw = (hash || '').replace(/^#\/?/, '')
  if (!raw) return { key: '', view: 'home', path: '' }

  const segments = raw.split('/')
  const kind = segments[0]
  const path = segments
    .slice(1)
    .map(decodeSegment)
    .join('/')

  if (kind === 'f' && path) return { key: `f/${path}`, view: 'doc', path }
  if (kind === 'd' && path) return { key: `d/${path}`, view: 'dir', path }
  if (kind === 'a' && path === 'contents') return { key: 'a/contents', view: 'alias', alias: 'contents', path }
  return { key: `x/${raw}`, view: 'notfound', path: raw }
}

export function useRoute() {
  const [route, setRoute] = useState(() => parseHash(window.location.hash))

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash(window.location.hash))
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  return route
}
