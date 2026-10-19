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
- A built frontend (`npm run build` produces `dist/`). The CLI refuses to start
  without it and tells you so.

## Install

Not published to npm. Install from source:

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
knl-view --init                            # scaffold a new base (wizard, no server)
knl-view --seed-skill=knl-view --dir=global --yes
```

| Flag | Default | What it does |
| --- | --- | --- |
| `--port`, `-p` | `8085` | HTTP port |
| `--path` | `.knowledges` | Folder to serve, relative to the working directory |
| `--host` | `127.0.0.1` | Bind address |
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

## Development

```sh
npm run dev
```

Starts the API on port 8085 (override with `PORT`) and the Vite dev server on
5173 (override with `WEB_PORT`). Pass a base folder as the first argument:

```sh
npm run dev -- ../some-project/.knowledges
```

## License

Apache-2.0. See [LICENSE](LICENSE).
