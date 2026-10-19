import { useEffect, useMemo, useState } from 'react'
import { useKnowledge, useKnowledgeIndex } from '../knowledge.jsx'
import { fetchDoc } from '../api.js'
import { docHref, dirHref } from '../router.js'
import { countFilesRecursive, directDirs, directFiles, findReadme, orderForIndex, subtreeMtime } from '../tree.js'
import { countLabel, formatBytes, formatDateTime } from '../format.js'
import Breadcrumb from '../components/Breadcrumb.jsx'
import IndexRow from '../components/IndexRow.jsx'
import Markdown from '../components/Markdown.jsx'
import { EmptyState, ErrorState, Loading } from '../components/States.jsx'
import { t } from '../i18n.js'

export default function FolderView({ route }) {
  const { version } = useKnowledge()
  const index = useKnowledgeIndex()
  const node = index?.nodes.get(route.path)
  const [readme, setReadme] = useState({ status: 'idle', content: null, error: null })

  const readmeNode = node?.type === 'dir' ? findReadme(node) : null

  useEffect(() => {
    if (!readmeNode) {
      setReadme({ status: 'idle', content: null, error: null })
      return
    }
    let alive = true
    setReadme({ status: 'loading', content: null, error: null })
    fetchDoc(readmeNode.path)
      .then((doc) => {
        if (alive) setReadme({ status: 'ready', content: doc.content, error: null })
      })
      .catch((err) => {
        if (alive) setReadme({ status: 'error', content: null, error: err.message })
      })
    return () => {
      alive = false
    }
  }, [readmeNode?.path, version])

  if (!node || node.type !== 'dir') {
    return (
      <article className="folder">
        <ErrorState
          title={t('folder.notFound')}
          detail={t('folder.notFoundDetail').replace('{path}', route.path)}
        >
          <a className="btn" href="#/">
            {t('app.backHome')}
          </a>
        </ErrorState>
      </article>
    )
  }

  const files = orderForIndex(directFiles(node)).filter((file) => file.path !== readmeNode?.path)
  const dirs = orderForIndex(directDirs(node))
  const isEmpty = files.length === 0 && dirs.length === 0 && !readmeNode

  return (
    <article className="folder">
      <Breadcrumb kind="dir" path={route.path} />

      <header className="folder-head">
        <h1 className="folder-title">
          <span className="mono">{node.name}/</span>
        </h1>
        <p className="folder-meta">
          <span>{countLabel(countFilesRecursive(node), t('home.files'))}</span>
          <span>
            {t('doc.updated')} {formatDateTime(subtreeMtime(node))}
          </span>
        </p>
      </header>

      {readme.status === 'loading' && <Loading label={t('folder.loadingReadme')} />}
      {readme.status === 'error' && (
        <p className="inline-note" role="status">
          {t('folder.readmeFailed')} {readme.error}
        </p>
      )}
      {readme.status === 'ready' && <Markdown source={readme.content} baseDir={route.path} />}

      {isEmpty && (
        <EmptyState
          level={2}
          title={`${t('folder.empty')} ${node.name}/`}
          detail={t('folder.noFiles')}
        >
          <button type="button" className="btn" onClick={() => window.location.reload()}>
            {t('folder.reload')}
          </button>
          <a className="btn btn-plain" href="#/">
            {t('app.backHome')}
          </a>
        </EmptyState>
      )}

      {files.length > 0 && (
        <section aria-labelledby="folder-files-heading">
          <h2 className="section-head" id="folder-files-heading">
            {t('folder.files')}
          </h2>
          <div className="index-list">
            {files.map((file) => (
              <IndexRow
                key={file.path}
                node={file}
                href={docHref(file.path)}
                mono
                meta={formatBytes(file.size)}
              />
            ))}
          </div>
        </section>
      )}

      {dirs.length > 0 && (
        <section aria-labelledby="folder-dirs-heading">
          <h2 className="section-head" id="folder-dirs-heading">
            {t('folder.subfolders')}
          </h2>
          <div className="index-list">
            {dirs.map((dir) => (
              <IndexRow
                key={dir.path}
                node={dir}
                href={dirHref(dir.path)}
                mono
                meta={countLabel(countFilesRecursive(dir), t('home.files'))}
                muted={countFilesRecursive(dir) === 0}
              />
            ))}
          </div>
        </section>
      )}
    </article>
  )
}
