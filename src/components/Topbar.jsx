import { useEffect, useState } from 'react'
import { t, getLang, setLang, onLangChange } from '../i18n.js'

export default function Topbar({ title, navOpen, onToggleNav, onReload, reloading, toggleRef }) {
  const [lang, setLangState] = useState(getLang())
  useEffect(() => onLangChange(() => setLangState(getLang())), [])
  const toggle = () => {
    const next = lang === 'en' ? 'id' : 'en'
    setLang(next)
  }
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
        {t('topbar.index')}
      </button>
      <span className="topbar-title" title={title}>
        {title}
      </span>
      <button type="button" className="btn btn-plain" onClick={onReload} disabled={reloading}>
        {reloading ? t('topbar.loading') : t('topbar.reload')}
      </button>
      <button
        type="button"
        className="btn btn-plain"
        onClick={toggle}
        title={lang === 'en' ? 'Switch to Indonesian' : 'Switch to English'}
      >
        {lang === 'en' ? 'ID' : 'EN'}
      </button>
    </header>
  )
}
