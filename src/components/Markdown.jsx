import { useEffect, useMemo, useRef } from 'react'
import { prepareDocument, handleMarkdownClick } from '../markdown.js'
import { useKnowledgeIndex } from '../knowledge.jsx'
import { renderMermaid } from '../mermaid.js'

export default function Markdown({ source, baseDir = '' }) {
  const index = useKnowledgeIndex()
  const ref = useRef(null)

  const prepared = useMemo(() => {
    if (!index) return { html: '' }
    return prepareDocument({ content: source, baseDir, files: index.files, dirs: index.dirs })
  }, [source, baseDir, index])

  useEffect(() => {
    renderMermaid(ref.current)
  }, [prepared])

  return (
    <div
      ref={ref}
      className="md"
      onClick={handleMarkdownClick}
      dangerouslySetInnerHTML={{ __html: prepared.html }}
    />
  )
}
