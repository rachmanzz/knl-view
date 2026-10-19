import { useEffect, useMemo, useRef, useState } from 'react'
import { useKnowledge, useKnowledgeIndex } from '../knowledge.jsx'
import { fetchDoc } from '../api.js'
import { docHref, dirHref } from '../router.js'
import { prepareDocument, handleMarkdownClick, scrollToId, takePendingAnchor } from '../markdown.js'
import { formatBytes, formatDateTime } from '../format.js'
import Breadcrumb from '../components/Breadcrumb.jsx'
import Toc from '../components/Toc.jsx'
import { ErrorState, Loading } from '../components/States.jsx'
import { t } from '../i18n.js'
import { displayLabel, displaySub } from '../label.js'
import { renderMermaid } from '../mermaid.js'

export default function DocView({ route }) {
  const { version, tree } = useKnowledge()
  const index = useKnowledgeIndex()
  const node = index?.nodes.get(route.path)
  const [state, setState] = useState({ status: 'loading', doc: null, error: null })
  const [attempt, setAttempt] = useState(0)
  const [activeId, setActiveId] = useState(null)

  useEffect(() => {
    if (!node) return undefined
    let alive = true
    setState({ status: 'loading', doc: null, error: null })
    fetchDoc(route.path)
      .then((doc) => {
        if (alive) setState({ status: 'ready', doc, error: null })
      })
      .catch((err) => {
        if (alive) setState({ status: 'error', doc: null, error: err.message })
      })
    return () => {
      alive = false
    }
  }, [route.path, version, attempt, node])

  const prepared = useMemo(() => {
    if (!index || state.status !== 'ready') return null
    const baseDir = route.path.split('/').slice(0, -1).join('/')
    return prepareDocument({
      content: state.doc.content,
      baseDir,
      files: index.files,
      dirs: index.dirs
    })
  }, [index, state, route.path])

  const headings = prepared?.headings || []
  const mdRef = useRef(null)

  useEffect(() => {
    renderMermaid(mdRef.current)
  }, [prepared])

  useEffect(() => {
    if (!prepared) return undefined
    const pending = takePendingAnchor()
    if (pending) requestAnimationFrame(() => scrollToId(pending))
    return undefined
  }, [prepared])

  useEffect(() => {
    if (headings.length < 2) return undefined
    const targets = headings
      .map((heading) => document.getElementById(heading.id))
      .filter(Boolean)
    if (!targets.length) return undefined

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible[0]) setActiveId(visible[0].target.id)
      },
      { rootMargin: '-88px 0px -55% 0px', threshold: 0 }
    )
    targets.forEach((target) => observer.observe(target))
    return () => observer.disconnect()
  }, [headings])

  const siblings = useMemo(() => {
    if (!index || !node) return []
    const parentPath = route.path.split('/').slice(0, -1).join('/')
    const parentNode = parentPath ? index.nodes.get(parentPath) : { children: tree }
    return (parentNode?.children || []).filter((child) => child.type === 'file')
  }, [index, node, route.path, tree])

  if (!node) {
    return (
      <div className="reading">
        <article className="doc">
          <Breadcrumb kind="doc" path={route.path} />
          <ErrorState
            title={t('doc.notFound')}
            detail={`"${route.path}" is not in the knowledge base index. The file may have been moved or deleted.`}
          >
            <a className="btn" href="#/">
              {t('app.backHome')}
            </a>
          </ErrorState>
        </article>
      </div>
    )
  }

  if (state.status === 'loading') {
    return (
      <div className="reading">
        <article className="doc">
          <Breadcrumb kind="doc" path={route.path} />
          <Loading label={`${t('topbar.loading')} ${route.path}...`} />
        </article>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="reading">
        <article className="doc">
          <Breadcrumb kind="doc" path={route.path} />
          <ErrorState title={t('doc.loadFailed')} detail={state.error}>
            <button type="button" className="btn" onClick={() => setAttempt((value) => value + 1)}>
              {t('states.retry')}
            </button>
            <a className="btn btn-plain" href={dirHref(route.path.split('/').slice(0, -1).join('/'))}>
              {t('doc.openParent')}
            </a>
          </ErrorState>
        </article>
      </div>
    )
  }

  const position = siblings.findIndex((sibling) => sibling.path === route.path)
  const previous = position > 0 ? siblings[position - 1] : null
  const next = position >= 0 && position < siblings.length - 1 ? siblings[position + 1] : null

  return (
    <div className="reading">
      <article className="doc">
        <Breadcrumb kind="doc" path={route.path} />

        <header className="doc-head">
          <p className="doc-meta">
            <span className="mono">{route.path}</span>
            <span>{formatBytes(state.doc.size)}</span>
            <span>
              {t('doc.updated')} {formatDateTime(state.doc.mtime)}
            </span>
          </p>
          {!prepared.hasH1 && <h1 className="doc-title">{node.title || node.name}</h1>}
        </header>

        <Toc
          variant="inline"
          headings={headings}
          activeId={activeId}
          onSelect={scrollToId}
        />

        <div
          ref={mdRef}
          className="md"
          onClick={handleMarkdownClick}
          dangerouslySetInnerHTML={{ __html: prepared.html }}
        />

        {(previous || next) && (
          <nav className="doc-pager" aria-label={t('doc.pagerLabel')}>
            {previous ? (
              <a className="pager-link pager-prev" href={docHref(previous.path)}>
                <span className="pager-label">{t('doc.prev')}</span>
                <span className="pager-name mono">{displayLabel(previous)}</span>
                {displaySub(previous) && <span className="pager-title">{displaySub(previous)}</span>}
              </a>
            ) : (
              <span className="pager-gap" />
            )}
            {next && (
              <a className="pager-link pager-next" href={docHref(next.path)}>
                <span className="pager-label">{t('doc.next')}</span>
                <span className="pager-name mono">{displayLabel(next)}</span>
                {displaySub(next) && <span className="pager-title">{displaySub(next)}</span>}
              </a>
            )}
          </nav>
        )}
      </article>

      <Toc variant="rail" headings={headings} activeId={activeId} onSelect={scrollToId} />
    </div>
  )
}
