# knl-view

A local viewer for `.knowledges` knowledge bases: a CLI that serves a small web
app over a plain folder of Markdown files. The disk is the source of truth;
`map.json` is optional decoration.

```
knl-view --port 8086 --path=.knowledges
```

## What it does

- Serves a web viewer over any folder of Markdown files. No database, no build
  step for your content, no account.
- Sidebar tree with a fixed `index` entry (the root `README.md`) and a
  `contents` entry that lists the whole base on one page.
- Folders open their own `README.md`, rendered the same way as a normal document.
- `map.json` (optional) relabels, reorders, or hides entries in the menu. It
  never creates, moves, or deletes files. Entries pointing at paths that are not
  on disk are ignored silently.
- Markdown with GFM tables, and triple-backtick fences tagged `mermaid` rendered
  as diagrams. The mermaid bundle is served locally and loaded only when a
  document contains a diagram; nothing is fetched from a CDN.
- Per-diagram controls: toggle between diagram and source, and a zoom modal
  (wheel zoom, drag to pan, +/−/Reset, Esc to close).
- Table of contents per document, breadcrumb, and a filter box in the sidebar
  that narrows the index by file title or path.
- Interface in English or Indonesian, switchable in the top bar. English is the
  default.

## Requirements

- Node.js 20.19 or newer.
- A built frontend. `dist/` is committed to this repository, so an install from
  GitHub already has it. The CLI refuses to start without it and tells you so.

## Install

Not published to npm. Install straight from GitHub:

```sh
npx github:rachmanzz/knl-view                 # run once, no install
npm install -g github:rachmanzz/knl-view --install-links   # install globally
```

The repository ships the built `dist/`, so these installs do not compile
anything. `--install-links` matters: without it npm 11 links the package to a
temporary clone that it deletes afterwards, which leaves a broken install.
Re-run the install command after new commits to pick up changes.

The global command lands in `$(npm prefix -g)/bin`. If that directory is not
on your PATH, link it somewhere that is:

```sh
ln -s "$(npm prefix -g)/bin/knl-view" ~/.local/bin/knl-view
```

Or install from source:

```sh
git clone https://github.com/rachmanzz/knl-view.git
cd knl-view
npm install
npm run build
```

Run it directly with `node bin/knl-view.js`, or make the `knl-view` command
available on your PATH with `npm link`.

## Usage

```sh
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
| `--init` | off | Scaffold a new base interactively; does not start the server |
| `--structure` | `standard` | Layout for a non-interactive `--init`: `standard`, `empty`, or `custom` |
| `--folders` | none | Comma-separated folder names for `--structure=custom` |
| `--seed-skill=knl-view` | off | Write the `knl-view` skill for coding agents; skipped if it already exists |
| `--dir` | `project` | Skill location: `project` (`.agents/skills`) or `global` (`~/.config/opencode/skills`) |
| `--yes`, `-y` | off | Accept every default in `--init` / `--seed-skill`, no questions asked |
| `--help`, `-h` | | Show help |
| `--version`, `-v` | | Show version |

The server binds to `127.0.0.1` by default, so it is reachable only from your
machine unless you pass `--host` yourself. There is no authentication; treat
`--host 0.0.0.0` as a decision you are making on purpose.

## Configuration

Two optional config files. A missing file is never an error; a broken file is
ignored with one warning on stderr. CLI flags always win over config values.

**Global — `~/.knlview/knl-config.json`**: shared by every project on the
machine. Holds the `anchordb` block. Without it, AnchorDB stays completely
off and the viewer runs fully local:

```json
{
  "anchordb": {
    "url": "wire://127.0.0.1:7448",
    "token": "your-token",
    "sync": true
  }
}
```

**Per project — `knl-config.json` at the project root** (gitignored): only
`path`, `port`, `host`, and a `models` map — never the anchordb connection:

```json
{
  "port": 8091,
  "models": {
    "knowledges": "vez0vqrp",
    "consensus": "n0qrnmsz"
  }
}
```

Model names are owned by the `models` map: role → name, and the name can
be anything (random names are fine — the map records what each name is
*for*). Names stay stable even if the project folder is renamed. knl-view
never invents names by itself: create them with
`knl-view model new <role>` (writes the map and the global registry), and
inspect ownership with `knl-view model check`.

The global registry `~/.knlview/models.json` records every name's owner
(project, role, path) and warns when two projects claim the same name. A
project whose map has no entry for a role runs fully local: AnchorDB is
touched only once the role is mapped.

## Installing AnchorDB (optional)

AnchorDB is an optional layer. Without it the viewer runs fully local:
everything — browsing, search, the graph engine, and `knl-view graph trace`
— works with zero setup. Installing AnchorDB only adds persistent causal
tracing across sessions and shared sync between machines.

`knl-view install anchordb` installs AnchorDB and writes the `anchordb`
block into the global config:

- **Linux**: downloads the native binary from
  [GitHub Releases](https://github.com/rachmanzz/anchordb/releases),
  verifies it against the release's `SHA256SUMS.txt`, installs to
  `~/.knlview/bin/`, and starts `anchordb-server` detached (logs in
  `~/.knlview/anchordb.log`, data in `~/.knlview/anchordb-data`).
- **Other platforms**: AnchorDB needs Linux `mmap`, so it runs as a Linux
  container from `ghcr.io/rachmanzz/anchordb` via docker or podman — the
  command refuses to continue if neither is installed.

Non-interactive (CI/scripts): add `--yes`. Explicit method: `--method=binary`
or `--method=container`. Fixed token instead of a random one: `--token=...`.
If a container named `anchordb-knlview` already exists, the installer stops
instead of removing it — data must not disappear by accident.

## How a base is read

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

Reading order: the root `README.md`, then `map.json` when present, then the
structure on disk. Without `map.json`, menu labels fall back to the first
`# heading` of each file, then to the plain file name (files before folders).

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
    "rahasia.md": { "ignore": true }
  },
  "dirs": {
    "draft-lama": { "ignore": true }
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

Paths are relative to the `.knowledges` root, use `/` separators, and must
match the on-disk path exactly, for example `features/auth.md`. `ignore` is
view-only: the file stays on disk. Remove the flag to bring it back.

The full field reference lives in the bundled skill:
`.agents/skills/knl-view/SKILL.md`.

## AI Graph & Decision Tracing

`knl-view` includes an AI-native directed acyclic graph (DAG) engine built directly into the CLI and server. It connects knowledge documents (`.knowledges/*.md`) and architectural decision records (`.knowledges/decisions/*.md`) into a unified graph:

- **Zero Intermediary File**: Fully on-the-fly in-memory processing. Markdown files remain the sole source of truth without generating out-of-sync `graph.json` cache files.
- **Decision Lineage Tracking**: Automatically discovers `supersedes`, `related_to`, and `affects_knowledge` edges from `decisionskills` decision blocks.
- **Low-Token Subgraphs for AI**: Instead of loading an entire knowledge base into LLM context, query exact $N$-hop subgraphs in sub-milliseconds (< 1 ms).

This engine is fully local — it needs no AnchorDB and no network. AnchorDB
(see the optional install above) adds persistence on top: edges survive
across sessions, are synced incrementally, and can be traced from any
machine pointing at the same server.

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

## Development

```sh
npm run dev
```

Starts the API on port 8085 (override with `PORT`) and the Vite dev server on
5173 (override with `WEB_PORT`). Pass a base folder as the first argument:

```sh
npm run dev -- ../some-project/.knowledges
```

`dist/` is committed to this repository so that installs straight from GitHub
keep working, because npm runs no build step for a git install without a
`prepare` script. After changing the frontend, run `npm run build` and commit
the result together with the source, or those installs stay on the previous
build.

## License

Apache-2.0. See [LICENSE](LICENSE).
