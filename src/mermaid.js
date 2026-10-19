import { t, onLangChange } from './i18n.js'

// Fence ```mermaid di dalam .md dirender jadi diagram SVG.
// Modul mermaid dimuat malas: hanya diunduh saat ada fence mermaid,
// supaya bundel utama tetap kecil untuk basis tanpa diagram.

let mermaidPromise = null
let uid = 0
let activeModal = null

// Pasangan warna node flowchart: isian pastel pucat + tepi terang bergantian,
// sesuai palet mermaut di tangkapan layar rujukan (merah muda, biru muda, dst).
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

// Kumpulkan id node flowchart dari sumber. Komentar, label, dan string dibuang
// dulu supaya hanya id yang tersisa; id tak dikenal mermaid abaikan diam-diam
// saat direktif `class`, jadi ekstraksi longgar ini aman.
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

// Sematkan pewarnaan node flowchart tanpa mengubah sumber yang ditampilkan.
// Hanya flowchart yang diwarnai; diagram lain (sequence, class, dst) sudah
// diwarnai temanya sendiri.
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
        // Tema warna-warni mermaut: isian pastel pucat + tepi terang bergantian,
        // tinta gelap, sudut membulat, bayangan lembut, jarak node/rank lega.
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
  // Tandai dulu sebelum await: efek ganda (StrictMode, render ulang) tidak boleh menggandakan kerja.
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
    // DOM sudah diganti React selesai dirender; efek berikutnya akan memproses node baru.
    if (!code.isConnected) continue
    const pre = code.closest('pre')
    if (!pre) continue
    const source = code.textContent
    const id = `knl-mermaid-${++uid}`

    let svg = ''
    try {
      // Sumber berwarna hanya untuk render; tampilan "Show source" tetap asli.
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

// Syntax error: biarkan blok kode apa adanya, tambah catatan kecil.
function failNote(code) {
  const pre = code.closest('pre')
  code.dataset.mermaid = 'error'
  if (!pre || pre.previousElementSibling?.classList.contains('mermaid-note')) return
  const note = document.createElement('p')
  note.className = 'inline-note mermaid-note'
  note.textContent = t('mermaid.failed')
  pre.before(note)
}

// --- Modal zoom: satu diagram diperbesar di layar penuh, scroll untuk zoom,
// --- tarik untuk geser, tombol +/−/Reset sebagai kontrol sentuh/klik. ---

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

  // Zoom di sekitar titik (mx, my) relatif terhadap panggung: titik di bawah
  // kursor tetap berada di posisi yang sama saat skala berubah.
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

  // Klik latar gelap menutup; klik panggung (geser) tidak.
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeZoom()
  })

  // Jebakan fokus: Tab hanya berputar di tombol toolbar.
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

// Elemen mermaid dibuat di luar React, jadi labelnya disinkronkan manual saat bahasa berganti.
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
