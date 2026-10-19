import { useKnowledge } from '../knowledge.jsx'
import { docHref, dirHref } from '../router.js'
import { countFilesRecursive, findRootReadme, orderForIndex } from '../tree.js'
import { countLabel, formatBytes } from '../format.js'
import IndexRow from '../components/IndexRow.jsx'
import { t } from '../i18n.js'

// Rute alias `#/a/contents`: daftar isi seluruh basis. Isinya lahir dari
// pohon yang sudah disaring server (entri `ignore` di map.json tidak pernah
// sampai ke sini) dan sudah memakai judul ganti dari map.json.
export default function Contents() {
  const { meta, tree } = useKnowledge()

  const rootReadme = findRootReadme(tree)
  const sections = orderForIndex(tree).filter((node) => node.type === 'dir')
  const documents = orderForIndex(tree).filter(
    (node) => node.type === 'file' && node.path !== rootReadme?.path
  )

  return (
    <article className="folder">
      <header className="folder-head">
        <h1 className="folder-title">{t('home.contents')}</h1>
        <p className="folder-meta">
          <span>{countLabel(meta.files, t('home.files'))}</span>
          <span>{countLabel(meta.dirs, t('home.folders'))}</span>
        </p>
      </header>

      {sections.length > 0 && (
        <section aria-labelledby="contents-sections-heading">
          <h2 className="section-head" id="contents-sections-heading">
            {t('folder.sections')}
          </h2>
          <div className="index-list">
            {sections.map((dir) => (
              <DirBranch key={dir.path} node={dir} />
            ))}
          </div>
        </section>
      )}

      {documents.length > 0 && (
        <section aria-labelledby="contents-docs-heading">
          <h2 className="section-head" id="contents-docs-heading">
            {t('folder.documents')}
          </h2>
          <div className="index-list">
            {documents.map((file) => (
              <FileBranch key={file.path} node={file} />
            ))}
          </div>
        </section>
      )}
    </article>
  )
}

function DirBranch({ node }) {
  const count = countFilesRecursive(node)
  return (
    <div className="index-branch">
      <IndexRow
        node={node}
        href={dirHref(node.path)}
        mono
        meta={countLabel(count, t('home.files'))}
        muted={count === 0}
      />
      {node.children.length > 0 && (
        <div className="index-children">
          {orderForIndex(node.children).map((child) =>
            child.type === 'dir' ? (
              <DirBranch key={child.path} node={child} />
            ) : (
              <FileBranch key={child.path} node={child} />
            )
          )}
        </div>
      )}
    </div>
  )
}

function FileBranch({ node }) {
  return (
    <IndexRow
      node={node}
      href={docHref(node.path)}
      mono
      meta={formatBytes(node.size)}
    />
  )
}
