import { t, onLangChange } from './i18n.js'

// A ```mermaid fence inside .md is rendered as an SVG diagram.
// The mermaid module is lazy-loaded: it is only downloaded when a mermaid
// fence exists, keeping the main bundle small for bases without diagrams.

let mermaidPromise = null
let uid = 0
let activeModal = null

// Flowchart node color pairs: pale pastel fill + alternating bright border,
// matching the mermaid palette in the reference screenshot (pink, light blue, etc).
const NODE_PALETTE = [
  { fill: '#FDF4FF', border: '#E879F9' },
  { fill: '#F0FDFA', border: '#2DD4BF' },
  { fill: '#FEF2F2', border: '#F87171' },
  { fill: '#F0F9FF', border: '#38BDF8' },
  { fill: '#F0FDF4', border: '#4ADE80' },
]

const FLOWCHART_STOP = new Set([
  'graph', 'flowchart', 'subgraph', 'end', 'direction',
  'classDef', 'class', 'style', 'linkStyle', 'click',
  'accTitle', 'accDescr', 'LR', 'RL', 'TD', 'TB', 'BT',
])

// Collect flowchart node ids from the source. Comments, labels, and strings
// are stripped first so only ids remain; mermaid quietly ignores unknown ids
// in a `class` directive, so this loose extraction is safe.
function flowchartNodeIds(src) {
  const cleaned = src
    .replace(/%%[^\n]*/g, ' ')
    .replace(/"[^"\n]*"/g, '""')
    .replace(/\|[^|\n]*\|/g, '||')
    .replace(/\[\[?[^\]]*\]\]?/g, '[]')
    .replace(/\{[^{}]*\}/g, '{}')
    .replace(/\([^()]*\)/g, '()')
  const subgraphIds = new Set(
    [...src.matchAll(/^\s*subgraph\s+([A-Za-z_][A-Za-z0-9_]*)/gm)].map((m) => m[1]),
  )
  const ids = []
  const seen = new Set()
  for (const m of cleaned.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
    const id = m[0]
    if (FLOWCHART_STOP.has(id) || subgraphIds.has(id) || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

// Embed flowchart node coloring without changing the displayed source.
// Only flowcharts are colored; other diagrams (sequence, class, etc) are
// already colored by their own theme.
function withNodeColors(src) {
  if (!/^\s*(?:flowchart|graph)\b/m.test(src)) return src
  const ids = flowchartNodeIds(src)
  if (!ids.length) return src
  const defs = NODE_PALETTE.map(
    (c, i) => `classDef knl${i} fill:${c.fill},stroke:${c.border},stroke-width:2px,color:#28253D`,
  ).join('\n')
  const classes = ids
    .map((id, i) => `class ${id} knl${i % NODE_PALETTE.length}`)
    .join('\n')
  return `${src}\n${defs}\n${classes}`
}

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => {
      const mermaid = m.default
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        // Mermaid colorful theme: pale pastel fill + alternating bright border,
        // dark ink, rounded corners, soft shadow, roomy node/rank spacing.
        theme: 'redux-color',
        themeVariables: {
          fontFamily: 'Helvetica, Arial, sans-serif',
          fontSize: '14px',
          lineColor: '#28253D',
          arrowheadColor: '#28253D',
          edgeLabelBackground: '#ffffff',
        },
        flowchart: { curve: 'cardinal', nodeSpacing: 90, rankSpacing: 120, padding: 20 },
      })
      return mermaid
    })
  }
  return mermaidPromise
}

export function renderMermaid(root) {
  if (!root || typeof document === 'undefined') return
  const pending = [...root.querySelectorAll('code.language-mermaid:not([data-mermaid])')]
  if (!pending.length) return
  // Mark first, before await: double effects (StrictMode, re-render) must not duplicate work.
  for (const code of pending) code.dataset.mermaid = 'pending'
  void renderAll(pending)
}

async function renderAll(codes) {
  let mermaid
  try {
    mermaid = await loadMermaid()
  } catch {
    for (const code of codes) failNote(code)
    return
  }

  for (const code of codes) {
    // React has swapped the DOM by the time rendering finished; the next effect will process the new nodes.
    if (!code.isConnected) continue
    const pre = code.closest('pre')
    if (!pre) continue
    const source = code.textContent
    const id = `knl-mermaid-${++uid}`

    let svg = ''
    try {
      // Colored source is for rendering only; the "Show source" view stays original.
      svg = (await mermaid.render(id, withNodeColors(source))).svg
    } catch {
      try {
        svg = (await mermaid.render(`${id}-plain`, source)).svg
      } catch {
        document.getElementById(id)?.remove()
        document.getElementById(`${id}-plain`)?.remove()
        failNote(code)
        continue
      }
    }
    document.getElementById(id)?.remove()
    document.getElementById(`${id}-plain`)?.remove()
    if (!code.isConnected) continue

    const figure = document.createElement('figure')
    figure.className = 'mermaid-block'
    figure.dataset.view = 'diagram'

    const diagram = document.createElement('div')
    diagram.className = 'mermaid-diagram'
    diagram.innerHTML = svg

    const preSource = document.createElement('pre')
    preSource.className = 'mermaid-source'
    const codeSource = document.createElement('code')
    codeSource.className = 'language-mermaid'
    codeSource.dataset.mermaid = 'done'
    codeSource.textContent = source
    preSource.append(codeSource)

    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'btn btn-plain mermaid-toggle'
    toggle.textContent = t('mermaid.showSource')
    toggle.addEventListener('click', () => {
      const showSource = figure.dataset.view === 'diagram'
      figure.dataset.view = showSource ? 'source' : 'diagram'
      toggle.textContent = t(showSource ? 'mermaid.hideSource' : 'mermaid.showSource')
    })

    const zoom = document.createElement('button')
    zoom.type = 'button'
    zoom.className = 'btn btn-plain mermaid-zoom-btn'
    zoom.textContent = t('mermaid.zoom')
    zoom.addEventListener('click', () => openZoom(diagram, zoom))

    const actions = document.createElement('div')
    actions.className = 'mermaid-actions'
    actions.append(toggle, zoom)

    figure.append(diagram, preSource, actions)
    pre.replaceWith(figure)
  }
}

// Syntax error: leave the code block as is, add a small note.
function failNote(code) {
  const pre = code.closest('pre')
  code.dataset.mermaid = 'error'
  if (!pre || pre.previousElementSibling?.classList.contains('mermaid-note')) return
  const note = document.createElement('p')
  note.className = 'inline-note mermaid-note'
  note.textContent = t('mermaid.failed')
  pre.before(note)
}

// --- Zoom modal: one diagram enlarged full-screen, scroll to zoom,
// --- drag to pan, +/−/Reset buttons as touch/click controls. ---

function openZoom(diagram, trigger) {
  closeZoom()

  const backdrop = document.createElement('div')
  backdrop.className = 'mermaid-modal'
  backdrop.setAttribute('role', 'dialog')
  backdrop.setAttribute('aria-modal', 'true')

  const bar = document.createElement('div')
  bar.className = 'mermaid-modal-bar'

  const stage = document.createElement('div')
  stage.className = 'mermaid-modal-stage'

  const canvas = document.createElement('div')
  canvas.className = 'mermaid-modal-canvas'
  const svg = diagram.querySelector('svg')?.cloneNode(true)
  if (svg) canvas.append(svg)
  stage.append(canvas)
  backdrop.append(bar, stage)

  let scale = 1
  let x = 0
  let y = 0
  const MIN_SCALE = 0.2
  const MAX_SCALE = 8

  const apply = () => {
    canvas.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
    scaleLabel.textContent = `${Math.round(scale * 100)}%`
  }

  // Zoom around the point (mx, my) relative to the stage: the point under
  // the cursor stays in the same place while the scale changes.
  const zoomAt = (mx, my, factor) => {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor))
    const k = next / scale
    x = mx - (mx - x) * k
    y = my - (my - y) * k
    scale = next
    apply()
  }

  const zoomAtCenter = (factor) => {
    const r = stage.getBoundingClientRect()
    zoomAt(r.width / 2, r.height / 2, factor)
  }

  const scaleLabel = document.createElement('span')
  scaleLabel.className = 'mermaid-modal-scale mono'

  const btnOut = modalBtn('out', '−', t('mermaid.zoomOut'), () => zoomAtCenter(1 / 1.25))
  const btnIn = modalBtn('in', '+', t('mermaid.zoomIn'), () => zoomAtCenter(1.25))
  const btnReset = modalBtn('reset', t('mermaid.reset'), t('mermaid.reset'), () => {
    scale = 1
    x = 0
    y = 0
    apply()
  })
  const btnClose = modalBtn('close', t('mermaid.close'), t('mermaid.close'), closeZoom)
  bar.append(btnOut, scaleLabel, btnIn, btnReset, btnClose)

  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      const r = stage.getBoundingClientRect()
      zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.15 : 1 / 1.15)
    },
    { passive: false }
  )

  let dragging = false
  let px = 0
  let py = 0
  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    dragging = true
    px = e.clientX
    py = e.clientY
    stage.setPointerCapture(e.pointerId)
    stage.classList.add('is-dragging')
  })
  stage.addEventListener('pointermove', (e) => {
    if (!dragging) return
    x += e.clientX - px
    y += e.clientY - py
    px = e.clientX
    py = e.clientY
    apply()
  })
  const stopDrag = () => {
    dragging = false
    stage.classList.remove('is-dragging')
  }
  stage.addEventListener('pointerup', stopDrag)
  stage.addEventListener('pointercancel', stopDrag)

  // Clicking the backdrop closes; clicking the stage (panning) does not.
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeZoom()
  })

  // Focus trap: Tab only cycles through the toolbar buttons.
  backdrop.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return
    const buttons = [...bar.querySelectorAll('button')]
    const first = buttons[0]
    const last = buttons[buttons.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  })

  const onDocKey = (e) => {
    if (e.key === 'Escape') closeZoom()
  }
  document.addEventListener('keydown', onDocKey)

  const prevOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'

  const updateLabels = () => {
    backdrop.setAttribute('aria-label', t('mermaid.dialogLabel'))
    btnIn.setAttribute('aria-label', t('mermaid.zoomIn'))
    btnOut.setAttribute('aria-label', t('mermaid.zoomOut'))
    btnReset.textContent = t('mermaid.reset')
    btnClose.textContent = t('mermaid.close')
  }
  updateLabels()

  activeModal = {
    updateLabels,
    teardown() {
      document.removeEventListener('keydown', onDocKey)
      backdrop.remove()
      document.body.style.overflow = prevOverflow
      trigger.focus()
    },
  }

  document.body.append(backdrop)
  apply()
  btnClose.focus()
}

function modalBtn(act, text, ariaLabel, onClick) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'btn btn-plain'
  button.dataset.act = act
  button.textContent = text
  if (ariaLabel) button.setAttribute('aria-label', ariaLabel)
  button.addEventListener('click', onClick)
  return button
}

function closeZoom() {
  activeModal?.teardown()
  activeModal = null
}

// Mermaid elements are created outside React, so their labels are synced manually when the language changes.
if (typeof document !== 'undefined') {
  onLangChange(() => {
    for (const figure of document.querySelectorAll('.mermaid-block')) {
      const toggle = figure.querySelector('.mermaid-toggle')
      if (toggle) toggle.textContent = t(figure.dataset.view === 'source' ? 'mermaid.hideSource' : 'mermaid.showSource')
      const zoomBtn = figure.querySelector('.mermaid-zoom-btn')
      if (zoomBtn) zoomBtn.textContent = t('mermaid.zoom')
    }
    for (const note of document.querySelectorAll('.mermaid-note')) note.textContent = t('mermaid.failed')
    activeModal?.updateLabels()
  })
}
