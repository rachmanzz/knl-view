#!/usr/bin/env node
import { parseArgs, promisify } from 'node:util'
import path from 'node:path'
import fs from 'node:fs'
import readline from 'node:readline/promises'
import { execFile, spawn } from 'node:child_process'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createKnowledgeServer, attachAnchorDB } from '../server/index.js'
import { scaffoldBase, seedSkill, ensureGitignore, seedAgentInstructions } from '../server/scaffold.js'
import { buildGraphFromRoot } from '../server/graph/parser.js'
import {
  deriveStatus,
  recordClaim,
  readClaimsIndex,
  readConsensusMirror,
  updateConsensusMirror,
  inboundConsensus,
  outboundConsensus,
  CONSENSUS_RELATIONS
} from '../server/consensus.js'
import { readProjectConfig, readGlobalConfig, projectSlug, anchordbClientOptions, resolveModel, resolveSettings, knlGlobalDir, globalConfigPath } from '../server/config.js'
import { createAnchorWireClient, mirrorStillValid } from '../server/graph/anchordb_client.js'
import { syncSourcesToAnchorDB, traceSources, purgeArchivedRecords } from '../server/graph/sources.js'
import {
  parseModuleSpecifier,
  buildModuleGraph,
  syncModuleToAnchorDB,
  traceModuleSymbol
} from '../server/graph/modules_builder.js'
import {
  readModulesCatalog,
  defaultEcosystemModel,
  detectProjectManifests,
  isModuleSynced,
  SUPPORTED_ECOSYSTEMS
} from '../server/graph/modules_catalog.js'
import { readModelRegistry, registerModel, generateModelName, modelRegistryPath } from '../server/models_registry.js'
import {
  latestRelease,
  releaseAssetName,
  generateToken,
  downloadFile,
  verifySha256,
  mergeGlobalAnchordb,
  availableContainerRuntimes,
  detectRunningDaemon,
  inspectContainerStatus,
  startContainer,
  removeContainer,
  detectGraphify,
  checkDecisionSkillsStatus,
  installDecisionSkills,
  resolveAnchorPorts,
  GHCR_IMAGE,
  HTTP_PORT_DEFAULT,
  WIRE_PORT_DEFAULT,
  CONTAINER_NAME
} from '../server/install.js'

const exec = promisify(execFile)

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'))

// Model roles must be lowercase slugs; used by runModelCommand (called from
// the top-level flow, so declared before use).
const MODEL_ROLE_RE = /^[a-z][a-z0-9_-]*$/

// Claim ids are content-addressed: "c-" + 16 hex chars of the statement
// hash. Used by runConsensusCommand (invoked from the top-level flow, so
// declared before use).
const CLAIM_ID_RE = /^c-[0-9a-f]{16}$/

const HELP = `knl-view ${pkg.version}
Local viewer for the .knowledges knowledge base.

Usage:
  knl-view --port 8086 --path=.knowledges
  knl-view --init --path=.knowledges
  knl-view graph trace --target=<id> [--hops=2] [--direction=in|out|both] [--path=.knowledges]

Defaults for --port/--path/--host can be stored in knl-config.json in the
project folder (machine-local, gitignored). CLI flags always override config.

AnchorDB is optional and read from the global config
~/.knlview/knl-config.json (URL, token, sync) so every project using it
shares the same server. Without that block, the viewer runs fully local
and never touches AnchorDB. Per-project model names are managed through
the "models" map in knl-config.json: role → name; names may be random
because the map records what each name is for. The global registry
~/.knlview/models.json records the owner of every model name.

Commands:
  model new <role>          Generate a random model name for a role (e.g. knowledges),
                            write it to knl-config.json and the global registry
  model check               Check this project's models map and the global registry
  install anchordb          Install AnchorDB: binary from GitHub Releases on
                            Linux and macOS; docker/podman container elsewhere
  consensus claim "<text>"  Register a content-addressed claim (c-<hash>)
  consensus agree <a> <b>   Claim a supports claim b (stored in AnchorDB)
  consensus contradict <a> <b>  Claim a opposes claim b
  consensus retract <a> <b> Remove any relation between two claims
  consensus status <id>     Consensus status of one claim
  consensus list            Locally known claims with their status
  sources sync              Sync the whole-project dependency graph (file
                            nodes + import edges) into the AnchorDB
                            "sources" model; server-authoritative, no mirror
  sources collect           Purge archived (tombstoned) records of the
                            "sources" model via the REST collector
  sources trace --target=<path>  File lineage over the sources graph
                            (--hops, --direction in|out|both)
  modules build-graph <target>  Build & sync external module graph into global
                            AnchorDB model (modules-<eco>) on-demand
                            Target: <eco>::<module_name> (e.g. npm::express)
  modules trace <target> [sym]  Trace calls/definitions for an external module/symbol
  modules list [ecosystem]  List locally indexed modules from ~/.knlview/modules
  setup                   Bootstrap project in one command (scaffold base, skill, and models)

Options:
  --port, -p <number>     HTTP port (default: 8085, or knl-config.json)
  --path <folder>         Knowledge base folder (default: .knowledges, or knl-config.json)
  --host <address>        Bind address (default: 127.0.0.1, or knl-config.json)
  --anchordb <url>        AnchorWire URL for this session, overrides the
                          "anchordb" block in knl-config.json
  --method <method>       Method for "install anchordb": binary | container
  --runtime <engine>      Container runtime for "install anchordb": docker | podman
  --token <text>          Auth token for "install anchordb" (default: random)
  --direction <dir>       Lineage direction for "graph trace": in | out | both
                          (default: both; see README "Two-way lineage")
  --target <id>           Target node id for the subgraph query
  --hops <number>         Graph trace hop radius (default: 2)
  --force                 Rebuild external module graph even if already indexed
  --init                  Scaffold a new base via the wizard (does not start the server)
  --structure <layout>    Layout for non-interactive --init:
                          standard | empty | custom (default: standard)
  --folders <a,b,c>       Folder names for --structure=custom
  --seed-skill=knl-view   Write or update the knl-view skill for coding agents;
                          an existing copy whose content differs is updated in
                          place, and existing global copies are synced too
  --dir <location>        Skill location: project (.agents/skills) | global
                          (first existing of ~/.config/opencode/skills,
                          ~/.agents/skills, ~/.codex/skills). Default: project
  --yes, -y               Use all default answers, no prompting
  --help, -h              Show this help
  --version, -v           Show version

Examples:
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
      method: { type: 'string' },
      runtime: { type: 'string' },
      token: { type: 'string' },
      target: { type: 'string' },
      direction: { type: 'string' },
      hops: { type: 'string', default: '2' },
      force: { type: 'boolean', default: false },
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
  fail(`${err.message}\n\nRun "knl-view --help" for help.`)
}

if (values['seed-skill'] !== undefined && values['seed-skill'] !== 'knl-view') {
  fail(`--seed-skill only knows "knl-view", got "${values['seed-skill']}".`)
}
if (!['project', 'global'].includes(values.dir)) {
  fail(`--dir must be project or global, got "${values.dir}".`)
}
if (!['standard', 'empty', 'custom'].includes(values.structure)) {
  fail(`--structure must be standard, empty, or custom, got "${values.structure}".`)
}

if (values.help) {
  process.stdout.write(HELP)
  process.exit(0)
}
if (values.version) {
  process.stdout.write(`${pkg.version}\n`)
  process.exit(0)
}

// Two-layer config: project (knl-config.json) and global (~/.knlview/).
// A missing file is fine; a broken one is ignored with a single warning on
// stderr so unused values are not a mystery.
const { config: projectConfig, error: projectError } = await readProjectConfig()
if (projectError) {
  process.stderr.write(`knl-view: ignoring knl-config.json (${projectError})\n`)
}
const { config: globalConfig, error: globalError } = await readGlobalConfig()
if (globalError) {
  process.stderr.write(`knl-view: ignoring ~/.knlview/knl-config.json (${globalError})\n`)
}
const settings = resolveSettings({
  cli: values,
  project: projectConfig,
  global: globalConfig
})
if (values.anchordb !== undefined && !settings.anchordb) {
  fail('--anchordb must be a wire:// or tcp:// URL, example: --anchordb=wire://127.0.0.1:7448?token=xxx')
}

// The "setup" command: one-shot bootstrap for the project
if (positionals?.[0] === 'setup') {
  await runSetupCommand({ values, settings, projectConfig, globalConfig })
  process.exit(0)
}

// The "model" command: manage the role → AnchorDB model name map. No other
// code ever guesses names; everything resolves through the role in this map.
const modelCommand = positionals?.[0] === 'model' ? positionals?.[1] : null
if (modelCommand) {
  await runModelCommand(modelCommand, positionals?.[2], { projectConfig, settings })
  process.exit(0)
}

// The "install" command: install AnchorDB (binary on Linux, container on
// other platforms) then write the anchordb block to the global config.
if (positionals?.[0] === 'install') {
  await runInstallCommand(positionals?.[1], { values })
  process.exit(0)
}

// The "consensus" command: agreement/conflict between claims, stored purely
// in the AnchorDB consensus model (the "consensus" role in the models map).
const consensusSub = positionals?.[0] === 'consensus' ? positionals?.[1] : null
if (consensusSub) {
  try {
    await runConsensusCommand(consensusSub, positionals?.slice(2), { settings })
  } catch (err) {
    fail(`Consensus command failed: ${err.message}`)
  }
  process.exit(0)
}

// The "sources" command: dependency graph of the whole project (not just
// .knowledges) stored purely in the AnchorDB sources model.
const sourcesSub = positionals?.[0] === 'sources' ? positionals?.[1] : null
if (sourcesSub) {
  try {
    await runSourcesCommand(sourcesSub, values, { settings })
  } catch (err) {
    fail(`Sources command failed: ${err.message}`)
  }
  process.exit(0)
}

// The "modules" command: on-demand external boundary graph in global AnchorDB
// modules models (modules-npm, modules-go, modules-cargo, modules-pypi).
const modulesSub = positionals?.[0] === 'modules' ? positionals?.[1] : null
if (modulesSub) {
  try {
    await runModulesCommand(modulesSub, positionals?.slice(2), { values, settings })
  } catch (err) {
    fail(`Modules command failed: ${err.message}`)
  }
  process.exit(0)
}

// Register the project's whole models map to the global registry (updating
// path/timestamp when this project owns them) and warn about names claimed
// by other projects. This local registration needs no server connection.
if (settings.models) {
  for (const [role, name] of Object.entries(settings.models)) {
    const { previous, error } = await registerModel(name, {
      role,
      project: projectSlug(process.cwd()),
      cwd: process.cwd()
    })
    if (error) {
      process.stderr.write(`knl-view: ignoring model registry (${error})\n`)
    } else if (previous) {
      process.stdout.write(`  warning: model "${name}" (${role}) is also used by another project: ${previous.cwd}\n`)
    }
  }
}

const isGraphTrace = (positionals?.[0] === 'graph' && positionals?.[1] === 'trace') || values.target !== undefined
if (isGraphTrace) {
  const target = values.target || positionals?.[2]
  if (!target) {
    fail('Parameter --target is required:\n  knl-view graph trace --target=<id> [--hops=2] [--direction=in|out|both]')
  }
  const root = path.resolve(process.cwd(), settings.path)
  if (!fs.existsSync(root)) {
    fail(`Folder not found: ${root}\nCheck --path, or run from a project folder that has a .knowledges base.`)
  }
  if (!fs.statSync(root).isDirectory()) {
    fail(`--path must be a folder, not a file: ${root}`)
  }
  const hops = parseInt(values.hops || '2', 10)
  let direction = 'both'
  if (values.direction !== undefined) {
    if (!['in', 'out', 'both'].includes(values.direction)) {
      fail(`--direction must be in, out, or both, got "${values.direction}".`)
    }
    direction = values.direction
  }
  const graph = await buildGraphFromRoot(root)
  const subGraph = graph.extractSubGraph(target, Number.isInteger(hops) && hops > 0 ? hops : 2, direction)
  process.stdout.write(JSON.stringify(subGraph, null, 2) + '\n')
  process.exit(0)
}

if (values.init || values['seed-skill'] !== undefined) {
  await runSetup()
  process.exit(0)
}

if (positionals && positionals.length > 0) {
  fail(`Unknown command "${positionals[0]}".\n\nRun "knl-view --help" for available commands.`)
}

const port = Number(settings.port)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  fail(`--port must be a number 1-65535, got "${settings.port}".`)
}

const root = path.resolve(process.cwd(), settings.path)
if (!fs.existsSync(root)) {
  fail(`Folder not found: ${root}\nCheck --path, or run from a project folder that has a .knowledges base.`)
}
if (!fs.statSync(root).isDirectory()) {
  fail(`--path must be a folder, not a file: ${root}`)
}

const dist = path.join(here, '..', 'dist')
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  fail(`UI not built yet (${dist}).\nRun first: npm run build`)
}

const server = createKnowledgeServer({
  root,
  dist,
  host: settings.host,
  port,
  anchordb: settings.anchordb,
  consensusModel: resolveModel(settings.models, 'consensus'),
  sourcesModel: resolveModel(settings.models, 'sources'),
  include: settings.include,
  exclude: settings.exclude
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    fail(`Port ${port} is already in use by another process.\nTry another port: knl-view --port ${port + 1}`)
  }
  fail(`Failed to start server: ${err.message}`)
})

server.listen(port, settings.host, () => {
  const addr = `http://${settings.host}:${port}`
  process.stdout.write(
    `knl-view ${pkg.version}\n` +
      `  address  ${addr}\n` +
      `  source   ${root}\n` +
      `Press Ctrl+C to stop.\n`
  )

  if (settings.anchordb) {
    if (!settings.anchordb.model) {
      // The map is the only source of model names; without an entry, AnchorDB
      // is deliberately left untouched so no meaningless name appears.
      process.stdout.write(
        '  anchordb idle: role "knowledges" not yet mapped in knl-config.json\n' +
          '    run: knl-view model new knowledges\n'
      )
    } else {
      attachAnchorDB(server).then((result) => {
        if (result.ok) {
          let line = `  anchordb connected (${result.model}`
          if (result.synced) {
            if (result.failed) {
              line += `, sync ${result.linked}+${result.unlinked} edges, ${result.failed} failed (retried on next start)`
            } else if (result.linked || result.unlinked) {
              line += `, sync +${result.linked} -${result.unlinked} (${result.kept} edges kept)`
            } else {
              line += `, graph already in sync (${result.kept} edges)`
            }
          }
          process.stdout.write(`${line})\n`)
          if (server.knlAnchorDB.consensusClient) {
            process.stdout.write(`  consensus ready (${server.knlAnchorDB.consensusModel})\n`)
          } else if (server.knlAnchorDB.consensusError) {
            process.stdout.write(`  consensus unavailable: ${server.knlAnchorDB.consensusError}\n`)
          }
          if (server.knlAnchorDB.sourcesClient) {
            process.stdout.write(`  sources ready (${server.knlAnchorDB.sourcesModel})\n`)
          } else if (server.knlAnchorDB.sourcesError) {
            process.stdout.write(`  sources unavailable: ${server.knlAnchorDB.sourcesError}\n`)
          }
        } else {
          process.stdout.write(`  anchordb failed: ${result.reason} (viewer runs local only)\n`)
        }
      }).catch((err) => {
        process.stdout.write(`  anchordb error: ${err.message} (viewer runs local only)\n`)
      })
    }
  }
})

// The --init / --seed-skill wizard. Ask mode only when stdin is a TTY and
// no --yes is given; otherwise default answers are used so it never hangs
// (pipe, CI, or scripts).
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
        structure = await askChoice(rl, 'Layout for the new base?', [
          ['standard', 'Standard: README.md + roadmap/ features/ docs/'],
          ['empty', 'Empty: only the .knowledges/ folder'],
          ['custom', 'Custom: pick your own folders']
        ], structure)
        if (structure === 'custom' && !folders.length) {
          const answer = await ask(rl, 'Folder names (comma-separated): ', 'roadmap, features, docs')
          folders = answer.split(',').map((s) => s.trim()).filter(Boolean)
        }
        seedScope = await askChoice(rl, 'OpenCode knl-view skill?', [
          ['none', 'Skip'],
          ['project', 'Project: .agents/skills/knl-view/'],
          ['global', 'Global: ~/.config/opencode/skills/knl-view/']
        ], seedScope || 'none')
        if (seedScope === 'none') seedScope = null
        gitignore = await askYesNo(rl, 'Add .knowledges/ to .gitignore?', true)
      }

      process.stdout.write(`Scaffolding base at ${root} (layout: ${structure})...\n`)
      const actions = await scaffoldBase({ root, structure, folders })
      report(actions)
    }

    if (seedScope) {
      const result = await seedSkill({ scope: seedScope, cwd: process.cwd(), syncGlobal: true })
      const scope = seedScope === 'global' ? 'global' : 'project'
      const statusLabel = result.status === 'skipped' ? 'already exists and up to date' : result.status
      process.stdout.write(`  ${result.status === 'created' ? 'create' : result.status === 'updated' ? 'update' : 'skip  '}   skill (${scope}): ${result.path} (${statusLabel})\n`)
    }

    if (values.init && gitignore) {
      const result = await ensureGitignore({ cwd: process.cwd() })
      process.stdout.write(
        result.status === 'skipped'
          ? `  skip     .gitignore already mentions .knowledges\n`
          : `  create   adding .knowledges/ to ${result.path}\n`
      )
    }

    process.stdout.write('Done. Run "knl-view" to view this base.\n')
  } finally {
    rl?.close()
  }
}

async function runSetupCommand({ values, settings, projectConfig, globalConfig }) {
  const root = path.resolve(process.cwd(), values.path || settings.path || '.knowledges')
  const interactive = Boolean(process.stdin.isTTY) && !values.yes
  const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null

  try {
    process.stdout.write('knl-view setup: bootstrapping project ...\n')

    // Scaffold base
    const actions = await scaffoldBase({
      root,
      structure: values.structure || 'standard',
      folders: values.folders ? values.folders.split(',').map((s) => s.trim()).filter(Boolean) : []
    })
    const createdCount = actions.filter((a) => a.status === 'created').length
    const relRoot = path.relative(process.cwd(), root) || root
    process.stdout.write(`  [1/5] knowledge base: ${relRoot} (${createdCount > 0 ? 'created' : 'already present'})\n`)

    // Audit and seed skill
    const skillPath = path.join(process.cwd(), '.agents', 'skills', 'knl-view', 'SKILL.md')
    let skillPresent = false
    try {
      await fs.promises.stat(skillPath)
      skillPresent = true
    } catch {}

    let wantSkill = true
    if (!skillPresent && interactive) {
      wantSkill = await askYesNo(rl, 'Install knl-view agent skill to .agents/skills/knl-view?', true)
    }

    if (wantSkill) {
      const skillResult = await seedSkill({ scope: values.dir || 'project', cwd: process.cwd(), home: process.env.HOME, syncGlobal: true })
      const statusLabel = skillResult.status === 'skipped' ? 'up to date' : skillResult.status
      process.stdout.write(`  [2/5] agent skill:    ${skillResult.path} (${statusLabel})\n`)
    } else {
      process.stdout.write(`  [2/5] agent skill:    skipped by user\n`)
    }

    // Audit and seed decision-history skill
    const home = process.env.HOME || process.cwd()
    const decisionStatus = await checkDecisionSkillsStatus({ cwd: process.cwd(), home })
    const statusLabel =
      decisionStatus.status === 'not_installed'
        ? 'not installed'
        : decisionStatus.status === 'needs_update'
        ? `update available (current: ${decisionStatus.currentVersion || 'unknown'}, latest: ${decisionStatus.latestVersion})`
        : 'already installed'

    process.stdout.write(`  [skill] decision-history: ${statusLabel}\n`)

    if (decisionStatus.status === 'not_installed' || decisionStatus.status === 'needs_update') {
      let wantDecisionSkill = true
      if (interactive) {
        wantDecisionSkill = await askYesNo(
          rl,
          'Would you like to install/update the decision-history skill (rachmanzz/decisionskills)?',
          true
        )
      }
      if (wantDecisionSkill) {
        let scope = 'project'
        if (interactive) {
          scope = await askChoice(
            rl,
            'Scope for decision-history skill?',
            [
              ['project', 'per-project (.agents/skills/decision-history)'],
              ['global', 'global (all agent terminals: agy, codex, opencode, claude)']
            ],
            'project'
          )
        }
        process.stdout.write(`Installing decision-history skill (${scope}) ...\n`)
        await installDecisionSkills({ scope, cwd: process.cwd(), home, exec })
        process.stdout.write(`  [skill] decision-history: installed (${scope})\n`)
      } else {
        process.stdout.write(`  [skill] decision-history: skipped by user\n`)
      }
    }

    // Ensure gitignore
    const giResult = await ensureGitignore({ cwd: process.cwd() })
    process.stdout.write(`  [3/5] gitignore:      ${giResult.path} (${giResult.status})\n`)

    // Daemon and container lifecycle
    let currentGlobalConfig = globalConfig
    let containerStatus = await inspectContainerStatus(exec)
    let daemonMeta = await detectRunningDaemon(exec)

    if (containerStatus.exists && !containerStatus.valid) {
      let wantRecreate = true
      if (interactive) {
        wantRecreate = await askYesNo(
          rl,
          `AnchorDB container "${containerStatus.name}" is in an invalid state (${containerStatus.status}). Would you like to recreate it?`,
          true
        )
      }
      if (wantRecreate) {
        process.stdout.write(`Removing invalid container "${containerStatus.name}" ...\n`)
        try {
          await removeContainer(exec, containerStatus.runtime, containerStatus.name)
        } catch {}
        await runInstallCommand('anchordb', {
          values: { ...values },
          rl
        })
        const freshGlobal = await readGlobalConfig()
        currentGlobalConfig = freshGlobal.config || currentGlobalConfig
        daemonMeta = await detectRunningDaemon(exec)
      }
    } else if (containerStatus.exists && !containerStatus.running && containerStatus.valid) {
      let wantStart = true
      if (interactive) {
        wantStart = await askYesNo(
          rl,
          `AnchorDB container "${containerStatus.name}" is stopped. Would you like to start it now?`,
          true
        )
      }
      if (wantStart) {
        process.stdout.write(`Starting container "${containerStatus.name}" ...\n`)
        await startContainer(exec, containerStatus.runtime, containerStatus.name)
        await waitAnchorHealth()
        daemonMeta = await detectRunningDaemon(exec)
        if (daemonMeta) {
          const updatedAnchor = {
            ...(currentGlobalConfig?.anchordb || {}),
            url: `wire://127.0.0.1:${daemonMeta.wire_port || WIRE_PORT_DEFAULT}`,
            token: daemonMeta.token || currentGlobalConfig?.anchordb?.token || '',
            sync: currentGlobalConfig?.anchordb?.sync !== false,
            daemon: daemonMeta.daemon || daemonMeta.deamon,
            deamon: daemonMeta.daemon || daemonMeta.deamon,
            container_name: daemonMeta.container_name,
            container_id: daemonMeta.container_id,
            container_created_on: daemonMeta.container_created_on
          }
          await mergeGlobalAnchordb(home, updatedAnchor)
          currentGlobalConfig = { ...currentGlobalConfig, anchordb: updatedAnchor }
          process.stdout.write(`  [info] global config updated with ${daemonMeta.daemon || daemonMeta.deamon} daemon metadata\n`)
        }
      }
    } else if (!daemonMeta && !containerStatus.exists) {
      const hasConfigured = Boolean(currentGlobalConfig?.anchordb?.url)
      let wantInstall = Boolean(values.runtime)
      if (!wantInstall && interactive && !hasConfigured) {
        wantInstall = await askYesNo(
          rl,
          'AnchorDB is not running. Would you like to install and start AnchorDB now?',
          false
        )
      }
      if (wantInstall) {
        process.stdout.write('\nProvisioning AnchorDB ...\n')
        await runInstallCommand('anchordb', {
          values: { ...values },
          rl
        })
        const freshGlobal = await readGlobalConfig()
        currentGlobalConfig = freshGlobal.config || currentGlobalConfig
        daemonMeta = await detectRunningDaemon(exec)
      }
    }

    if (daemonMeta && currentGlobalConfig?.anchordb) {
      const existing = currentGlobalConfig.anchordb
      const daemonType = daemonMeta.daemon || daemonMeta.deamon || existing.daemon || existing.deamon
      const updated = {
        ...existing,
        daemon: daemonType,
        deamon: daemonType
      }
      if (daemonMeta.container_name) updated.container_name = daemonMeta.container_name
      if (daemonMeta.container_id) updated.container_id = daemonMeta.container_id
      if (daemonMeta.container_created_on) updated.container_created_on = daemonMeta.container_created_on

      if (JSON.stringify(existing) !== JSON.stringify(updated)) {
        await mergeGlobalAnchordb(home, updated)
        currentGlobalConfig = { ...currentGlobalConfig, anchordb: updated }
      }
    }

    let currentConfig = projectConfig || {}
    const hasAnchor = Boolean(currentGlobalConfig?.anchordb)

    if (hasAnchor) {
      const slug = projectSlug(process.cwd())
      const neededRoles = ['knowledges', 'sources']
      let modelsUpdated = false
      const nextModels = { ...(currentConfig.models || {}) }

      for (const role of neededRoles) {
        if (!nextModels[role]) {
          const name = generateModelName()
          await registerModel(name, { role, project: slug, cwd: process.cwd() })
          nextModels[role] = name
          modelsUpdated = true
        }
      }

      if (modelsUpdated) {
        currentConfig = { ...currentConfig, models: nextModels }
        delete currentConfig.model
        fs.writeFileSync(path.join(process.cwd(), 'knl-config.json'), JSON.stringify(currentConfig, null, 2) + '\n', 'utf8')
        process.stdout.write(`  [4/5] anchordb models: mapped knowledges (${nextModels.knowledges}) and sources (${nextModels.sources}) in knl-config.json\n`)
      } else {
        process.stdout.write(`  [4/5] anchordb models: already mapped in knl-config.json\n`)
      }

      const targetAnchordb = {
        ...(settings.anchordb || currentGlobalConfig?.anchordb),
        model: nextModels.sources
      }
      const opts = anchordbClientOptions(targetAnchordb)
      if (opts) {
        try {
          process.stdout.write('  syncing project sources to AnchorDB ...\n')
          const client = await createAnchorWireClient(opts)
          const result = await syncSourcesToAnchorDB(client, process.cwd(), {
            labelDir: settings.labelDir,
            include: settings.include,
            exclude: settings.exclude
          })
          client.close()
          process.stdout.write(`  sources sync complete: ${result.files} files, ${result.edges} edges\n`)
        } catch (err) {
          process.stdout.write(`  (sources sync deferred: ${err.message})\n`)
        }
      }
    } else {
      process.stdout.write('  [4/5] anchordb:       inactive (run "knl-view install anchordb" to enable)\n')
    }

    // Seed agent rules
    let wantAgentRules = true
    if (interactive) {
      wantAgentRules = await askYesNo(
        rl,
        'Would you like to configure KNL-View as your primary code intelligence tool in your agent rule files (AGENTS.md, etc.)?',
        true
      )
    }
    if (wantAgentRules) {
      const hasGraphify = await detectGraphify(exec)
      const ruleActions = await seedAgentInstructions({ cwd: process.cwd(), home, hasGraphify })
      for (const action of ruleActions) {
        const rel = path.relative(process.cwd(), action.path)
        const display = rel.startsWith('..') ? action.path : rel
        process.stdout.write(`  [5/5] agent rules:    ${display} (${action.status}${hasGraphify ? ', graphify fallback enabled' : ''})\n`)
      }
    } else {
      process.stdout.write('  [5/5] agent rules:    skipped by user\n')
    }

    process.stdout.write('\nSetup complete! You can now run:\n  knl-view           # start the viewer\n  knl-view graph trace --target=README.md\n')
  } finally {
    if (rl) rl.close()
  }
}

function report(actions) {
  for (const action of actions) {
    const label = action.kind === 'dir' ? 'folder ' : 'file '
    const verb = action.status === 'skipped' ? 'skip' : 'create'
    process.stdout.write(`  ${verb} ${label}${action.path}\n`)
  }
}

// All questions go through here so EOF (Ctrl+D) mid-wizard stops cleanly
// instead of throwing an AbortError with a stack trace.
async function ask(rl, question, fallback) {
  let answer
  try {
    answer = (await rl.question(question)).trim()
  } catch {
    process.stdout.write('\n')
    fail('Cancelled.')
  }
  return answer || fallback
}

async function askChoice(rl, question, choices, current) {
  process.stdout.write(`${question}\n`)
  choices.forEach(([value, label], i) => {
    const marker = value === current ? '>' : ' '
    process.stdout.write(`  ${marker} ${i + 1}. ${label}\n`)
  })
  const answer = await ask(rl, `Choice [1-${choices.length}, default: ${defaultIndex(choices, current)}]: `, '')
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
  const answer = (await ask(rl, `${question} (y/n) [default: ${fallback ? 'y' : 'n'}]: `, '')).toLowerCase()
  if (!answer) return fallback
  return answer === 'y' || answer === 'yes'
}

// The "install anchordb" command. Linux and macOS: binary from GitHub
// Releases (verified against SHA256SUMS.txt). Windows (and anyone who
// prefers it): ghcr.io container via docker/podman. After install, the
// "anchordb" block is written to the global config so every project can
// connect right away.
async function runInstallCommand(target, { values, rl: externalRl = null }) {
  if (target !== 'anchordb') {
    fail(`Unknown install target: ${target || '(none)'}\nAvailable: knl-view install anchordb`)
  }
  const nativeOk = process.platform === 'linux' || process.platform === 'darwin'
  const interactive = Boolean(process.stdin.isTTY) && !values.yes
  const ownsRl = !externalRl && interactive
  const rl = externalRl || (interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null)

  let method = values.method
  if (!method) {
    if (nativeOk) {
      method = interactive
        ? await askChoice(rl, 'AnchorDB install method?', [
            ['binary', 'Binary from GitHub Releases (native)'],
            ['container', 'docker/podman container (ghcr.io)']
          ], 'binary')
        : 'binary'
    } else {
      method = 'container'
      process.stdout.write('No native build for this platform; installing as a Linux container (ghcr.io).\n')
    }
  }
  if (!['binary', 'container'].includes(method)) {
    fail(`--method must be binary or container, got "${method}".`)
  }

  const token = values.token || generateToken()
  const home = process.env.HOME || process.cwd()
  // fs in this module is the callback API; installer steps need the promise version.
  const fsp = fs.promises
  let started = false
  let daemonType = method === 'binary' ? 'binary' : null
  let containerMetadata = null

  const portInfo = await resolveAnchorPorts({
    desiredWirePort: WIRE_PORT_DEFAULT,
    desiredHttpPort: HTTP_PORT_DEFAULT
  })

  let wirePort = portInfo.wirePort
  let httpPort = portInfo.httpPort

  if (!portInfo.wireAvailable || !portInfo.httpAvailable) {
    const conflictPort = !portInfo.wireAvailable ? wirePort : httpPort
    const suggested = !portInfo.wireAvailable ? portInfo.suggestedWirePort : portInfo.suggestedHttpPort
    let useSuggested = true
    if (interactive) {
      useSuggested = await askYesNo(
        rl,
        `Port ${conflictPort} is already in use. Would you like to use port ${suggested} instead?`,
        true
      )
    }
    if (useSuggested) {
      wirePort = portInfo.suggestedWirePort
      httpPort = portInfo.suggestedHttpPort
      process.stdout.write(`  [port] selected wire port ${wirePort} and HTTP port ${httpPort}\n`)
    } else {
      fail(`Port ${conflictPort} is in use and alternative port was declined.`)
    }
  }

  try {
    if (method === 'binary') {
      if (!nativeOk) {
        fail('The binary method needs Linux or macOS.\nUse --method=container.')
      }
      const { version } = await latestRelease()
      const knlViewDir = knlGlobalDir(home)
      const asset = releaseAssetName(version)
      const workdir = path.join(os.tmpdir(), `knlview-install-${Date.now()}`)
      await fsp.mkdir(workdir, { recursive: true })
      try {
        const binDir = path.join(knlViewDir, 'bin')

        process.stdout.write(`Downloading ${asset} (v${version}) ...\n`)
        const archive = path.join(workdir, asset)
        await downloadFile(`https://github.com/rachmanzz/anchordb/releases/download/v${version}/${asset}`, archive)
        const sums = path.join(workdir, 'SHA256SUMS.txt')
        await downloadFile(`https://github.com/rachmanzz/anchordb/releases/download/v${version}/SHA256SUMS.txt`, sums)
        await verifySha256(archive, await fsp.readFile(sums, 'utf8'))
        process.stdout.write('  SHA256 matches SHA256SUMS.txt\n')

        process.stdout.write('Extracting ...\n')
        await exec('tar', ['-xzf', archive, '-C', workdir])
        await fsp.mkdir(binDir, { recursive: true, mode: 0o700 })
        for (const bin of ['anchordb-server', 'anchordb']) {
          const target2 = path.join(binDir, bin)
          await fsp.copyFile(path.join(workdir, bin), target2)
          await fsp.chmod(target2, 0o755)
        }
        process.stdout.write(`  installed to ${binDir}\n`)
      } finally {
        await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {})
      }

      const runNow = interactive
        ? await askYesNo(rl, 'Start the AnchorDB server now?', true)
        : true
      if (runNow) {
        const dataDir = path.join(knlViewDir, 'anchordb-data')
        await fsp.mkdir(dataDir, { recursive: true })
        const logFd = await fsp.open(path.join(knlViewDir, 'anchordb.log'), 'a')
        const child = spawn(path.join(binDir, 'anchordb-server'), [], {
          env: {
            ...process.env,
            ANCHORDB_AUTH_TOKEN: token,
            ANCHORDB_DATA_DIR: dataDir,
            ANCHORDB_PORT: String(httpPort),
            ANCHORDB_WIRE_PORT: String(wirePort)
          },
          detached: true,
          stdio: ['ignore', logFd.fd, logFd.fd]
        })
        child.unref()
        logFd.close()
        await waitAnchorHealth(httpPort)
        started = true
        process.stdout.write(`  server running (log: ${path.join(knlViewDir, 'anchordb.log')})\n`)
      }
    } else {
      const preferredRuntime = values.runtime
      if (preferredRuntime && !['docker', 'podman'].includes(preferredRuntime)) {
        fail(`--runtime must be docker or podman, got "${preferredRuntime}".`)
      }
      const which = async (cmd) => {
        try { await exec(cmd, ['--version']); return true } catch { return false }
      }
      const available = await availableContainerRuntimes(which)
      if (!available.length) {
        fail('docker/podman not found.\nInstall one first: Docker Desktop (macOS/Windows) or podman.')
      }
      let runtime = preferredRuntime
      if (!runtime) {
        if (available.length === 1) {
          runtime = available[0]
        } else {
          runtime = interactive
            ? await askChoice(rl, 'Container runtime to use?', available.map((r) => [r, r]), available[0])
            : available[0]
        }
      } else if (!available.includes(runtime)) {
        fail(`Runtime "${runtime}" was requested via --runtime, but it is not installed or available on this system.`)
      }
      const { version } = await latestRelease()
      const image = `${GHCR_IMAGE}:${version}`
      process.stdout.write(`Pulling ${image} via ${runtime} ...\n`)
      await exec(runtime, ['pull', image])
      process.stdout.write('  image ready\n')

      // Fixed container name: if it already exists, the user must decide;
      // remove it manually so old data is not lost by accident.
      if (await containerExists(runtime)) {
        fail(`Container "${CONTAINER_NAME}" already exists.\nRemove it first if you really want to reinstall: ${runtime} rm -f ${CONTAINER_NAME}`)
      }

      const knlViewDir = knlGlobalDir(home)
      await fsp.mkdir(knlViewDir, { recursive: true, mode: 0o700 })
      try { await fsp.chmod(knlViewDir, 0o700) } catch {}
      const dataDir = path.join(knlViewDir, 'anchordb-data')
      await fsp.mkdir(dataDir, { recursive: true, mode: 0o770 })
      try { await fsp.chmod(dataDir, 0o770) } catch {}
      const baseArgs = ['run', '-d', '--name', CONTAINER_NAME,
        '-p', `${httpPort}:${httpPort}`,
        '-p', `${wirePort}:${wirePort}`,
        '-e', `ANCHORDB_AUTH_TOKEN=${token}`,
        '-e', 'ANCHORDB_DATA_DIR=/data',
        '-e', `ANCHORDB_PORT=${httpPort}`,
        '-e', `ANCHORDB_WIRE_PORT=${wirePort}`]
      // The image runs as user "anchordb" (not root). Rootless podman maps
      // that uid to a different host uid, so data files owned by the host
      // user become unreadable ("permission denied"). keep-id runs the
      // container process with the host user's uid, so binary data and the
      // container can share the folder. Docker (macOS/Windows) runs in a VM
      // and its bind mounts are unaffected, hence no flag here.
      if (runtime === 'podman') baseArgs.push('--userns=keep-id')
      daemonType = runtime
      let containerId = null
      let containerCreatedOn = new Date().toISOString()
      process.stdout.write(`Starting container ...\n`)
      try {
        const { stdout } = await exec(runtime, [...baseArgs, '-v', `${dataDir}:/data:Z`, image])
        containerId = stdout.trim().split('\n')[0]
      } catch {
        // Rootless/sandbox setups sometimes reject volume binds; without a
        // volume the data dies with the container, so we say so plainly.
        process.stdout.write('  volume could not be mounted; data is ephemeral inside the container\n')
        const { stdout } = await exec(runtime, [...baseArgs, image])
        containerId = stdout.trim().split('\n')[0]
      }
      try {
        const { stdout: idOut } = await exec(runtime, ['inspect', '--format', '{{.Id}}', CONTAINER_NAME])
        if (idOut.trim()) containerId = idOut.trim()
        const { stdout: createdOut } = await exec(runtime, ['inspect', '--format', '{{.Created}}', CONTAINER_NAME])
        if (createdOut.trim()) containerCreatedOn = createdOut.trim()
      } catch {
        // fallback to captured containerId and timestamp
      }
      containerMetadata = {
        container_created_on: containerCreatedOn,
        container_name: CONTAINER_NAME,
        container_id: containerId
      }
      await waitAnchorHealth(httpPort)
      started = true
    }
  } catch (err) {
    fail(`Install failed: ${err.message || err}`)
  }

  const anchordbBlock = {
    url: `wire://127.0.0.1:${wirePort}`,
    token,
    sync: true,
    deamon: daemonType
  }
  if (containerMetadata) {
    anchordbBlock.container_created_on = containerMetadata.container_created_on
    anchordbBlock.container_name = containerMetadata.container_name
    anchordbBlock.container_id = containerMetadata.container_id
  }

  const before = await mergeGlobalAnchordb(home, anchordbBlock)
  if (before) {
    process.stdout.write('  (old anchordb block in the global config overwritten; new token applied)\n')
  }

  process.stdout.write(
    `\nAnchorDB ready (optional layer: projects without an anchordb block\n` +
      `  in the global config still run fully local).\n` +
      `  HTTP   http://127.0.0.1:${httpPort}/health${started ? ' (already responding)' : ''}\n` +
      `  wire   wire://127.0.0.1:${wirePort}\n` +
      `  token  ${token.slice(0, 8)}... (full value in ${globalConfigPath(home)})\n` +
      `  config ${globalConfigPath(home)}\n\n` +
      `Next steps (if this project should use sync):\n` +
      `  1. In your project: knl-view model new knowledges\n` +
      `  2. knl-view, the "anchordb connected" line appears once the graph is in sync\n`
  )
  if (!started) {
    process.stdout.write(
      `  3. Server not started yet; start it manually:\n` +
        `     ~/.knlview/bin/anchordb-server  (env: ANCHORDB_AUTH_TOKEN, ANCHORDB_DATA_DIR)\n`
    )
  }
  if (ownsRl && rl) rl.close()
}

async function waitAnchorHealth(httpPort = HTTP_PORT_DEFAULT, attempts = 30) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${httpPort}/health`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return
    } catch {
      // not ready yet, retry
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`server not responding at http://127.0.0.1:${httpPort}/health within ${attempts / 2} seconds, check the anchordb log`)
}

async function containerExists(runtime) {
  try {
    await exec(runtime, ['container', 'inspect', CONTAINER_NAME])
    return true
  } catch {
    return false
  }
}

// Claims and their agrees_with/contradicts relations live in the AnchorDB
// consensus model; the role must be mapped in the project's models map.
async function runConsensusCommand(sub, args, { settings }) {
  if (!settings.anchordb) {
    fail('Consensus lives in AnchorDB, which is not configured.\n' +
      'Run "knl-view install anchordb" first (optional layer).')
  }
  const consensusModel = settings.models?.consensus
  if (!consensusModel) {
    fail('Role "consensus" is not mapped in this project\'s models map.\n' +
      'Run: knl-view model new consensus')
  }
  const base = anchordbClientOptions(settings.anchordb)
  const client = await createAnchorWireClient({ ...base, model: consensusModel })

  const usage = 'Usage:\n' +
    '  knl-view consensus claim "<statement>"\n' +
    '  knl-view consensus agree <claimId> <otherClaimId>\n' +
    '  knl-view consensus contradict <claimId> <otherClaimId>\n' +
    '  knl-view consensus retract <claimId> <otherClaimId>\n' +
    '  knl-view consensus status <claimId>\n' +
    '  knl-view consensus list'

  const validClaimArg = (value) => {
    if (!CLAIM_ID_RE.test(value || '')) {
      fail(`Not a claim id: "${value || '(empty)'}".\nClaim ids look like c-a1b2c3d4e5f6a1b2; create one with:\n  knl-view consensus claim "<statement>"`)
    }
    return value
  }

  const link = async (type, args) => {
    const [from, to] = args
    validClaimArg(from)
    validClaimArg(to)
    if (from === to) fail('A claim cannot agree with or contradict itself.')
    await client.link(from, type, to, 1.0)
    const { error } = await updateConsensusMirror(consensusModel, { op: 'link', from, type, to })
    if (error) process.stderr.write(`knl-view: mirror not updated (${error})\n`)
    process.stdout.write(`${type}: ${from} -> ${to}\n`)
  }

  if (sub === 'claim') {
    const text = (args || []).join(' ').trim()
    if (!text) fail(`A claim needs a statement.\n${usage}`)
    const { id, error } = await recordClaim(consensusModel, text)
    if (error) process.stderr.write(`knl-view: claim index not updated (${error})\n`)
    process.stdout.write(`claim ${id}\n  "${text}"\n  (relations are created by agree/contradict; status: knl-view consensus status ${id})\n`)
    return
  }

  if (sub === 'agree') return link('agrees_with', args)
  if (sub === 'contradict') return link('contradicts', args)

  if (sub === 'retract') {
    const [from, to] = args
    validClaimArg(from)
    validClaimArg(to)
    for (const type of CONSENSUS_RELATIONS) {
      // Unlinking a missing edge is not an error: retract is idempotent.
      await client.unlink(from, type, to).catch(() => {})
    }
    const { error } = await updateConsensusMirror(consensusModel, { op: 'unlink', from, type: '*', to })
    if (error) process.stderr.write(`knl-view: mirror not updated (${error})\n`)
    process.stdout.write(`retracted: ${from} -/-> ${to}\n`)
    return
  }

  if (sub === 'status' || sub === 'list') {
    const { claims, error } = await readClaimsIndex(consensusModel)
    if (error) process.stderr.write(`knl-view: claim index ignored (${error})\n`)

    const statusOne = async (id) => {
      const mirrorEdges = await readConsensusMirror(consensusModel)
      // null = no mirror file at all; an existing-but-empty mirror is still
      // valid knowledge (everything was retracted). Non-empty mirrors are
      // probed against the server first: it may have been wiped or replaced
      // since the mirror was written; distrust it the same way the
      // knowledges sync does.
      let mirrored = Array.isArray(mirrorEdges)
      if (mirrored && mirrorEdges.length > 0) {
        mirrored = await mirrorStillValid(client, mirrorEdges).catch(() => false)
      }
      const usable = mirrored ? mirrorEdges : null
      const inbound = inboundConsensus(usable || [], id)
      const stance = outboundConsensus(usable || [], id)
      const status = deriveStatus(inbound.supporters, inbound.objectors)
      const text = claims[id]?.text ? ` "${claims[id].text}"` : ''
      process.stdout.write(`${id}${text}\n  status: ${status}${mirrored ? '' : ' (no valid local mirror; relation data unavailable)'}\n`)
      process.stdout.write(`  supporters: ${inbound.supporters.join(', ') || '(none)'}\n`)
      process.stdout.write(`  objectors: ${inbound.objectors.join(', ') || '(none)'}\n`)
      process.stdout.write(`  stance: agrees with ${stance.agrees.join(', ') || '(none)'}; contradicts ${stance.contradicts.join(', ') || '(none)'}\n`)
    }

    if (sub === 'status') {
      await statusOne(validClaimArg(args?.[0]))
      return
    }

    const ids = Object.keys(claims)
    if (!ids.length) {
      process.stdout.write('No claims known locally. Create one:\n  knl-view consensus claim "<statement>"\n')
      return
    }
    for (const id of ids) await statusOne(id)
    return
  }

  fail(`Unknown consensus subcommand: ${sub || '(empty)'}\n${usage}`)
}

// The "sources" subcommands: the whole project as a dependency graph in the
// AnchorDB sources model. Everything lives on the server: file nodes are
// records (list-able), import edges are stored in both directions, and sync
// enumerates the server's own state instead of a local mirror.
async function runSourcesCommand(sub, values, { settings }) {
  if (!settings.anchordb) {
    fail('The sources graph lives in AnchorDB, which is not configured.\n' +
      'Run "knl-view install anchordb" first (optional layer).')
  }
  const sourcesModel = settings.models?.sources
  if (!sourcesModel) {
    fail('Role "sources" is not mapped in this project\'s models map.\n' +
      'Run: knl-view model new sources')
  }
  const base = anchordbClientOptions(settings.anchordb)
  const client = await createAnchorWireClient({ ...base, model: sourcesModel })
  const projectRoot = process.cwd()

  if (sub === 'sync') {
    const result = await syncSourcesToAnchorDB(client, projectRoot, {
      labelDir: settings.labelDir,
      include: settings.include,
      exclude: settings.exclude
    })
    const parts = [
      `${result.files} files`,
      `${result.symbols} symbols`,
      `${result.edges} edges`
    ]
    if (result.linked) parts.push(`+${result.linked} linked`)
    if (result.unlinked) parts.push(`-${result.unlinked} unlinked`)
    if (result.saved) parts.push(`${result.saved} record${result.saved === 1 ? '' : 's'} saved`)
    if (result.tombstoned) parts.push(`${result.tombstoned} tombstoned`)
    if (result.orphans) parts.push(`${result.orphans} ORPHAN EDGES`)
    if (result.labels.written) parts.push(`${result.labels.written} labels written`)
    if (result.labels.deleted) parts.push(`${result.labels.deleted} labels deleted`)
    if (result.failed) parts.push(`${result.failed} FAILED`)
    process.stdout.write(`sources synced: ${parts.join(', ')}\n`)
    if (result.failed) {
      process.stderr.write('knl-view: some operations failed; run "knl-view sources sync" again to retry.\n')
    }
    if (result.tombstoned) {
      await runSourcesCollector(base, sourcesModel, { quiet: false })
    }
    return
  }

  if (sub === 'collect') {
    const purged = await runSourcesCollector(base, sourcesModel, { quiet: false })
    if (!purged) process.stdout.write('nothing to purge: no archived records for this model\n')
    return
  }

  if (sub === 'trace') {
    const target = values.target
    if (!target) {
      fail('Parameter --target is required:\n  knl-view sources trace --target=<repo-relative path> [--hops=2] [--direction=in|out|both]')
    }
    let direction = 'both'
    if (values.direction !== undefined) {
      if (!['in', 'out', 'both'].includes(values.direction)) {
        fail(`--direction must be in, out, or both, got "${values.direction}".`)
      }
      direction = values.direction
    }
    const hops = Number.parseInt(values.hops || '2', 10)
    const maxHops = Number.isInteger(hops) && hops > 0 ? hops : 2
    const { out, in: inc } = await traceSources(client, target, direction, maxHops)
    process.stdout.write(JSON.stringify({
      center: target,
      maxHops,
      direction,
      out: out.map(([id, hop]) => ({ id, hop })),
      in: inc.map(([id, hop]) => ({ id, hop }))
    }, null, 2) + '\n')
    return
  }

  fail('Unknown sources subcommand.\n' +
    'Usage:\n' +
    '  knl-view sources sync\n' +
    '  knl-view sources collect\n' +
    '  knl-view sources trace --target=<repo-relative path> [--hops=2] [--direction=in|out|both]')
}

// Wire cannot start collector jobs, so archived records are purged over
// REST. Best effort: a missing endpoint must not fail a sync.
async function runSourcesCollector(base, model, { quiet }) {
  try {
    const purged = await purgeArchivedRecords(`wire://${base.host}:${base.port}`, base.token, model)
    if (purged) process.stdout.write(`  collector purged ${purged} archived record${purged === 1 ? '' : 's'}\n`)
    else if (!quiet) process.stdout.write('  collector ran: nothing to purge\n')
    return purged
  } catch (err) {
    process.stderr.write(`knl-view: collector unavailable (${err.message}); archived records stay hidden until collected.\n` +
      '  Run "knl-view sources collect" once the REST endpoint is reachable.\n')
    return 0
  }
}

// The "modules" subcommands: on-demand external boundary graph in global
// AnchorDB modules models (modules-npm, modules-go, modules-cargo, modules-pypi).
async function runModulesCommand(sub, args, { values, settings }) {
  if (sub === 'list') {
    const ecoFilter = args?.[0]?.toLowerCase()
    if (ecoFilter && !SUPPORTED_ECOSYSTEMS.has(ecoFilter)) {
      fail(`Unknown ecosystem "${args[0]}". Supported: ${[...SUPPORTED_ECOSYSTEMS].join(', ')}`)
    }
    const ecosystems = ecoFilter ? [ecoFilter] : [...SUPPORTED_ECOSYSTEMS]
    const all = {}
    for (const eco of ecosystems) {
      all[eco] = await readModulesCatalog(eco)
    }
    process.stdout.write(JSON.stringify(all, null, 2) + '\n')
    return
  }

  if (sub === 'build-graph' || sub === 'build') {
    const target = args?.[0] || values.target
    if (!target) {
      fail('Target is required:\n  knl-view modules build-graph <ecosystem>::<module_name> [--force]')
    }
    const parsed = parseModuleSpecifier(target)
    if (!parsed) {
      fail(`Invalid module target "${target}".\nExpected format: <ecosystem>::<module_name> (e.g. npm::express, go::github.com/gin-gonic/gin)`)
    }
    const { ecosystem, moduleName } = parsed

    if (!settings.anchordb) {
      fail('External modules graphs live in AnchorDB, which is not configured.\n' +
        'Run "knl-view install anchordb" first (optional layer).')
    }

    const model = defaultEcosystemModel(ecosystem)
    const base = anchordbClientOptions(settings.anchordb)

    if (!values.force) {
      const manifestVersions = await detectProjectManifests(process.cwd())
      const expectedVersion = manifestVersions[ecosystem]?.[moduleName]
      if (expectedVersion) {
        const already = await isModuleSynced(ecosystem, moduleName, expectedVersion)
        if (already) {
          const catalog = await readModulesCatalog(ecosystem)
          const key = `${moduleName}@${expectedVersion}`
          process.stdout.write(`module ${ecosystem}::${key} is already synced in model ${model} (${catalog[key]?.symbolCount || 0} symbols). Use --force to rebuild.\n`)
          return
        }
      }
    }

    process.stdout.write(`building graph for ${ecosystem}::${moduleName} ...\n`)
    const moduleGraph = await buildModuleGraph(ecosystem, moduleName, { projectRoot: process.cwd() })

    const client = await createAnchorWireClient({ ...base, model })
    try {
      const result = await syncModuleToAnchorDB(client, moduleGraph)
      process.stdout.write(`module synced: ${ecosystem}::${moduleGraph.name}@${moduleGraph.version} -> model "${model}" (${result.symbols} symbols, ${result.edges} edges, +${result.linked} linked)\n`)
    } finally {
      client.close()
    }
    return
  }

  if (sub === 'trace') {
    const rawTarget = args?.[0] || values.target
    if (!rawTarget) {
      fail('Target is required:\n  knl-view modules trace <ecosystem>::<module_name> [symbol] [--hops=2] [--direction=in|out|both]')
    }

    let ecosystem, symbolId
    if (rawTarget.startsWith('ext:')) {
      const m = rawTarget.match(/^ext:([a-z]+)\//)
      if (!m) fail(`Cannot determine ecosystem from node ID "${rawTarget}".`)
      ecosystem = m[1]
      symbolId = rawTarget
    } else {
      const parsed = parseModuleSpecifier(rawTarget)
      if (!parsed) {
        fail(`Invalid module target "${rawTarget}".\nExpected format: <ecosystem>::<module_name> [symbol]`)
      }
      ecosystem = parsed.ecosystem
      const catalog = await readModulesCatalog(ecosystem)
      const subSymbol = args?.[1]
      const entryKey = Object.keys(catalog).find((k) => k.startsWith(parsed.moduleName + '@') || k === parsed.moduleName)
      if (!entryKey) {
        fail(`Module "${rawTarget}" is not indexed in catalog ~/.knlview/modules/${ecosystem}.json.\nRun "knl-view modules build-graph ${rawTarget}" first.`)
      }
      const entry = catalog[entryKey]
      symbolId = subSymbol ? `${entry.nodeId}#${subSymbol}` : entry.nodeId
    }

    if (!settings.anchordb) {
      fail('The modules graph lives in AnchorDB, which is not configured.\n' +
        'Run "knl-view install anchordb" first.')
    }

    const model = defaultEcosystemModel(ecosystem)
    const base = anchordbClientOptions(settings.anchordb)
    const client = await createAnchorWireClient({ ...base, model })
    try {
      let direction = 'both'
      if (values.direction !== undefined) {
        if (!['in', 'out', 'both'].includes(values.direction)) {
          fail(`--direction must be in, out, or both, got "${values.direction}".`)
        }
        direction = values.direction
      }
      const hops = Number.parseInt(values.hops || '2', 10)
      const maxHops = Number.isInteger(hops) && hops > 0 ? hops : 2
      const results = await traceModuleSymbol(client, symbolId, { direction, maxHops })
      process.stdout.write(JSON.stringify({
        center: symbolId,
        model,
        direction,
        maxHops,
        trace: results
      }, null, 2) + '\n')
    } finally {
      client.close()
    }
    return
  }

  fail('Unknown modules subcommand.\n' +
    'Usage:\n' +
    '  knl-view modules build-graph <ecosystem>::<module_name> [--force]\n' +
    '  knl-view modules trace <ecosystem>::<module_name> [symbol] [--hops=2] [--direction=in|out|both]\n' +
    '  knl-view modules list [ecosystem]')
}

function fail(message) {
  process.stderr.write(`knl-view: ${message}\n`)
  process.exit(1)
}

// The "model new" and "model check" commands manage the role → AnchorDB
// model name map. Names may be random; what gives them meaning is this map
// plus the global registry ~/.knlview/models.json (owner of every name).

async function runModelCommand(sub, roleArg, { projectConfig, settings }) {
  if (sub === 'new') {
    const role = (roleArg || '').trim().toLowerCase()
    if (!MODEL_ROLE_RE.test(role)) {
      fail(`Role must be a lowercase slug (letters, digits, -, _), got "${roleArg || '(none)'}".\nExample: knl-view model new knowledges`)
    }
    const existing = settings.models?.[role]
    if (existing) {
      fail(`Role "${role}" is already mapped to model "${existing}".\nEdit knl-config.json if you really want to change it.`)
    }
    const name = generateModelName()
    const { previous, error } = await registerModel(name, {
      role,
      project: projectSlug(process.cwd()),
      cwd: process.cwd()
    })
    if (error) fail(`Failed to write registry (${error}). The new name is not used.`)
    if (previous) {
      fail(`Name "${name}" is already used by another project (${previous.cwd}) for role "${previous.role}".\nRun again for a new name.`)
    }
    const next = { ...projectConfig, models: { ...(projectConfig?.models || {}), [role]: name } }
    delete next.model // the map replaces the legacy "model" shape
    fs.writeFileSync(path.join(process.cwd(), 'knl-config.json'), JSON.stringify(next, null, 2) + '\n', 'utf8')
    process.stdout.write(
      `model ${name} → role ${role}\n` +
        `  knl-config.json: models.${role} = "${name}"\n` +
        `  registry: ${modelRegistryPath()}\n`
    )
    return
  }

  if (sub === 'check') {
    const { models: registry, error } = await readModelRegistry()
    if (error) process.stderr.write(`knl-view: ignoring registry (${error})\n`)
    const cwd = path.resolve(process.cwd())
    const map = settings.models || {}
    const roles = Object.keys(map)
    process.stdout.write(`Models map of this project (${projectSlug(cwd)}):\n`)
    if (!roles.length) {
      process.stdout.write('  (empty, run "knl-view model new knowledges")\n')
    }
    for (const role of roles) {
      const name = map[role]
      const entry = registry[name]
      const owner = entry ? `${entry.project}/${entry.role}` : 'not registered'
      const clash = entry && path.resolve(entry.cwd || '') !== cwd
      process.stdout.write(`  ${role.padEnd(12)} ${name}  (${owner}${clash ? ' - CLASH: claimed by ' + entry.cwd : ''})\n`)
    }
    const others = Object.entries(registry).filter(([, e]) => path.resolve(e.cwd || '') !== cwd)
    if (others.length) {
      process.stdout.write('Models of other projects in the registry:\n')
      for (const [name, e] of others) {
        process.stdout.write(`  ${name}  → ${e.project}/${e.role}  (${e.cwd})\n`)
      }
    }
    process.stdout.write('Note: model existence on the server cannot be checked over the wire protocol;\n')
    process.stdout.write('what is checked here is map consistency, the registry, and name ownership.\n')
    return
  }

  fail(`Unknown model command: ${sub || '(none)'}\nUse "model new <role>" or "model check".`)
}
