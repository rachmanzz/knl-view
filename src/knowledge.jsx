import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from 'react'
import { fetchMeta, fetchTree } from './api.js'
import { indexTree } from './tree.js'

const KnowledgeContext = createContext(null)

export function KnowledgeProvider({ children }) {
  const [state, setState] = useState({
    status: 'loading',
    meta: null,
    tree: null,
    error: null,
    notice: null,
    version: 0
  })

  const reload = useCallback(async () => {
    setState((prev) => ({ ...prev, error: null }))
    try {
      const [meta, tree] = await Promise.all([fetchMeta(), fetchTree()])
      setState((prev) => ({
        status: 'ready',
        meta,
        tree,
        error: null,
        notice: null,
        version: prev.version + 1
      }))
    } catch (err) {
      setState((prev) =>
        prev.tree
          ? { ...prev, notice: err.message }
          : { ...prev, status: 'error', error: err.message }
      )
    }
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const value = useMemo(() => ({ ...state, reload }), [state, reload])
  return <KnowledgeContext.Provider value={value}>{children}</KnowledgeContext.Provider>
}

export function useKnowledge() {
  return useContext(KnowledgeContext)
}

export function useKnowledgeIndex() {
  const { tree } = useKnowledge()
  return useMemo(() => (tree ? indexTree(tree) : null), [tree])
}
