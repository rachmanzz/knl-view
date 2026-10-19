import { displayLabel, displaySub } from '../label.js'

export default function IndexRow({ href, node, title, mono = false, sub, meta, current = false, muted = false }) {
  const label = node ? (node.type === 'dir' ? `${displayLabel(node)}/` : displayLabel(node)) : title
  const secondary = node ? displaySub(node) : sub
  return (
    <a
      className={`index-row${current ? ' is-current' : ''}${muted ? ' is-muted' : ''}`}
      href={href}
      aria-current={current ? 'page' : undefined}
    >
      <span className={mono ? 'index-title mono' : 'index-title'}>{label}</span>
      <span className="index-leader" aria-hidden="true" />
      <span className="index-meta">{meta}</span>
      {secondary && <span className="index-sub">{secondary}</span>}
    </a>
  )
}
