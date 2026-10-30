#!/usr/bin/env node
import { parseArgs } from 'node:util'
import path from 'node:path'
import fs from 'node:fs'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { createKnowledgeServer, attachAnchorDB } from '../server/index.js'
import { scaffoldBase, seedSkill, ensureGitignore } from '../server/scaffold.js'
import { buildGraphFromRoot } from '../server/graph/parser.js'
import { readProjectConfig, readGlobalConfig, projectSlug, resolveSettings, DEFAULT_MODEL } from '../server/config.js'
import { readModelRegistry, registerModel, generateModelName, modelRegistryPath } from '../server/models_registry.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'))

// Peran model harus slug kecil; dipakai runModelCommand (dipanggil dari
// alur top-level, jadi dideklarasikan sebelum pemakaian).
const MODEL_ROLE_RE = /^[a-z][a-z0-9_-]*$/

const HELP = `knl-view ${pkg.version}
Viewer lokal untuk basis pengetahuan .knowledges.

Pemakaian:
  knl-view --port 8086 --path=.knowledges
  knl-view --init --path=.knowledges
  knl-view graph trace --target=<id> [--hops=2] [--path=.knowledges]

Bawaan --port/--path/--host bisa disimpan di knl-config.json di folder
project (machine-local, gitignored). Flag CLI selalu menimpa config.

AnchorDB dibaca dari config global ~/.knlview/knl-config.json (URL, token,
sync) sehingga semua project berbagi server yang sama. Nama model per
project dikelola lewat map "models" di knl-config.json: peran → nama,
nama boleh acak karena peta mencatat tujuannya. Registry global
~/.knlview/models.json mencatat pemilik setiap nama model.

Perintah:
  model new <peran>         Buat nama model acak untuk peran (mis. knowledges),
                            tulis ke knl-config.json dan registry global
  model check               Periksa peta model project ini dan registry global

Opsi:
  --port, -p <angka>      Port HTTP (bawaan: 8085, atau knl-config.json)
  --path <folder>         Folder basis pengetahuan (bawaan: .knowledges, atau knl-config.json)
  --host <alamat>         Alamat bind (bawaan: 127.0.0.1, atau knl-config.json)
  --anchordb <url>        URL AnchorWire untuk sesi ini, menimpa blok
                          "anchordb" di knl-config.json
  --target <id>           ID simpul target untuk kueri sub-graf
  --hops <angka>          Radius hop penelusuran graf (bawaan: 2)
  --init                  Bangun basis baru lewat wizard (tidak memulai server)
  --structure <susunan>   Susunan saat --init non-interaktif:
                          standard | empty | custom (bawaan: standard)
  --folders <a,b,c>       Nama folder untuk --structure=custom
  --seed-skill=knl-view   Tulis skill OpenCode "knl-view" (lewati bila sudah ada)
  --dir <lokasi>          Lokasi skill: project (.agents/skills) | global
                          (~/.config/opencode/skills). Bawaan: project
  --yes, -y               Pakai semua jawaban bawaan, tanpa bertanya
  --help, -h              Tampilkan bantuan ini
  --version, -v           Tampilkan versi

Contoh:
  knl-view --path=../anchor-connector/.knowledges
  knl-view --port 8086 --path=.knowledges
  knl-view graph trace --target=README.md --hops=1
  knl-view graph trace --target=DEC-20261030-135001
  knl-view --init
  knl-view --seed-skill=knl-view --dir=global --yes
`

let values, positionals
try {
  ({ values, positionals } = parseArgs({
    options: {
      port: { type: 'string', short: 'p' },
      path: { type: 'string' },
      host: { type: 'string' },
      anchordb: { type: 'string' },
      target: { type: 'string' },
      hops: { type: 'string', default: '2' },
      init: { type: 'boolean', default: false },
      structure: { type: 'string', default: 'standard' },
      folders: { type: 'string', default: '' },
      'seed-skill': { type: 'string' },
      dir: { type: 'string', default: 'project' },
      yes: { type: 'boolean', short: 'y', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false }
    },
    allowPositionals: true
  }))
} catch (err) {
  fail(`${err.message}\n\nJalankan "knl-view --help" untuk bantuan.`)
}

if (values['seed-skill'] !== undefined && values['seed-skill'] !== 'knl-view') {
  fail(`--seed-skill hanya mengenal "knl-view", dapat "${values['seed-skill']}".`)
}
if (!['project', 'global'].includes(values.dir)) {
  fail(`--dir harus project atau global, dapat "${values.dir}".`)
}
if (!['standard', 'empty', 'custom'].includes(values.structure)) {
  fail(`--structure harus standard, empty, atau custom, dapat "${values.structure}".`)
}

if (values.help) {
  process.stdout.write(HELP)
  process.exit(0)
}
if (values.version) {
  process.stdout.write(`${pkg.version}\n`)
  process.exit(0)
}

// Config dua lapis: project (knl-config.json) dan global (~/.knlview/).
// File hilang tidak masalah; rusak diabaikan dengan satu peringatan di
// stderr supaya nilai yang tidak terpakai tidak misterius.
const { config: projectConfig, error: projectError } = await readProjectConfig()
if (projectError) {
  process.stderr.write(`knl-view: knl-config.json diabaikan (${projectError})\n`)
}
const { config: globalConfig, error: globalError } = await readGlobalConfig()
if (globalError) {
  process.stderr.write(`knl-view: ~/.knlview/knl-config.json diabaikan (${globalError})\n`)
}
const settings = resolveSettings({
  cli: values,
  project: projectConfig,
  global: globalConfig
})
if (values.anchordb !== undefined && !settings.anchordb) {
  fail('--anchordb harus URL wire:// atau tcp://, contoh: --anchordb=wire://127.0.0.1:7448?token=xxx')
}

// Perintah "model": kelola peta peran → nama model AnchorDB. Kode lain
// tidak pernah menebak nama; semuanya resolve lewat peran di map ini.
const modelCommand = positionals?.[0] === 'model' ? positionals?.[1] : null
if (modelCommand) {
  await runModelCommand(modelCommand, positionals?.[2], { projectConfig, settings })
  process.exit(0)
}

// Daftarkan seluruh map project ke registry global (memperbarui path/
// timestamp bila memang milik project ini) dan peringatkan nama yang
// diklaim project lain. Registrasi lokal ini tidak butuh koneksi server.
if (settings.models) {
  for (const [role, name] of Object.entries(settings.models)) {
    const { previous, error } = await registerModel(name, {
      role,
      project: projectSlug(process.cwd()),
      cwd: process.cwd()
    })
    if (error) {
      process.stderr.write(`knl-view: registry model diabaikan (${error})\n`)
    } else if (previous) {
      process.stdout.write(`  peringatan: model "${name}" (${role}) juga dipakai project lain: ${previous.cwd}\n`)
    }
  }
}

const isGraphTrace = (positionals?.[0] === 'graph' && positionals?.[1] === 'trace') || values.target !== undefined
if (isGraphTrace) {
  const target = values.target || positionals?.[2]
  if (!target) {
    fail('Parameter --target wajib disertakan:\n  knl-view graph trace --target=<id> [--hops=2]')
  }
  const root = path.resolve(process.cwd(), settings.path)
  if (!fs.existsSync(root)) {
    fail(`Folder tidak ditemukan: ${root}\nCek --path, atau jalankan dari folder project yang punya .knowledges.`)
  }
  if (!fs.statSync(root).isDirectory()) {
    fail(`--path harus folder, bukan berkas: ${root}`)
  }
  const hops = parseInt(values.hops || '2', 10)
  const graph = await buildGraphFromRoot(root)
  const subGraph = graph.extractSubGraph(target, Number.isInteger(hops) && hops > 0 ? hops : 2)
  process.stdout.write(JSON.stringify(subGraph, null, 2) + '\n')
  process.exit(0)
}

if (values.init || values['seed-skill'] !== undefined) {
  await runSetup()
  process.exit(0)
}

const port = Number(settings.port)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  fail(`--port harus angka 1-65535, dapat "${settings.port}".`)
}

const root = path.resolve(process.cwd(), settings.path)
if (!fs.existsSync(root)) {
  fail(`Folder tidak ditemukan: ${root}\nCek --path, atau jalankan dari folder project yang punya .knowledges.`)
}
if (!fs.statSync(root).isDirectory()) {
  fail(`--path harus folder, bukan berkas: ${root}`)
}

const dist = path.join(here, '..', 'dist')
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  fail(`Antarmuka belum dibangun (${dist}).\nJalankan dulu: npm run build`)
}

const server = createKnowledgeServer({ root, dist, host: settings.host, port, anchordb: settings.anchordb })

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    fail(`Port ${port} sudah dipakai proses lain.\nCoba port lain: knl-view --port ${port + 1}`)
  }
  fail(`Server gagal dijalankan: ${err.message}`)
})

server.listen(port, settings.host, () => {
  const addr = `http://${settings.host}:${port}`
  process.stdout.write(
    `knl-view ${pkg.version}\n` +
      `  alamat   ${addr}\n` +
      `  sumber   ${root}\n` +
      `Tekan Ctrl+C untuk berhenti.\n`
  )

  if (settings.anchordb) {
    if (!settings.anchordb.model) {
      // Map adalah satu-satunya sumber nama model; tanpa entri, AnchorDB
      // sengaja tidak disentuh supaya tidak muncul nama tanpa makna.
      process.stdout.write(
        '  anchordb idle: peran "knowledges" belum dipetakan di knl-config.json\n' +
          '    jalankan: knl-view model new knowledges\n'
      )
    } else {
      attachAnchorDB(server).then((result) => {
        if (result.ok) {
          let line = `  anchordb terhubung (${result.model}`
          if (result.synced) {
            if (result.failed) {
              line += `, sync ${result.linked}+${result.unlinked} edge, ${result.failed} gagal (diulang saat start berikutnya)`
            } else if (result.linked || result.unlinked) {
              line += `, sync +${result.linked} -${result.unlinked} (${result.kept} edge tetap)`
            } else {
              line += `, graf sudah sinkron (${result.kept} edge)`
            }
          }
          process.stdout.write(`${line})\n`)
        } else {
          process.stdout.write(`  anchordb gagal: ${result.reason} (viewer jalan lokal saja)\n`)
        }
      })
    }
  }
})

// Wizard --init / --seed-skill. Mode tanya hanya bila stdin TTY dan tanpa
// --yes; selain itu pakai jawaban bawaan supaya tidak pernah menggantung
// (pipe, CI, atau skrip).
async function runSetup() {
  const root = path.resolve(process.cwd(), settings.path)
  const interactive = Boolean(process.stdin.isTTY) && !values.yes
  const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null

  try {
    let structure = values.structure
    let folders = values.folders.split(',').map((s) => s.trim()).filter(Boolean)
    let seedScope = values['seed-skill'] !== undefined ? values.dir : null
    let gitignore = true

    if (values.init) {
      if (rl) {
        structure = await askChoice(rl, 'Susunan basis baru?', [
          ['standard', 'Standard: README.md + roadmap/ features/ docs/'],
          ['empty', 'Kosong: hanya folder .knowledges/'],
          ['custom', 'Custom: tentukan folder sendiri']
        ], structure)
        if (structure === 'custom' && !folders.length) {
          const answer = await ask(rl, 'Nama folder (pisahkan koma): ', 'roadmap, features, docs')
          folders = answer.split(',').map((s) => s.trim()).filter(Boolean)
        }
        seedScope = await askChoice(rl, 'Skill OpenCode knl-view?', [
          ['none', 'Tidak usah'],
          ['project', 'Project: .agents/skills/knl-view/'],
          ['global', 'Global: ~/.config/opencode/skills/knl-view/']
        ], seedScope || 'none')
        if (seedScope === 'none') seedScope = null
        gitignore = await askYesNo(rl, 'Tambahkan .knowledges/ ke .gitignore?', true)
      }

      process.stdout.write(`Membangun basis di ${root} (susunan: ${structure})...\n`)
      const actions = await scaffoldBase({ root, structure, folders })
      report(actions)
    }

    if (seedScope) {
      const result = await seedSkill({ scope: seedScope, cwd: process.cwd() })
      const lokasi = seedScope === 'global' ? 'global' : 'project'
      process.stdout.write(
        result.status === 'skipped'
          ? `  lewati   skill sudah ada: ${result.path}\n`
          : `  buat     skill (${lokasi}): ${result.path}\n`
      )
    }

    if (values.init && gitignore) {
      const result = await ensureGitignore({ cwd: process.cwd() })
      process.stdout.write(
        result.status === 'skipped'
          ? `  lewati   .gitignore sudah menyebut .knowledges\n`
          : `  buat     menambah .knowledges/ ke ${result.path}\n`
      )
    }

    process.stdout.write('Selesai. Jalankan "knl-view" untuk melihat basis ini.\n')
  } finally {
    rl?.close()
  }
}

function report(actions) {
  for (const action of actions) {
    const label = action.kind === 'dir' ? 'folder ' : 'berkas '
    const verb = action.status === 'skipped' ? 'lewati' : 'buat   '
    process.stdout.write(`  ${verb} ${label}${action.path}\n`)
  }
}

// Semua pertanyaan lewat sini agar EOF (Ctrl+D) di tengah wizard berhenti
// rapi, bukan melempar AbortError dengan stack trace.
async function ask(rl, question, fallback) {
  let answer
  try {
    answer = (await rl.question(question)).trim()
  } catch {
    process.stdout.write('\n')
    fail('Dibatalkan.')
  }
  return answer || fallback
}

async function askChoice(rl, question, choices, current) {
  process.stdout.write(`${question}\n`)
  choices.forEach(([value, label], i) => {
    const penanda = value === current ? '>' : ' '
    process.stdout.write(`  ${penanda} ${i + 1}. ${label}\n`)
  })
  const answer = await ask(rl, `Pilihan [1-${choices.length}, bawaan: ${defaultIndex(choices, current)}]: `, '')
  const byNumber = Number(answer)
  if (Number.isInteger(byNumber) && byNumber >= 1 && byNumber <= choices.length) return choices[byNumber - 1][0]
  const byValue = choices.find(([value]) => value === answer)
  if (byValue) return byValue[0]
  return current
}

function defaultIndex(choices, current) {
  const i = choices.findIndex(([value]) => value === current)
  return i >= 0 ? i + 1 : 1
}

async function askYesNo(rl, question, fallback) {
  const answer = (await ask(rl, `${question} (y/t) [bawaan: ${fallback ? 'y' : 't'}]: `, '')).toLowerCase()
  if (!answer) return fallback
  return answer === 'y' || answer === 'ya'
}

function fail(message) {
  process.stderr.write(`knl-view: ${message}\n`)
  process.exit(1)
}

// Perintah "model new" dan "model check": mengelola peta peran → nama
// model AnchorDB. Nama boleh acak; yang memberi makna adalah peta ini
// plus registry global ~/.knlview/models.json (pemilik setiap nama).

async function runModelCommand(sub, roleArg, { projectConfig, settings }) {
  if (sub === 'new') {
    const role = (roleArg || '').trim().toLowerCase()
    if (!MODEL_ROLE_RE.test(role)) {
      fail(`Peran harus slug kecil (huruf, angka, -, _), dapat "${roleArg || '(kosong)'}".\nContoh: knl-view model new knowledges`)
    }
    const existing = settings.models?.[role]
    if (existing) {
      fail(`Peran "${role}" sudah dipetakan ke model "${existing}".\nEdit knl-config.json bila memang mau diganti.`)
    }
    const name = generateModelName()
    const { previous, error } = await registerModel(name, {
      role,
      project: projectSlug(process.cwd()),
      cwd: process.cwd()
    })
    if (error) fail(`Registry gagal ditulis (${error}). Nama baru tidak jadi dipakai.`)
    if (previous) {
      fail(`Nama "${name}" sudah dipakai project lain (${previous.cwd}) untuk peran "${previous.role}".\nJalankan ulang untuk nama baru.`)
    }
    const next = { ...projectConfig, models: { ...(projectConfig?.models || {}), [role]: name } }
    delete next.model // map menggantikan bentuk lama "model"
    fs.writeFileSync(path.join(process.cwd(), 'knl-config.json'), JSON.stringify(next, null, 2) + '\n', 'utf8')
    process.stdout.write(
      `model ${name} → peran ${role}\n` +
        `  knl-config.json: models.${role} = "${name}"\n` +
        `  registry: ${modelRegistryPath()}\n`
    )
    return
  }

  if (sub === 'check') {
    const { models: registry, error } = await readModelRegistry()
    if (error) process.stderr.write(`knl-view: registry diabaikan (${error})\n`)
    const cwd = path.resolve(process.cwd())
    const map = settings.models || {}
    const roles = Object.keys(map)
    process.stdout.write(`Peta model project ini (${projectSlug(cwd)}):\n`)
    if (!roles.length) {
      process.stdout.write('  (kosong — jalankan "knl-view model new knowledges")\n')
    }
    for (const role of roles) {
      const name = map[role]
      const entry = registry[name]
      const owner = entry ? `${entry.project}/${entry.role}` : 'belum terdaftar'
      const clash = entry && path.resolve(entry.cwd || '') !== cwd
      process.stdout.write(`  ${role.padEnd(12)} ${name}  (${owner}${clash ? ' — TABRAKAN: diklaim ' + entry.cwd : ''})\n`)
    }
    const others = Object.entries(registry).filter(([, e]) => path.resolve(e.cwd || '') !== cwd)
    if (others.length) {
      process.stdout.write('Model project lain di registry:\n')
      for (const [name, e] of others) {
        process.stdout.write(`  ${name}  → ${e.project}/${e.role}  (${e.cwd})\n`)
      }
    }
    process.stdout.write('Catatan: keberadaan model di server tidak bisa dicek lewat wire protocol;\n')
    process.stdout.write('yang diperiksa di sini konsistensi peta, registry, dan kepemilikan nama.\n')
    return
  }

  fail(`Perintah model tidak dikenal: ${sub || '(kosong)'}\nGunakan "model new <peran>" atau "model check".`)
}

