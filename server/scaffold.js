import { promises as fs } from 'node:fs'
import path from 'node:path'

// Knowledge base builder for --init and --seed-skill.
// Same principle as the map: NEVER destroy anything that already exists.
// Existing files are skipped, and the .gitignore line is only added when
// not already present.

export const STANDARD_DIRS = ['roadmap', 'features', 'docs']
export const SKILL_ID = 'knl-view'

const ROOT_README = `# Knowledge Base

Lede: write a one-paragraph summary of this base here.

## How to read

- \`roadmap/\` — direction and plans.
- \`features/\` — feature notes.
- \`docs/\` — general documents.

Add \`map.json\` to this folder if you want to control menu labels and
display order without moving files. See the \`knl-view\` skill for the
full format.
`

const SECTION_README = (name) => `# ${name}

Nothing here yet. Put markdown files in this folder.
`

export async function scaffoldBase({ root, structure, folders = [] }) {
  const actions = []
  await fs.mkdir(root, { recursive: true })
  actions.push({ kind: 'dir', path: root, status: 'created' })

  if (structure === 'empty') return actions

  const dirs = structure === 'custom' ? folders.map(cleanRel).filter(Boolean) : STANDARD_DIRS

  await writeFileSafe(path.join(root, 'README.md'), ROOT_README, actions)
  for (const dir of dirs) {
    const abs = path.join(root, dir)
    await fs.mkdir(abs, { recursive: true })
    actions.push({ kind: 'dir', path: abs, status: 'created' })
    await writeFileSafe(path.join(abs, 'README.md'), SECTION_README(dir), actions)
  }
  return actions
}

export async function seedSkill({ scope, cwd, home = process.env.HOME, xdgConfig = process.env.XDG_CONFIG_HOME }) {
  const base =
    scope === 'global'
      ? path.join(xdgConfig || path.join(home, '.config'), 'opencode', 'skills')
      : path.join(cwd, '.agents', 'skills')
  const target = path.join(base, SKILL_ID, 'SKILL.md')

  const exists = await statOrNull(target)
  if (exists) return { path: target, status: 'skipped' }

  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, SKILL_MD, 'utf8')
  return { path: target, status: 'created' }
}

export async function ensureGitignore({ cwd }) {
  const abs = path.join(cwd, '.gitignore')
  const line = '.knowledges/'
  let content = ''
  const stat = await statOrNull(abs)
  if (stat && stat.isFile()) content = await fs.readFile(abs, 'utf8')

  const present = content.split(/\r?\n/).some((row) => row.trim() === line || row.trim() === '.knowledges')
  if (present) return { path: abs, status: 'skipped' }

  const next = content.length && !content.endsWith('\n') ? `${content}\n${line}\n` : `${content}${line}\n`
  await fs.writeFile(abs, next, 'utf8')
  return { path: abs, status: 'created' }
}

async function writeFileSafe(abs, content, actions) {
  const exists = await statOrNull(abs)
  if (exists) {
    actions.push({ kind: 'file', path: abs, status: 'skipped' })
    return
  }
  await fs.writeFile(abs, content, 'utf8')
  actions.push({ kind: 'file', path: abs, status: 'created' })
}

function cleanRel(value) {
  return String(value).trim().replace(/^\/+/, '').replace(/\/+$/, '')
}

async function statOrNull(abs) {
  try {
    return await fs.stat(abs)
  } catch {
    return null
  }
}

// The skill is in English, following skill ecosystem conventions. It teaches
// the agent how to read the .knowledges base: README first, then map.json as
// the source of labels and menu order, then the anchor-connector-like
// structure.
const SKILL_MD = `---
name: knl-view
description: Read and maintain .knowledges knowledge bases. Use whenever a task involves a .knowledges folder, its map.json, or the knl-view viewer.
---

# Knowledges base

A \`.knowledges\` folder is a plain-directory knowledge base, viewed with
knl-view. The disk is the source of truth: files and folders exist because
they exist on disk, never because a map says so.

## Read in this order

1. \`README.md\` at the base root: the lede and the overview.
2. \`map.json\` at the base root, when present: the authoritative menu
   labels, grouping, and order for everything below.
3. Then the structure the map (or the disk) describes. A typical base
   mirrors anchor-connector: \`roadmap/\`, \`features/\`, \`futures/\`,
   \`audit/\`, \`roasted/\`, plus root files \`coding-rules.md\` and
   \`documentation-rules.md\`. Anything not on disk does not exist; do not
   invent it from map entries.

## map.json

Optional. Every entry is decoration only. It sets the label shown in the
menu, the order in menus, and a short note. It never creates, moves, or
deletes files. Entries pointing at paths that are not on disk are ignored
silently. Without \`map.json\`, the viewer falls back to the first
\`# heading\` of each markdown file and plain name order: files first,
then folders.

\`\`\`json
{
  "title": "Base title shown in the masthead",
  "sections": {
    "roadmap": { "title": "Roadmap", "order": 1, "meta": "Where this is going" },
    "features": {
      "title": "Features",
      "order": 2,
      "docs": { "auth.md": { "title": "Auth", "order": 1 } }
    }
  },
  "docs": {
    "coding-rules.md": { "title": "Coding rules", "order": 1 },
    "documentation-rules.md": { "title": "Documentation rules", "order": 2 }
  },
  "files": {
    "personal-assistant.md": { "title": "Personal Assistant" },
    "rahasia.md": { "ignore": true }
  },
  "dirs": {
    "draft-lama": { "ignore": true }
  }
}
\`\`\`

| Field | Applies to | Effect |
| --- | --- | --- |
| \`title\` | the whole file | Masthead title; wins over the README heading |
| \`sections.<dir>\` / \`dirs.<path>\` | a directory | \`title\` is the menu label, \`meta\` is a short note |
| \`sections.<dir>.docs.<file>\` | a file inside that directory | same shape as \`docs\` entries |
| \`docs.<file>\` / \`files.<path>\` | a file | \`title\` is the menu label |
| \`order\` | any entry | Ascending menu order. Entries without \`order\` follow, still files before folders |
| \`ignore\` (or \`hidden\`) | any entry | \`true\` hides the file or folder from the menu, lists, search, home, and contents. Hiding a folder hides everything inside it |

\`ignore\` is view-only: the file still exists on disk. Remove the flag to
bring it back:

\`\`\`json
{ "files": { "rahasia.md": { "ignore": true } }, "dirs": { "draft-lama": { "ignore": true } } }
\`\`\`

Paths are relative to the \`.knowledges\` root, use \`/\` separators, and
must match the on-disk path exactly as the viewer shows it, for example
\`features/auth.md\`. Nested folders use the full relative path as the key.

The sidebar always opens with two fixed entries above the tree: \`index\`
(the root \`README.md\`) and \`contents\` (\`#/a/contents\`, a system route with
no file on disk that lists the whole base). The root README is therefore
not repeated inside the tree.

## Config (two layers)

knl-view reads two optional config files. A missing file is never an error;
a broken file is ignored with one warning.

**Global: \`~/.knlview/knl-config.json\`** — shared by every project on this
machine. Holds the \`anchordb\` block (connection). Without it, AnchorDB
stays completely off:

\`\`\`json
{
  "anchordb": {
    "url": "wire://127.0.0.1:7448",
    "token": "your-token",
    "sync": true
  }
}
\`\`\`

**Per project: \`knl-config.json\` at the project root** — machine-local,
gitignored. Holds only \`path\`, \`port\`, \`host\`, and the \`models\` map:

\`\`\`json
{
  "path": ".knowledges",
  "port": 8085,
  "models": { "knowledges": "vez0vqrp" }
}
\`\`\`

The map owns model naming: role → AnchorDB model name, names may be
random — the map records what each name is for, and names stay stable
across project renames. Create names with \`knl-view model new <role>\`
and inspect ownership with \`knl-view model check\`. Without a map entry
for a role, that role runs fully local. CLI flags always win over
config values.

Installing AnchorDB (optional — the viewer runs fully local without it):
\`knl-view install anchordb\` — native binary from GitHub Releases on
Linux and macOS (SHA256-verified), or a container from
ghcr.io/rachmanzz/anchordb via docker/podman on other platforms. Flags:
\`--yes\`, \`--method=binary|container\`, \`--token=...\`.

Two-way lineage: graph traces take \`--direction\` (CLI) or
\`?direction=\` (HTTP) — \`out\` follows edges leaving the target, \`in\`
follows edges entering it, \`both\` is the local default. Direction is
mechanical (edge direction), never cause-and-effect interpretation.
Each node in the result carries \`via\` (\`center\`, \`in\`, \`out\`,
\`in+out\`). On /api/anchordb/trace the default is \`out\`; \`in\` is
walked backwards from the local sync mirror and reported with
\`mirrored: true\`.

Consensus (claims): a second AnchorDB model — the \`consensus\` role in
the models map — holds agreement and conflict between claims only (never
decisions or files). Claims are content-addressed:
\`knl-view consensus claim "<statement>"\` prints the id (\`c-\` + 16 hex
chars of the statement hash); the same text is the same claim everywhere.
Relations: \`agree\`, \`contradict\`, \`retract\` — all take two claim
ids. \`status <id>\` derives: any incoming \`contradicts\` → \`disputed\`,
else incoming \`agrees_with\` → \`consensus\`, else \`uncontested\`.
\`list\` shows every locally known claim. Mutations are CLI-only;
\`GET /api/consensus?target=<claimId>\` is read-only. Requires AnchorDB
plus a mapped \`consensus\` role.

Sources graph (whole project): a third AnchorDB model, the \`sources\`
role, holds the dependency graph of the whole project — files and their
named symbols. Every file is a node (id = repo-relative path); import
edges are extracted with tree-sitter syntax parsing (JS family and Go
today) and stored in both directions (\`imports\`, \`imported_by\`).
Each file also defines symbol nodes: ids are \`<path>#<name>\` (class
methods \`Class.method\`; a name defined more than once in one file gets
a line suffix \`<path>#<name>@<line>\`), kinds are \`function\`,
\`class\`, \`method\`, \`type\`. Edges: \`defines\`/\`defined_in\`
(file → symbol) and \`calls\`/\`called_by\` (symbol → symbol), both
directions stored. Call resolution is conservative: the call belongs to
its innermost enclosing symbol and the callee must match exactly one
definition project-wide — ambiguous names are skipped, never guessed.
Label text (symbol names and kinds; AnchorDB attributes are
numeric-only) lives in \`.knowledges/.knl-data/<path>.md\`, one file per
source file that has symbols; override with \`labelDir\` in the project
config. Hidden folders are skipped except .github; node_modules, dist,
and .gitignore patterns are ignored. \`knl-view sources sync\` is
idempotent and server-authoritative (no local mirror);
\`knl-view sources trace --target=<id>\` and
\`GET /api/sources/trace?target=<id>\` answer lineage — a target
containing \`#\` walks symbol lineage (\`calls\`/\`called_by\`), a
plain path walks file lineage (\`imports\`/\`imported_by\`). A removed
file or symbol is tombstoned (attribute \`tombstone = 2\`) after its
edges are unlinked; if it comes back, the tombstone lifts and the edges
are relinked.

Decision history skill: recording architectural decisions is delegated
to the separate decision-history skill (its decision block format is its
own domain; this skill never writes decision blocks). If it is not
installed in the project yet, install it first:
\`npx skills add rachmanzz/decisionskills --skill decision-history\`
or, with agy: \`agy plugin install https://github.com/rachmanzz/decisionskills\`.

## Rules

- Never move or delete files to satisfy the map. Either add the file or
  remove the stale map entry.
- Give every markdown file a top-level \`# heading\` so it still reads well
  when no map entry covers it.
- Keep \`order\` values small and dense per menu level (1, 2, 3).
- When the map and disk disagree about existence, the disk wins.

## Features writing rules

Under \`features/{feature_name}/\`, prefer to keep at least:
- \`prd.md\` — Product Requirements Document for this feature
- \`detail-plan.md\` — concrete implementation plan, decisions, trade-offs

Names are kebab-case for the folder. Keep other artifacts minimal and cover
them via \`map.json\` if they need custom menu labels/order.

## Futures writing rules

Under \`futures/\`, the base typically has:
- \`README.md\` — vision/overview
- \`prd.md\` — global PRD covering proposed future work

Use kebab-case for any additional future documents. Defer exotic filenames
to \`map.json\`.

## Roadmap writing rules

Under \`roadmap/\`, maintain milestone-oriented notes. Keep \`README.md\` as
the index and split by milestones only when they grow large. Use
\`map.json\` to reorder milestones/files without renaming.

## Roasted writing rules

All artifacts from roasting/audits go under \`roasted/\` (relative to the
knowledge base root in use; i.e. the directory passed via \`--path\`, which
may be \`.knowledges\` or a custom one). Do **not** place them in the root
of that directory.

### Naming

\`roasted/{roasted_name}_v{number}.md\` — kebab-case name, integer
\`number\` starting at \`1\`.

### Stack order

- \`_v1\` is the first roast → placed at the bottom of the stack
- each new roast increments number and goes at the top (highest number =
  newest)
- files are immutable by number; updates belong to the same file, not a
  new one

### Classification

Every roast must state:
- \`Severity\`: \`P0|P1|P2|P3\`
- \`Class\`: \`BUG|PERF|VULN|DEBT|CEILING|PROSES\`

## When the agent triggers the graph

The graph stays true only if the agent feeds it. Every trigger goes
through the single \`knl-view\` entrypoint with the existing subcommands
below; never invent another binary, script, or wrapper to fire any of
this.

- After creating, editing, renaming, or deleting any project file:
  run \`knl-view sources sync\`. It is server-authoritative and
  idempotent: run it again and only the difference is applied.
- Before changing a file that other files may depend on:
  \`knl-view sources trace --target=<path> --direction=in\` shows who
  depends on it first (the blast radius).
- Before adding an import to, or moving logic out of, another file:
  \`knl-view sources trace --target=<path> --direction=out\` shows what
  it already touches.
- Before changing or removing a function, method, or type:
  \`knl-view sources trace --target=<path>#<name> --direction=in\` shows
  every symbol that calls it first.
- Before renaming a symbol or moving it to another file: remember its
  record id contains the old name/path. Sync tombstones the stale record
  and creates the new one; trace by the new id afterwards.
- A new architectural decision: trigger the decision-history skill
  (install it first if missing — see "Decision history skill" above).
  The decision block format is that skill's domain; this skill never
  writes decision blocks.
- A technical disagreement worth recording as claims:
  \`knl-view consensus claim "<statement>"\`, then
  \`knl-view consensus agree <id> <id>\` or
  \`knl-view consensus contradict <id> <id>\`. A claim that lost its
  ground: \`knl-view consensus retract <id> <id>\`.
`
