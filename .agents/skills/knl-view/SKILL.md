---
name: knl-view
description: Read and maintain .knowledges knowledge bases. Use whenever a task involves a .knowledges folder, its map.json, or the knl-view viewer.
---

# Knowledges base

A `.knowledges` folder is a plain-directory knowledge base, viewed with
knl-view. The disk is the source of truth: files and folders exist because
they exist on disk, never because a map says so.

## Read in this order

1. `README.md` at the base root: the lede and the overview.
2. `map.json` at the base root, when present: the authoritative menu
   labels, grouping, and order for everything below.
3. Then the structure the map (or the disk) describes. A typical base
   mirrors anchor-connector: `roadmap/`, `features/`, `futures/`,
   `audit/`, `roasted/`, plus root files `coding-rules.md` and
   `documentation-rules.md`. Anything not on disk does not exist; do not
   invent it from map entries.

## map.json

Optional. Every entry is decoration only. It sets the label shown in the
menu, the order in menus, and a short note. It never creates, moves, or
deletes files. Entries pointing at paths that are not on disk are ignored
silently. Without `map.json`, the viewer falls back to the first
`# heading` of each markdown file and plain name order: files first,
then folders.

```json
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
```

| Field | Applies to | Effect |
| --- | --- | --- |
| `title` | the whole file | Masthead title; wins over the README heading |
| `sections.<dir>` / `dirs.<path>` | a directory | `title` is the menu label, `meta` is a short note |
| `sections.<dir>.docs.<file>` | a file inside that directory | same shape as `docs` entries |
| `docs.<file>` / `files.<path>` | a file | `title` is the menu label |
| `order` | any entry | Ascending menu order. Entries without `order` follow, still files before folders |
| `ignore` (or `hidden`) | any entry | `true` hides the file or folder from the menu, lists, search, home, and contents. Hiding a folder hides everything inside it |

`ignore` is view-only: the file still exists on disk and stays in
`.gitignore`-free plain storage. Remove the flag to bring it back:

```json
{ "files": { "rahasia.md": { "ignore": true } }, "dirs": { "draft-lama": { "ignore": true } } }
```

Paths are relative to the `.knowledges` root, use `/` separators, and
must match the on-disk path exactly as the viewer shows it, for example
`features/auth.md`. Nested folders use the full relative path as the key.

The sidebar always opens with two fixed entries above the tree:
`index` (the root `README.md`) and `contents` (`#/a/contents`, a system
route with no file on disk that lists the whole base). The root README is
therefore not repeated inside the tree.

## Rules

- Never move or delete files to satisfy the map. Either add the file or
  remove the stale map entry.
- Give every markdown file a top-level `# heading` so it still reads well
  when no map entry covers it.
- Keep `order` values small and dense per menu level (1, 2, 3).
- When the map and disk disagree about existence, the disk wins.

## Features writing rules

Under `features/{feature_name}/`, prefer to keep at least:
- `prd.md` — Product Requirements Document for this feature
- `detail-plan.md` — concrete implementation plan, decisions, trade-offs

Names are kebab-case for the folder. Keep other artifacts minimal and cover them
via `map.json` if they need custom menu labels/order.

## Futures writing rules

Under `futures/`, the base typically has:
- `README.md` — vision/overview
- `prd.md` — global PRD covering proposed future work

Use kebab-case for any additional future documents. Defer exotic filenames to
`map.json`.

## Roadmap writing rules

Under `roadmap/`, maintain milestone-oriented notes. Keep `README.md` as the
index and split by milestones only when they grow large. Use `map.json` to
reorder milestones/files without renaming.

## Roasted writing rules

All artifacts from roasting/audits go under `roasted/` (relative to the knowledge
base root in use; i.e. the directory passed via `--path`, which may be
`.knowledges` or a custom one). Do **not** place them in the root of that
directory.

### Naming
`roasted/{roasted_name}_v{number}.md` — kebab-case name, integer `number` starting at `1`.

### Stack order
- `_v1` is the first roast → placed at the bottom of the stack
- each new roast increments number and goes at the top (highest number = newest)
- files are immutable by number; updates belong to the same file, not a new one

### Classification
Every roast must state:
- `Severity`: `P0|P1|P2|P3`
- `Class`: `BUG|PERF|VULN|DEBT|CEILING|PROSES`

Use the full English template below.

## Per-project config (optional)

You may create a small `knl-config.json` at the project root to store defaults
for this viewer (for example when `.knowledges` lives in a subdirectory). This
file is machine-local convenience and should be added to `.gitignore`.

```json
{
  "path": ".knowledges",
  "port": 8085,
  "host": "127.0.0.1"
}
```

If present, CLI flags override values from `knl-config.json`. The current
CLI does not yet auto-load this file (flags are explicit) — treat this as a
convention until implemented.
