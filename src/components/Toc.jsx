import { scrollToId } from '../markdown.js'
import { t } from '../i18n.js'

export default function Toc({ headings, activeId, onSelect, variant = 'rail' }) {
  const items = headings.filter((heading) => heading.level <= 3)
  if (items.length < 2) return null

  const list = (
    <ol className="toc-list">
      {items.map((heading) => (
        <li key={heading.id} className={`toc-item toc-level-${heading.level}`}>
          <button
            type="button"
            className={activeId === heading.id ? 'toc-link is-active' : 'toc-link'}
            aria-current={activeId === heading.id ? 'true' : undefined}
            onClick={() => onSelect(heading.id)}
          >
            {heading.text}
          </button>
        </li>
      ))}
    </ol>
  )

  if (variant === 'inline') {
    return (
      <details className="toc toc-inline">
        <summary>{t('toc.contentsShort')}</summary>
        {list}
      </details>
    )
  }

  return (
    <aside className="toc toc-rail" aria-label={t('toc.contents')}>
      <p className="section-head">Contents</p>
      {list}
    </aside>
  )
}

export { scrollToId }
