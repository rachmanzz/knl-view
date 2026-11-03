import { useEffect, useMemo, useRef, useState } from 'react'
import { KnowledgeProvider, useKnowledge, useKnowledgeIndex } from './knowledge.jsx'
import { useRoute } from './router.js'
import Sidebar from './components/Sidebar.jsx'
import Topbar from './components/Topbar.jsx'
import Home from './views/Home.jsx'
import FolderView from './views/FolderView.jsx'
import DocView from './views/DocView.jsx'
import Contents from './views/Contents.jsx'
import { ErrorState, Loading } from './components/States.jsx'

// A README file serves as the folder index. Opening it directly displays
// identically to opening that folder: the route remains the file route
// (no redirect), but the presentation uses the folder view.
function readmeParent(path) {
  if (!/(^|\/)readme(\.(md|markdown|prd))?$/i.test(path)) return null
  return path.split('/').slice(0, -1).join('/')
}

function DocRoute({ route }) {
  const parent = readmeParent(route.path)
  if (parent === null) return <DocView route={route} />
  if (!parent) return <Home />
  return <FolderView route={{ ...route, view: 'dir', path: parent }} />
}

export default function App() {
  return (
    <KnowledgeProvider>
      <Shell />
    </KnowledgeProvider>
  )
}

function Shell() {
  const route = useRoute()
  const { status, error, meta, notice, reload } = useKnowledge()
  const index = useKnowledgeIndex()
  const [navOpen, setNavOpen] = useState(false)
  const [reloading, setReloading] = useState(false)
  const toggleRef = useRef(null)
  const hadOpen = useRef(false)

  useEffect(() => {
    setNavOpen(false)
    window.scrollTo(0, 0)
  }, [route.key])

  useEffect(() => {
    if (!navOpen) return undefined
    hadOpen.current = true
    const isDrawer = window.matchMedia('(max-width: 60rem)').matches
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setNavOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    const previousOverflow = document.body.style.overflow
    if (isDrawer) document.body.style.overflow = 'hidden'
    document.querySelector('#sidebar .sidebar-close')?.focus()

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [navOpen])

  useEffect(() => {
    if (navOpen || !hadOpen.current) return
    hadOpen.current = false
    toggleRef.current?.focus()
  }, [navOpen])

  const title = useMemo(() => {
    if (route.view === 'home') return 'Home'
    if (route.view === 'alias') return 'Contents'
    if (route.view === 'notfound') return 'Page not found.'
    const node = index?.nodes.get(route.path)
    return node?.title || node?.name || route.path
  }, [route, index])

  useEffect(() => {
    document.title = `${title} · knl-view`
  }, [title])

  const onReload = async () => {
    setReloading(true)
    await reload()
    setReloading(false)
  }

  const skipToContent = (event) => {
    event.preventDefault()
    const content = document.getElementById('content')
    content?.focus()
    content?.scrollIntoView({ block: 'start' })
  }

  return (
    <>
      <a className="skip" href="#content" onClick={skipToContent}>
        Skip to content
      </a>

      <div className="shell">
        <Sidebar route={route} open={navOpen} onClose={() => setNavOpen(false)} />
        {navOpen && <div className="scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />}

        <div className="main-col">
          <Topbar
            title={title}
            navOpen={navOpen}
            toggleRef={toggleRef}
            onToggleNav={() => setNavOpen((value) => !value)}
            onReload={onReload}
            reloading={reloading}
          />

          {notice && (
            <p className="banner" role="status">
              Index reload failed: {notice}
            </p>
          )}

          <main id="content" className="content" tabIndex={-1}>
            {status === 'loading' && <Loading label="Loading file index..." />}

            {status === 'error' && (
              <ErrorState title="Index failed to load." detail={`${error} Make sure knl-view is running, then try again.`}>
                <button type="button" className="btn" onClick={onReload}>
                  Retry
                </button>
              </ErrorState>
            )}

            {status === 'ready' && route.view === 'home' && <Home />}
            {status === 'ready' && route.view === 'dir' && <FolderView route={route} />}
            {status === 'ready' && route.view === 'doc' && <DocRoute route={route} />}
            {status === 'ready' && route.view === 'alias' && <Contents />}

            {status === 'ready' && route.view === 'notfound' && (
              <ErrorState
                title="Page not found."
                detail={`Route "${route.path}" is not recognized by the viewer.`}
              >
                <a className="btn" href="#/">
                  Back to home
                </a>
              </ErrorState>
            )}
          </main>

          <footer className="site-foot">
            {meta && (
              <>
                <span className="mono">knl-view</span>
                <span className="mono" title={meta.root}>
                  {meta.root}
                </span>
                <span className="mono">{meta.address}</span>
              </>
            )}
          </footer>
        </div>
      </div>
    </>
  )
}
