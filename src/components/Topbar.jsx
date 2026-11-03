export default function Topbar({ title, navOpen, onToggleNav, onReload, reloading, toggleRef }) {
  return (
    <header className="topbar">
      <button
        type="button"
        ref={toggleRef}
        className="btn btn-plain topbar-menu"
        aria-expanded={navOpen}
        aria-controls="sidebar"
        onClick={onToggleNav}
      >
        Index
      </button>
      <span className="topbar-title" title={title}>
        {title}
      </span>
      <button type="button" className="btn btn-plain" onClick={onReload} disabled={reloading}>
        {reloading ? 'Loading' : 'Reload'}
      </button>
    </header>
  )
}
