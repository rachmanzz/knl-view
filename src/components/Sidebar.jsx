import { useEffect, useMemo, useState } from 'react'
import { useKnowledge } from '../knowledge.jsx'
import { t } from '../i18n.js'
import { docHref, dirHref, contentsHref } from '../router.js'
import { ancestorDirs, isUnder, orderForIndex, allFiles, findRootReadme } from '../tree.js'
import { displayLabel, displaySub } from '../label.js'
import { countLabel } from '../format.js'

export default function Sidebar({ route, open, onClose }) {
  const { meta, tree, status } = useKnowledge()
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState(() => new Set())

  useEffect(() => {
    if (!tree || route.view === 'home') return
    const extra = route.view === 'dir' ? [route.path] : []
    const targets = [...ancestorDirs(route.path), ...extra]
    if (!targets.length) return
    setExpanded((prev) => {
      const next = new Set(prev)
      for (const target of targets) next.add(target)
      return next
    })
  }, [route.key, route.view, route.path, tree])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q || !tree) return null
    return allFiles(tree).filter((node) => {
      const haystack = `${node.path}\n${node.title || ''}`.toLowerCase()
      return haystack.includes(q)
    })
  }, [query, tree])

  // Dua pintu masuk tetap di atas pohon: `index` (README akar) dan
  // `contents` (rute alias bikinan sistem). README akar tidak diulang lagi
  // di dalam pohon supaya tidak tampil dua kali.
  const rootReadme = tree ? findRootReadme(tree) : null
  const rootHref = rootReadme ? docHref(rootReadme.path) : '#/'
  const onIndex = route.view === 'home' || Boolean(rootReadme && route.view === 'doc' && route.path === rootReadme.path)
  const onContents = route.view === 'alias'
  const rootNodes = tree ? (rootReadme ? tree.filter((node) => node.path !== rootReadme.path) : tree) : []

  const toggle = (path) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const renderNodes = (nodes) =>
    orderForIndex(nodes).map((node) =>
      node.type === 'dir' ? (
        <DirRow
          key={node.path}
          node={node}
          route={route}
          expanded={expanded}
          onToggle={toggle}
          renderNodes={renderNodes}
        />
      ) : (
        <FileRow key={node.path} node={node} route={route} />
      )
    )

  return (
    <aside id="sidebar" className={open ? 'sidebar is-open' : 'sidebar'} aria-label={t('app.sidebarLabel')}>
      <div className="sidebar-head">
        <div className="brand">
          <span className="brand-mark">knl-view</span>
          {meta && <span className="brand-source">{meta.name}</span>}
        </div>
        <button type="button" className="btn btn-plain sidebar-close" onClick={onClose}>
          {t('topbar.closeIndex')}
        </button>
      </div>

      <div className="sidebar-search">
        <label htmlFor="sidebar-filter">{t('sidebar.search')}</label>
        <input
          id="sidebar-filter"
          type="search"
          value={query}
          placeholder={t('sidebar.placeholder')}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <nav className="nav" aria-label={t('sidebar.structure')}>
        {!tree && status === 'loading' && (
          <p className="nav-note" role="status">
            {t('states.loadingIndex')}
          </p>
        )}
        {status === 'error' && (
          <p className="nav-note nav-note-error">{t('sidebar.indexUnavailable')}</p>
        )}
        {results && results.length === 0 && (
          <div className="nav-note">
            <p>
              {t('sidebar.noMatch')} <span className="mono">"{query.trim()}"</span>.
            </p>
            <button type="button" className="btn btn-plain" onClick={() => setQuery('')}>
              {t('sidebar.clearFilter')}
            </button>
          </div>
        )}
        {results && results.length > 0 && (
          <>
            <p className="nav-count" role="status">
              {countLabel(results.length, t('sidebar.files'))} {t('sidebar.matched')}
            </p>
            <ul className="nav-list" aria-label={t('sidebar.searchResults')}>
              {results.map((node) => (
                <li key={node.path}>
                  <a
                    className="nav-result"
                    href={docHref(node.path)}
                    aria-current={route.path === node.path ? 'page' : undefined}
                  >
                    <span className="nav-result-parent mono">
                      {node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : meta.name}
                    </span>
                    <span className="nav-result-name mono">{displayLabel(node)}</span>
                    {displaySub(node) && <span className="nav-result-title">{displaySub(node)}</span>}
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}
        {results === null && tree && (
          <>
            <ul className="nav-list nav-alias">
              <li className="nav-alias-item">
                <a
                  className={`nav-link${onIndex ? ' is-active' : ''}`}
                  href={rootHref}
                  aria-current={onIndex ? 'page' : undefined}
                >
                  {t('index.index')}
                </a>
              </li>
              <li className="nav-alias-item">
                <a
                  className={`nav-link${onContents ? ' is-active' : ''}`}
                  href={contentsHref()}
                  aria-current={onContents ? 'page' : undefined}
                >
                  {t('sidebar.contents')}
                </a>
              </li>
            </ul>
            <ul className="nav-list">{renderNodes(rootNodes)}</ul>
          </>
        )}
      </nav>

      {meta && (
        <div className="sidebar-foot">
          <span className="mono sidebar-root" title={meta.root}>
            {meta.root}
          </span>
          <span>
            {countLabel(meta.files, t('sidebar.files'))} · {countLabel(meta.dirs, t('sidebar.folder'))}
          </span>
        </div>
      )}
    </aside>
  )
}

function DirRow({ node, route, expanded, onToggle, renderNodes }) {
  const isCurrent = route.view === 'dir' && route.path === node.path
  const holdsRoute = route.view === 'doc' && isUnder(route.path, node.path)
  const isOpen = expanded.has(node.path)

  return (
    <li className="nav-dir">
      <div className="nav-row">
        <button
          type="button"
          className="disclose"
          aria-expanded={isOpen}
          onClick={() => onToggle(node.path)}
        >
          <span className="disclose-tri" aria-hidden="true" />
          <span className="sr-only">
            {isOpen ? t('sidebar.close') : t('sidebar.open')} folder {node.name}
          </span>
        </button>
        <a
          className={isCurrent || holdsRoute ? 'nav-name is-active' : 'nav-name'}
          href={dirHref(node.path)}
          aria-current={isCurrent ? 'page' : undefined}
        >
          {displayLabel(node)}/
        </a>
      </div>
      {isOpen && (
        <ul className="nav-list">
          {node.children.length === 0 ? (
            <li className="nav-note nav-note-tight">{t('sidebar.emptyFolder')}</li>
          ) : (
            renderNodes(node.children)
          )}
        </ul>
      )}
    </li>
  )
}

function FileRow({ node, route }) {
  const isCurrent = route.view === 'doc' && route.path === node.path
  return (
    <li className="nav-file">
      <a
        className={`nav-link${isCurrent ? ' is-active' : ''}`}
        href={docHref(node.path)}
        aria-current={isCurrent ? 'page' : undefined}
        title={node.title || node.name}
      >
        {displayLabel(node)}
      </a>
    </li>
  )
}
