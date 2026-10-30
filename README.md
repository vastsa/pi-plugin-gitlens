# Git Lens

A [GitLens](https://www.gitkraken.com/gitlens)-inspired local Git management
plugin for PI-Desktop. It turns the current workspace — one repository, or
several side by side — into a visual dashboard in the right work panel. Human
UI only — it does not register agent tools.

Plugin ID: `pi.gitlens`  
Requires PI-Desktop `>= 0.8.0`. Reads and writes only the repositories
discovered inside the current workspace, through the system `git` binary — no
network, no credentials, no agent tools.

## Install

- **Marketplace**: PI-Desktop → Plugins → Marketplace → Git Lens
- **Development**: Plugins → Load development plugin → this repository root

## Test

```bash
node --test test/*.test.mjs tests/*.test.js
```

Both suites create their own throwaway repositories under the OS temp directory
(set `GITLENS_TEST_TMPDIR` to point them elsewhere) and never touch an existing
project.

## Features

- **Work panel view** (`pi.gitlens`): docks in the app's right work panel
  (no separate window). Open the work panel (`Mod+J`) and choose **Git Lens**.
  The dashboard follows the app language (en / zh-CN) and color mode live,
  including light/dark switches while the view stays open (command palette
  titles and toasts too):
  - **Overview** — compact staged / unstaged / untracked / conflict counts
    plus recent commits (click a commit to open it).
  - **History** — searchable commit log; click a commit to open a full-page
    sheet (files and patch) with Back.
  - **Changes** — working-tree changes grouped by stage state; click a file
    to open its diff in a full-page sheet; compact commit box.
  - **Branches** — list with current badge, create / switch / safe delete.
  - **Blame** — GitLens-style per-line attribution for any repo-relative file.
- **Repository switcher** — when the project folder holds several independent
  repositories, a compact header selector switches between them and remembers
  the choice per workspace.
- **Commands** — `Git Lens: Open`, `Open History`, `Open Changes`,
  `Open Branches`, `Open Blame` from the command palette.

## Multi-repository workspaces

A project folder does not have to be a single repository. A folder that holds
independent checkouts — for example `frontend/`, `backend/` and `shared/` —
works without any extra configuration:

- **Discovery** — a bounded breadth-first scan of the workspace looks for a
  `.git` directory *or* a `.git` file (worktree / submodule checkout), at most
  three levels deep and within a capped number of directories. Generated trees
  (`node_modules`, `vendor`, `build`, `dist`, `target`, `obj`, `coverage`, …)
  and dot directories (`.git`, `.cache`, `.next`, `.venv`, …) are skipped, and
  symlinks/junctions are never followed, so discovery cannot escape the opened
  folder. Candidates are confirmed with `git rev-parse --show-toplevel` and
  de-duplicated by canonical path.
- **Ordering** — the repository that contains the workspace (its own root, or
  an ancestor root when the project lives inside a repository) is always first,
  so a plain single-repository project behaves exactly as before. Descendants
  follow, sorted by their path relative to the workspace.
- **Caching** — the scan is cached per workspace and coalesced, including a
  scan that failed, so the panel's one-second refresh never spawns a filesystem
  walk or git (not even while git is broken). The header `Refresh` button is
  the only retry: it rescans, replaces the cached result and redraws. Changing
  the workspace scans once.
- **Selection** — a compact header selector lists the discovered repositories
  and stays hidden unless there is more than one. The choice is kept in plugin
  memory per workspace and, defensively, in
  `localStorage["pi.gitlens.selectedRepo.v1"]`, so it survives a panel reload;
  missing or blocked storage only costs the remembered choice.
- **Isolation** — every request names its `repoRoot`, which is validated
  against the discovered set (a subdirectory, a checkout discovery skipped or
  an arbitrary path is rejected) and held for the whole operation, including
  the post-commit status. Switching repositories resets detail/navigation state
  and bumps a generation counter, so late responses, stale errors and armed
  confirmation closures (for example the two-step branch delete) can no longer
  paint or write into the newly selected repository.
- **States** — "no project open", "this project has no git repository", a
  genuine inspection failure (`git` missing, unreadable folder) and a partial
  failure ("these repositories work, but one candidate could not be inspected")
  are different messages; a failure never hides the workspace, and a partial
  failure is shown as a banner next to the usable repositories.

Known limits of the bounded heuristic: repositories deeper than three levels
below the workspace are not listed, a repository hidden inside a skipped
generated directory is not listed, and a workspace that is itself a repository
keeps its own (or ancestor) root as the primary entry with nested checkouts
listed after it.

## How it works

- The repositories of the workspace are discovered by a bounded local scan
  (depth 3, directory cap, generated trees skipped, symlinks never followed)
  and verified with `git rev-parse --show-toplevel`. The repository that
  contains the workspace is listed first.
- Every panel request names one of those discovered roots; the plugin validates
  it and every git call of the operation runs with `-C <root>`, so a request
  can never touch another checkout or an arbitrary path.
- Git is executed through `execFile` with argument arrays — no shell, no
  string interpolation — so paths and refs cannot become commands.
- `GIT_TERMINAL_PROMPT=0` is set, so git never blocks waiting for
  credentials; the UI cannot push, pull or fetch.
- Paths must be repo-relative (no absolute paths, no `..` escapes); refs and
  branch names are validated against a safe charset.
- The UI is a `contributes.views` surface docked in the work panel. It talks
  to the plugin process only through the host bridge, with the same isolation
  as a panel window (sandboxed page, per-plugin partition) but no detached
  window chrome.

## Permissions

| Permission | Why |
| --- | --- |
| `ui.view` | Dock Git Lens in the right work panel |

No `fs.*`, `net.fetch`, clipboard, shell, notify or agent-tool permissions
are requested. All repository access happens through the system `git` binary
inside the plugin process.

## Commands

| Command | Opens |
| --- | --- |
| `Git Lens: Open` | Overview |
| `Git Lens: Open History` | History |
| `Git Lens: Open Changes` | Changes |
| `Git Lens: Open Branches` | Branches |
| `Git Lens: Open Blame` | Blame |

## Requirements

- PI-Desktop `>= 0.8.0`
- `git` available on `PATH`
- The workspace must contain at least one git repository: itself, an ancestor
  of it, or a checkout up to three levels below it

## Development

```bash
python3 scripts/pack_plugin.py plugins/pi.gitlens
python3 scripts/rebuild_catalog.py
node --test test/*.test.mjs tests/*.test.js
```

Install the packed `.piplug` via **Plugins → Install plugin package**, or load
the folder as a development plugin.

## Changelog

### Unreleased

Multi-repository workspaces: bounded, cached discovery of sibling checkouts, a
header repository selector with per-workspace memory, and per-request
`repoRoot` validation so every read and write stays bound to the repository it
was made for.

### 0.2.8

First release from the plugin's own repository
https://github.com/vastsa/pi-plugin-gitlens — the source moved out of the plugin
monorepo, nothing else changed. 首个从独立仓库发布的版本，源码从插件单仓库迁出，
功能未变。

### 0.2.7

Follow the app color mode only. Do not snap to the OS palette — that flashed
when the app and the system disagreed. 只跟随应用颜色模式，不再跟系统色抢。

### 0.2.6

Follows the app light/dark mode live in the work-panel view.

### 0.2.5

Drop agent tools and the Git workflow skill. Git Lens is a human work-panel
UI only — the AI does not get `git_status` / `git_commit` / `git_open_panel`.
去掉 AI 工具和 Git workflow skill，Git Lens 只给人用。

### 0.2.4

Command palette titles, work-panel copy and toasts follow the app language
(en / zh-CN) from the first paint. 命令面板、工作面板文案和提示从首帧起跟随
应用语言。

### 0.2.3

Compact work-panel UI: overview is a single count row (not 2×2 cards).
Clicking a changed file or commit opens a full-page sheet with Back,
instead of dumping the patch under the list.

### 0.2.2

Premium docked UI: iOS-style segmented control, large-title identity,
inset grouped lists, and a 2×2 metric widget. Feishu/iOS density on the
host's neutral gray ramp.

### 0.2.1

Restyles the docked view to match the PI-Desktop work panel and Files plugin:
text tabs, a quiet branch/repo status line, list rows instead of chips and
colored tiles, and the host's neutral gray accent (no purple).

### 0.2.0

Docks only in the right work panel (`contributes.views` + `ui.view`) and no
longer opens a separate window. Commands still switch the live page; if the
view is not visible, a toast points at the work-panel switcher (`Mod+J`).
Requires PI-Desktop `>= 0.8.0`.

### 0.1.4

Keeps the first view toolbar clear of the host window-control capsule and
re-tints the capsule when the panel palette changes.

### 0.1.1

Restyles the panel to mirror the PI-Desktop design system: the purple accent
and bespoke palette are replaced by the app's neutral monochrome accent and
`--ds-*` tokens, and git semantics now use the app's success / warning / error
colors. A contributed app theme re-skins the panel exactly as it re-skins the
shell. No behavior, tool, command or permission changes.

### 0.1.0

First release: multi-view panel (Overview / History / Changes / Branches /
Blame) with app language & theme following and five palette commands. All git
operations run through the system git binary against the resolved repository
root of the current workspace.
