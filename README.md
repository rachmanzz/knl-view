# knl-view

A local viewer and graph engine for `.knowledges` knowledge bases: a CLI that serves a small web app over a plain folder of Markdown files and tracks project architecture lineage. The disk is the source of truth; `map.json` is optional decoration.

```sh
knl-view --port 8086 --path=.knowledges
```

## Collaboration Model: Human, AI, and AnchorDB

`knl-view` is built around a practical three-way collaboration model that aligns AI coding agents with human intent while keeping context windows clean and efficient:

### 1. The Human Foundation (`.knowledges`)
- **Single Source of Truth**: The human architect defines the system architecture, domain constraints, feature roadmaps, and audit notes in `.knowledges/`.
- **Human-in-the-Loop**: AI agents can assist in drafting and organizing documentation, but the human validates and approves business logic and architectural boundaries. This ensures coding agents have an unambiguous reference rather than guessing intent.

### 2. Decision History (`decision-history`)
- **Traceable Decision Records**: Major architectural choices, technical trade-offs, and strategic pivots are recorded as append-only records using the [`decision-history`](https://github.com/rachmanzz/decisionskills) skill.
- **Context Continuity**: Future AI agent sessions read these records to understand *why* specific patterns exist, preventing agents from re-introducing rejected approaches or modifying agreed-upon architectures without context.

### 3. Graph Storage & Dependency Efficiency (`AnchorDB`)
- **Structured Dependency Graphs**: AnchorDB stores indexed relationships for project source code (`sources`) and third-party libraries (`modules-npm`, `modules-go`, etc.) as nodes and edges.
- **Targeted Lineage Queries**: Instead of dumping large code files or entire dependency trees into LLM context, AI agents query specific caller/callee and import relationships via `knl-view sources trace` and `knl-view modules trace`.
- **Pre-Edit Impact Analysis**: Agents identify the exact blast radius of changes before modifying code, speeding up dependency analysis and conserving context tokens without guessing.

### 4. Autonomous Agent Execution
- Standardized operating rules are seeded into `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and project skills via `knl-view setup`.
- AI coding agents (Antigravity, Claude Code, Cursor, OpenCode) execute graph traces before editing, build module graphs on-demand, and sync changes back to AnchorDB autonomously. Developers assign tasks normally while agents manage graph operations in the background.

## What it does

- Serves a web viewer over any folder of Markdown files. No database, no build step for your content, no account.
- Sidebar tree with a fixed `index` entry (the root `README.md`) and a `contents` entry that lists the whole base on one page.
- Folders open their own `README.md`, rendered the same way as a normal document.
- `map.json` (optional) relabels, reorders, or hides entries in the menu. It never creates, moves, or deletes files. Entries pointing at paths that are not on disk are ignored silently.
- Markdown with GFM tables, and triple-backtick fences tagged `mermaid` rendered as diagrams. The mermaid bundle is served locally and loaded only when a document contains a diagram; nothing is fetched from a CDN.
- Per-diagram controls: toggle between diagram and source, and a zoom modal (wheel zoom, drag to pan, +/−/Reset, Esc to close).
- Table of contents per document, breadcrumb, and a filter box in the sidebar that narrows the index by file title or path.
- Interface in English or Indonesian, switchable in the top bar. English is the default.
- Whole-project dependency and symbol call graph extraction via WebAssembly Tree-Sitter for JavaScript, TypeScript, Go, Python, and Rust.

## How to Set Up

Setting up a project takes a single command:

```sh
knl-view setup
```

Or run directly without installing:

```sh
npx @rahmantech/knl-view setup
```

### What `knl-view setup` Does Automatically
1. **Scaffolds `.knowledges/`**: Creates the documentation directory with a starter `README.md` index and template folders (or custom folders via `--folders`).
2. **Installs Agent Skills**: Automatically places the `knl-view` skill into `.agents/skills/knl-view/` so coding agents (Antigravity, Claude, Codex, OpenCode) can read and manage your knowledge base.
3. **Integrates Decision History**: Audits and offers to install the `decision-history` skill ([decisionskills](https://github.com/rachmanzz/decisionskills)) for append-only architecture decision tracking.
4. **Protects Configuration**: Ensures `.gitignore` includes `.knowledges/` and `knl-config.json`.
5. **Auto-maps AnchorDB Models**: Configures `knowledges` and `sources` model identifiers in `knl-config.json` and records them in the machine-wide registry.
6. **Provisions AnchorDB**: Prompts to start or provision an AnchorDB instance, using the same install methods as `knl-view install anchordb`.
7. **Seeds Agent Rules**: Configures standardized KNL-View instructions in `AGENTS.md`, `GEMINI.md`, and `CLAUDE.md`.

After setup, start the viewer immediately:

```sh
knl-view
```

## Requirements & Installation

### Requirements

- Node.js 20.19 or newer.
- A built frontend. The npm tarball ships one; a git checkout does not (`dist/` is not tracked in this repository), so run `npm run build` after cloning. The CLI refuses to start without it and tells you so.

### Install

```sh
npm install -g @rahmantech/knl-view
```

That puts the `knl-view` command into Node's global bin, `$(npm prefix -g)/bin`. If that directory is not on your PATH, link the command somewhere that is:

```sh
ln -s "$(npm prefix -g)/bin/knl-view" ~/.local/bin/knl-view
```

The published tarball ships the built `dist/`, so the install compiles nothing.

Run it once without installing:

```sh
npx @rahmantech/knl-view
```

Or install from source, for a local checkout or an unreleased commit:

```sh
git clone https://github.com/rachmanzz/knl-view.git
cd knl-view
npm install
npm run build
npm link
```

`npm link` puts `knl-view` on your PATH from the checkout; the `npm run build` step above is required, because `dist/` is not tracked in git.

## Usage

```sh
knl-view setup                             # bootstrap project (scaffold base, skill, gitignore, models)
knl-view                                   # serve ./.knowledges on 127.0.0.1:8085
knl-view --path=../other-project/.knowledges
knl-view --port 8086 --host 0.0.0.0        # expose on the network
knl-view graph trace --target=README.md    # query on-demand subgraph for AI
knl-view graph trace --target=DEC-20261030-135001 --hops=1
knl-view --init                            # scaffold a new base (wizard, no server)
knl-view --seed-skill=knl-view --dir=global --yes
```

| Flag | Default | What it does |
| --- | --- | --- |
| `--port`, `-p` | `8085` | HTTP port |
| `--path` | `.knowledges` | Folder to serve, relative to the working directory |
| `--host` | `127.0.0.1` | Bind address |
| `--anchordb` | none | AnchorWire URL (`wire://host:port?token=...`) for this session; overrides the global config block |
| `--target` | none | Target node ID for CLI subgraph trace (`knl-view graph trace`) |
| `--hops` | `2` | Traversal depth radius for subgraph extraction |
| `--method` | auto | Install method for `install anchordb`: `binary` or `container` |
| `--runtime` | auto | Container runtime for `install anchordb`: `docker` or `podman` |
| `--init` | off | Scaffold a new base interactively; does not start the server |
| `--structure` | `standard` | Layout for a non-interactive `--init`: `standard`, `empty`, or `custom` |
| `--folders` | none | Comma-separated folder names for `--structure=custom` |
| `--seed-skill=knl-view` | off | Write the `knl-view` skill for coding agents; skipped if it already exists |
| `--dir` | `project` | Skill location: `project` (`.agents/skills`) or `global` (`~/.config/opencode/skills`) |
| `--yes`, `-y` | off | Accept every default in `--init` / `--seed-skill`, no questions asked |
| `--help`, `-h` | | Show help |
| `--version`, `-v` | | Show version |

The server binds to `127.0.0.1` by default, so it is reachable only from your machine unless you pass `--host` yourself. There is no authentication; treat `--host 0.0.0.0` as a decision you are making on purpose.

## How a Knowledge Base is Read

A base is an ordinary folder:

```
.knowledges/
  README.md          # the index document
  map.json           # optional
  roadmap/
    README.md
    q1.md
  features/
    auth.md
```

Reading order: the root `README.md`, then `map.json` when present, then the structure on disk. Without `map.json`, menu labels fall back to the first `# heading` of each file, then to the plain file name (files before folders).

### map.json

Every entry is decoration. Nothing in it can invent a file that is not on disk.

```json
{
  "title": "Base title shown in the masthead",
  "sections": {
    "roadmap": { "title": "Roadmap", "order": 1, "meta": "Where this is going" }
  },
  "docs": {
    "coding-rules.md": { "title": "Coding rules", "order": 1 }
  },
  "files": {
    "secret.md": { "ignore": true }
  },
  "dirs": {
    "old-drafts": { "ignore": true }
  }
}
```

| Field | Applies to | Effect |
| --- | --- | --- |
| `title` | the whole file | Masthead title; wins over the README heading |
| `sections.<dir>` / `dirs.<path>` | a directory | `title` is the menu label, `meta` is a short note |
| `docs.<file>` / `files.<path>` | a file | `title` is the menu label |
| `order` | any entry | Ascending menu order; entries without `order` follow, files before folders |
| `ignore` (or `hidden`) | any entry | `true` hides it from the menu, lists, search, home, and contents |

Paths are relative to the `.knowledges` root, use `/` separators, and must match the on-disk path exactly, for example `features/auth.md`. `ignore` is view-only: the file stays on disk. Remove the flag to bring it back.

The full field reference lives in the bundled skill: `.agents/skills/knl-view/SKILL.md`.

## AI Graph & Decision Tracing

`knl-view` includes an AI-native directed acyclic graph (DAG) engine built directly into the CLI and server. It connects knowledge documents (`.knowledges/*.md`) and architectural decision records (`.knowledges/decisions/*.md`) into a unified graph:

- **Zero Intermediary File**: Fully on-the-fly in-memory processing. Markdown files remain the sole source of truth without generating out-of-sync `graph.json` cache files.
- **Decision Lineage Tracking**: Automatically discovers `supersedes`, `related_to`, and `affects_knowledge` edges from `decisionskills` decision blocks.
- **Low-Token Subgraphs for AI**: Instead of loading an entire knowledge base into LLM context, query exact $N$-hop subgraphs on demand.

This engine is fully local: it needs no AnchorDB and no network. AnchorDB (see the optional install below) adds persistence on top: edges survive across sessions, are synced incrementally, and can be traced from any machine pointing at the same server.

### Two-way lineage

Traces walk in a mechanically defined direction relative to the edges, never interpreted as cause and effect (`depends_on` edges *leave* a decision while pointing at its upstream, so up/down labels would lie):

- `direction=out`: edges leaving the target: what it supersedes, `depends_on`, or affects.
- `direction=in`: edges entering the target: what references or replaces it.
- `direction=both`: the default for the local graph trace; the full neighborhood.

Every returned node carries `via` (`center`, `in`, `out`, or `in+out`) telling how it connects to the trace center.

CLI: `knl-view graph trace --target=<id> --direction=out`  
HTTP: `GET /api/graph/trace?target=<id>&direction=in`

The AnchorDB endpoint adds the same parameter, `GET /api/anchordb/trace?target=<id>&direction=in|out|both` (default `out`): `out` is scored server-side via `causalChain`; `in` is walked backwards from the local sync mirror; the wire protocol has no reverse query, and the mirror holds every edge this project ever linked, so it is exactly the inbound map for this project's model. Mirror results carry score 1 and the response reports `mirrored: true`/`false` so consumers know which half came from where.

### Consensus (claims)

A second AnchorDB model, the `consensus` role in the project's models map, holds agreement and conflict between *claims*: short statements that are content-addressed (`c-` + 16 hex chars of the statement's hash), so the same text is the same claim on every machine. Claims relate only to other claims, through two fixed relation types: `agrees_with` and `contradicts`. The consensus structure lives purely in AnchorDB; the local artifacts (claim index in `~/.knlview/claims/`, edge mirror in `~/.knlview/sync-state/`) are caches that degrade convenience, never the data.

A claim's status is derived from who points at it: any incoming `contradicts` makes it `disputed`, otherwise any incoming `agrees_with` makes it `consensus`, otherwise it is `uncontested`.

```sh
knl-view consensus claim "We use bcrypt for password hashing"
knl-view consensus agree c-a1b2c3d4e5f6a1b2 c-437ff9f10f83edde
knl-view consensus contradict c-a1b2c3d4e5f6a1b2 c-437ff9f10f83edde
knl-view consensus retract c-a1b2c3d4e5f6a1b2 c-437ff9f10f83edde
knl-view consensus status c-437ff9f10f83edde
knl-view consensus list
```

Mutations are CLI-only on purpose: one write path, one mirror kept honest. The read-only HTTP endpoint answers "is this claim settled?":

`GET /api/consensus?target=<claimId>` returns the claim's `status`, `supporters`, `objectors`, its own `stance`, `mirrored` (whether a valid local mirror backs the inbound half), and a `statements` map of the claim texts involved. Returns `503` when AnchorDB is off or the `consensus` role is not mapped.

### Sources graph (whole project)

A third AnchorDB model, the `sources` role in the models map, holds the dependency graph of the whole project, not just `.knowledges`. Every file becomes a node (id = repo-relative path; hidden folders are skipped except `.github`, and `node_modules`, `dist`, and `.gitignore` patterns are ignored). Import edges are extracted with tree-sitter syntax parsing (JavaScript, TypeScript/TSX, Go, Python, and Rust, one grammar package per language family) and stored in both directions (`imports`, `imported_by`) so lineage works without any local mirror: sync is server-authoritative, enumerating the server's own records and edges before applying the difference from a fresh disk scan.

Each file also defines **symbol nodes**, extracted from the same parse:

- Symbol ids are `<path>#<name>`; class methods are `Class.method`. A name defined more than once in one file gets a line suffix (`<path>#<name>@<line>`), so duplicate helpers stay distinct records.
- Kinds: `function`, `class`, `method`, `type`, `interface`, `enum`, `struct`, `trait`.
- Edges: `defines`/`defined_in` (file → symbol) and `calls`/`called_by` (symbol → symbol), each stored in both directions because causalChain walks forward only.
- Call resolution is conservative: a call belongs to its innermost enclosing symbol, and the callee must match exactly one definition project-wide (same package directory preferred in Go). A receiver-qualified call (`obj.Method()`) resolves only when the receiver is an import binding of the file, otherwise it is skipped, never guessed.
- Label text (symbol names and kinds; AnchorDB attributes are numeric-only) is written to `.knowledges/.knl-data/<path>.md`, one file per source file that has symbols; override the location with `labelDir` in the project config. Labels are regenerated and pruned on every sync.

#### Supported Languages (v0.3.1)

Tree-sitter WASM grammars run in-memory within Node.js without requiring host compilers:

| Language | Extensions | Extracted Symbols | Import Resolution |
| :--- | :--- | :--- | :--- |
| **JavaScript** | `.js`, `.mjs`, `.cjs`, `.jsx` | `function`, `class`, `method` | ESM (`import`/`export`), dynamic `import()`, CJS `require()` |
| **TypeScript** | `.ts`, `.mts`, `.cts`, `.tsx` | `function`, `class`, `method`, `interface`, `type`, `enum` | ESM/CJS, automatic resolution of `.js` specifiers to `.ts`/`.tsx` on disk |
| **Go** | `.go` | `function`, `method` (receiver-qualified), `type` | `go.mod` module-internal packages |
| **Python** | `.py` | `function`, `class`, `method` | Relative imports (`.local`, `..pkg`) and dot-separated package paths |
| **Rust** | `.rs` | `function`, `method` (`impl`), `struct`, `enum`, `trait`, `type` | `mod <name>;`, `use crate::`, `use super::`, `use self::` |

#### Upcoming Languages (Planned for Next Versions)

Support for additional languages via WebAssembly Tree-Sitter grammars will be added in upcoming releases:

- **Java** (`.java`): Class, interface, record, method extraction, package imports
- **C / C++** (`.c`, `.h`, `.cpp`, `.hpp`): Functions, structs, classes, `#include` resolution
- **C#** (`.cs`): Classes, structs, interfaces, methods, namespaces/using
- **Ruby** (`.rb`): Modules, classes, methods, `require_relative`
- **PHP** (`.php`): Classes, interfaces, traits, functions, namespaces/use

```sh
knl-view model new sources
knl-view sources sync
knl-view sources collect
knl-view sources trace --target=server/index.js --direction=out --hops=2
knl-view sources trace --target=server/index.js#handleTrace --direction=in
```

`sync` is idempotent: run it again after refactoring and only the difference is applied. A target containing `#` traces symbol lineage over `calls`/`called_by`; a plain path traces file lineage over `imports`/`imported_by`. Records the disk no longer has are archived with the native lifecycle opcode 2 (TOMBSTONE: the server hides them from list and lookups) after their edges are unlinked, and the `tombstone = 2` attribute stays as a marker for servers that predate opcode support. `sync` then asks the REST collector to purge those records physically (scoped to the model); run `knl-view sources collect` by hand if the REST endpoint was unreachable at that moment. A reappearing file revives the record with a normal save and relinks its edges. Sync reports `ORPHAN EDGES` when an edge endpoint failed to save, so a broken sync is never silent. The read-only HTTP endpoint answers the same queries: `GET /api/sources/trace?target=<id>&direction=in|out|both&hops=N`.

### External Modules Graph (On-Demand Module Boundary)

AI agents can parse, index, and trace third-party dependencies on-demand into dedicated global AnchorDB models (`modules-npm`, `modules-go`, `modules-cargo`, `modules-pypi`) without polluting the local project graph or re-syncing across projects:

```sh
# Build & sync external module graph on-demand
knl-view modules build-graph npm::express
knl-view modules build-graph go::github.com/gin-gonic/gin

# Trace definitions and call hierarchy within the module
knl-view modules trace npm::express Router --hops=1

# List locally indexed modules in ~/.knlview/modules
knl-view modules list
```

### CLI Query

```sh
knl-view graph trace --target=DEC-20261030-135001 --hops=1
```

Outputs a compact JSON subgraph to `stdout` containing the focal node and all direct dependencies/impacted components.

### HTTP Endpoints

When `knl-view` is running as a local server:
- `GET /api/graph`: Returns the entire knowledge and decision graph structure.
- `GET /api/graph/trace?target=<id>&hops=2`: Returns an isolated $N$-hop neighborhood subgraph for AI agents or interactive visualization.
- `GET /api/anchordb/trace?target=<id>&hops=2`: Returns a causal chain traced on the AnchorDB server (requires the global `anchordb` config block). Returns `503` when AnchorDB is off or unreachable.
- `GET /api/consensus?target=<claimId>`: Read-only consensus status for one claim (requires AnchorDB and a mapped `consensus` role). Returns `503` when AnchorDB is off or the role is unmapped, `400` without a target.
- `GET /api/sources/trace?target=<path>&direction=in|out&hops=2`: Read-only file lineage over the whole-project sources graph (requires AnchorDB and a mapped `sources` role). Returns `503` when unavailable, `400` without a target or with a bad direction.

## Operating System Support & Installing AnchorDB

### Operating System Support

| OS | Core Viewer (`knl-view`) | Global Config Location | AnchorDB Backend |
| --- | --- | --- | --- |
| **Linux** | Native (Node.js >= 20.19) | `~/.knlview/knl-config.json` | **Native Binary** (`amd64`, `arm64`) or Container |
| **macOS** | Native (Node.js >= 20.19) | `~/.knlview/knl-config.json` | **Container**: **Podman (Recommended)** or Docker |
| **Windows** | Native (Node.js >= 20.19) | `%APPDATA%\knlview\knl-config.json` | **Container**: **Podman (Recommended)** or Docker |

---

### Installing AnchorDB (Optional)

AnchorDB is an optional layer. Without it, the viewer runs 100% locally with zero external dependencies: document browsing, full-text search, the Markdown graph engine, and `knl-view graph trace` all work immediately. Installing AnchorDB adds persistent multi-hop causal tracing across sessions, whole-project source code dependency syncing, and shared multi-machine graphs.

Run `knl-view install anchordb` to install AnchorDB and write the `anchordb` block into your global configuration:

#### 1. Linux (Native Standalone Binary)
- Native binaries are published on [GitHub Releases](https://github.com/rachmanzz/anchordb/releases) for Linux architectures:
  - `linux_amd64` (x86_64)
  - `linux_arm64` (aarch64)
- On Linux, `knl-view install anchordb` automatically:
  - Fetches the latest release asset and verifies it against the official `SHA256SUMS.txt`.
  - Installs `anchordb-server` and `anchordb` into `~/.knlview/bin/` with secure file permissions (`0o700` / `0o755`).
  - Starts `anchordb-server` detached as a background process daemon (logs in `~/.knlview/anchordb.log`, data in `~/.knlview/anchordb-data`).
- You can also explicitly opt for containers on Linux using `--method=container`.

#### 2. Windows & macOS (Container via Podman or Docker)
- AnchorDB relies on Linux kernel primitives (`mmap` memory mapping and POSIX file locking). Native binaries are not yet published for Windows or macOS.
- For Windows and macOS, AnchorDB is currently deployed via a lightweight container image (`ghcr.io/rachmanzz/anchordb`):
  - **Podman (Recommended)**: Rootless, daemonless, lightweight, and requires no administrative privileges or background daemons.
  - **Docker**: Supported via Docker Desktop or Docker Engine (`--runtime=docker`).
- `knl-view install anchordb` automatically detects installed container runtimes. If both are found, it prompts you to select **Podman (Recommended)** or **Docker**. If neither is installed, it halts with clear installation guidance.

#### Flags & Automation (CI / Scripts)
- Non-interactive mode: add `--yes` (accepts all defaults).
- Force install method: `--method=binary` or `--method=container`.
- Specify container engine: `--runtime=podman` (recommended) or `--runtime=docker`.
- Custom token: `--token=<text>` (default: cryptographic 32-byte hex token).
- Port conflict handling: automatically detects if port 17448 is occupied and suggests alternative free ports.
- Data safety: if a container named `anchordb-knlview` already exists, the installer stops rather than overwriting existing data.

## Configuration

Two optional config files. A missing file is never an error; a broken file is ignored with one warning on stderr. CLI flags always win over config values.

**Global (`~/.knlview/knl-config.json`)**: shared by every project on the machine. Holds the `anchordb` block. Without it, AnchorDB stays completely off and the viewer runs fully local:

```json
{
  "anchordb": {
    "url": "wire://127.0.0.1:17448",
    "token": "your-token",
    "sync": true,
    "deamon": "podman",
    "container_name": "anchordb-knlview",
    "container_id": "56519e7acbaa...",
    "container_created_on": "2026-10-31 14:08:48..."
  }
}
```

**Per project: `knl-config.json` at the project root** (gitignored):
`path`, `port`, `host`, `models`, and optional `include` / `exclude` patterns:

```json
{
  "port": 8091,
  "models": {
    "knowledges": "vez0vqrp",
    "consensus": "n0qrnmsz"
  },
  "include": ["dist/bundle.js"],
  "exclude": ["legacy/**", "*.tmp"]
}
```

- `exclude`: Hard exclude that strictly filters files and folders from graph analysis and knowledge tree. Always takes precedence over defaults and includes.
- `include`: Whitelists files and folders. Overrides default directory exclusions (e.g. including files from `dist/` or dot-folders).

Model names are owned by the `models` map: role → name, and the name can be anything (random names are fine; the map records what each name is *for*). Names stay stable even if the project folder is renamed. knl-view never invents names by itself: create them with `knl-view model new <role>` (writes the map and the global registry), and inspect ownership with `knl-view model check`.

The global registry `~/.knlview/models.json` records every name's owner (project, role, path) and warns when two projects claim the same name. A project whose map has no entry for a role runs fully local: AnchorDB is touched only once the role is mapped.

## Development

```sh
npm run dev
```

Starts the API on port 8085 (override with `PORT`) and the Vite dev server on 5173 (override with `WEB_PORT`). Pass a base folder as the first argument:

```sh
npm run dev -- ../some-project/.knowledges
```

`dist/` is not tracked in this repository. The published npm tarball contains a fresh build, so `npm install -g @rahmantech/knl-view` compiles nothing. A git checkout does not ship one: run `npm run build` there (and again after changing the frontend) before `knl-view` can serve the UI.

## License

Apache-2.0. See [LICENSE](LICENSE).
