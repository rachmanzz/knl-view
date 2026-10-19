import { useEffect, useMemo, useState } from 'react'
import { useKnowledge } from '../knowledge.jsx'
import { fetchDoc } from '../api.js'
import { docHref, dirHref } from '../router.js'
import { allFiles, countFilesRecursive, findRootReadme, orderForIndex } from '../tree.js'
import { countLabel, formatBytes, formatDateTime, formatDate } from '../format.js'
import IndexRow from '../components/IndexRow.jsx'
import { EmptyState } from '../components/States.jsx'
import Markdown from '../components/Markdown.jsx'
import { t } from '../i18n.js'
import { displayLabel } from '../label.js'

export default function Home() {
  const { meta, tree } = useKnowledge()
  const [readmeContent, setReadmeContent] = useState(null)

  const readme = findRootReadme(tree)
  const sections = orderForIndex(tree).filter((node) => node.type === 'dir')
  const documents = orderForIndex(tree).filter((node) => node.type === 'file')

  const recent = useMemo(
    () => allFiles(tree).sort((a, b) => b.mtime - a.mtime).slice(0, 6),
    [tree]
  )

  useEffect(() => {
    if (!readme) {
      setReadmeContent(null)
      return
    }
    let alive = true
    fetchDoc(readme.path)
      .then((doc) => {
        if (alive) setReadmeContent(doc.content)
      })
      .catch(() => {
        if (alive) setReadmeContent(null)
      })
    return () => {
      alive = false
    }
  }, [readme?.path])

  return (
    <section className="home">
      <header className="masthead">
        <p className="eyebrow">{t('home.knowledgeBase')}</p>
        <h1>{meta.map?.title || readme?.title || meta.name}</h1>
        <p className="masthead-meta">
          <span>{countLabel(meta.files, t('home.files'))}</span>
          <span>{countLabel(meta.dirs, t('home.folders'))}</span>
          <span>
            {t('home.lastUpdated')} {formatDateTime(meta.newest)}
          </span>
        </p>
      </header>

      {readmeContent && (
        <section className="home-readme" aria-labelledby="home-readme-heading">
          <h2 className="section-head" id="home-readme-heading">
            {t('home.contents')}
          </h2>
          <Markdown source={readmeContent} baseDir="" />
        </section>
      )}

      <div className="home-grid">
        <section aria-labelledby="home-index-heading">
          <h2 className="section-head" id="home-index-heading">
            {t('home.toc')}
          </h2>

          {tree.length === 0 && (
            <EmptyState
              level={2}
              title={t('home.emptyArchive')}
              detail={`${t('home.noContent')} ${meta.root}`}
            />
          )}

          {sections.length > 0 && (
            <div className="index-group">
              <p className="group-label">{t('folder.sections')}</p>
              <div className="index-list">
                {sections.map((dir) => (
                  <div key={dir.path} className="index-branch">
                    <IndexRow
                      node={dir}
                      href={dirHref(dir.path)}
                      mono
                      meta={countLabel(countFilesRecursive(dir), t('home.files'))}
                      muted={countFilesRecursive(dir) === 0}
                    />
                    {dir.children.length > 0 && (
                      <div className="index-children">
                        {orderForIndex(dir.children).map((child) =>
                          child.type === 'file' ? (
                            <IndexRow
                              key={child.path}
                              node={child}
                              href={docHref(child.path)}
                              mono
                              meta={formatBytes(child.size)}
                            />
                          ) : (
                            <IndexRow
                              key={child.path}
                              node={child}
                              href={dirHref(child.path)}
                              mono
                              meta={countLabel(countFilesRecursive(child), t('home.files'))}
                              muted={countFilesRecursive(child) === 0}
                            />
                          )
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {documents.length > 0 && (
            <div className="index-group">
              <p className="group-label">{t('folder.documents')}</p>
              <div className="index-list">
                {documents.map((file) => (
                  <IndexRow
                    key={file.path}
                    node={file}
                    href={docHref(file.path)}
                    mono
                    meta={formatBytes(file.size)}
                  />
                ))}
              </div>
            </div>
          )}
        </section>

        <section className="home-recent" aria-labelledby="home-recent-heading">
          <h2 className="section-head" id="home-recent-heading">
            {t('home.recentlyChanged')}
          </h2>
          {recent.length === 0 ? (
            <p className="nav-note">{t('home.noContent')}</p>
          ) : (
            <ol className="recent-list">
              {recent.map((file) => (
                <li key={file.path}>
                  <a href={docHref(file.path)}>
                    <span className="recent-title">{displayLabel(file)}</span>
                    <span className="recent-meta">
                      <span className="mono">{file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : file.name}</span>
                      <span>{formatDate(file.mtime)}</span>
                    </span>
                  </a>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </section>
  )
}
