import { useKnowledge } from '../knowledge.jsx'
import { dirHref } from '../router.js'
import { t } from '../i18n.js'

export default function Breadcrumb({ kind, path }) {
  const { meta } = useKnowledge()
  const segments = path.split('/').filter(Boolean)
  const crumbs = [{ label: meta.name, href: '#/' }]

  let acc = ''
  segments.forEach((segment, i) => {
    acc = acc ? `${acc}/${segment}` : segment
    const last = i === segments.length - 1
    const isFileTail = last && kind === 'doc'
    crumbs.push({ label: segment, href: isFileTail ? null : dirHref(acc), current: isFileTail || (last && kind === 'dir') })
  })

  return (
    <nav className="crumbs" aria-label={t('app.fileLocation')}>
      <ol>
        {crumbs.map((crumb, i) => (
          <li key={`${crumb.label}-${i}`}>
            {i > 0 && (
              <span className="crumb-sep" aria-hidden="true">
                /
              </span>
            )}
            {crumb.href && !crumb.current ? (
              <a className="crumb mono" href={crumb.href}>
                {crumb.label}
              </a>
            ) : (
              <span className="crumb crumb-current mono" aria-current={crumb.current ? 'page' : undefined}>
                {crumb.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}
