# pi-extensions

Reusable PI extensions for token-efficient memory, phased execution, dashboard visibility, and in-character agent workflows.

## Included Extensions

- `extensions/auto-memory.ts`
  Keeps a slim, persistent memory store up to date without injecting it into prompt context every turn.

- `extensions/phase-tracker.ts`
  Tracks implementation phases, todos, testing, regressions, and explicit user review before advancing. Supports `todoTextMatch` for completing todos when `todoId` is unknown.

- `extensions/agent-search-tools.ts`
  Adds lightweight `web_search` (DuckDuckGo HTML) and `search_repo` (ripgrep/find) tools plus `/search` command to reduce context-heavy exploration. Supports `max_results` and returns structured match details.

- `extensions/plan-gate.ts`
  Adds `/plan` command and `plan_gate` tool to keep sessions in planning mode until you explicitly approve coding (`/plan go`).

- `extensions/dashboard-ui.ts`
  Renders a PI dashboard widget showing memory, hygiene, phase state, and cosplay state.

- `extensions/cosplay.ts`
  Adds full-character cosplay mode with concise prompting, preset support, persistence, and dashboard/footer status.

- `extensions/themed-ui/`
  Custom PI chrome with themed header, themed input/editor borders, mascot picker, and a compact styled footer.

- `themes/*.json`
  Five custom themes: `zim-flag`, `nord-night`, `everforest-dark`, `pi-blueprint`, and `tokyo-night`.

## Phase Tracker

### Tool

`phase_tracker` actions:

- `create_plan` — create/reset a phased plan
- `add_phase` — add a phase with `phaseName` and `goal`
- `add_todo` — add a todo with `todoText` to `phaseId` or the current phase
- `start_phase` — start a specific phase or the next unfinished phase
- `complete_todo` — complete by `todoId` or `todoTextMatch` on `phaseId` or the current phase
- `log_test` — set `testOutcome` to `pass` or `fail`
- `request_review` — move the active/current phase to review
- `log_error` — record a regression and reopen work
- `next_phase` — advance only after todos are done, tests pass, and review is approved
- `list` — return current state

### Notes

- Many actions now default to the current phase when `phaseId` is omitted.
- `complete_todo` supports `todoTextMatch` for exact text completion when the model does not know the todo ID.
- Duplicate todo text in the same phase is rejected to reduce repeated tool calls.
- Tool results include structured active-phase metadata and missing requirement hints.

## Agent Search Tools

### Tools

- `web_search`
  - `query` — search string
  - `max_results` — optional result cap

- `search_repo`
  - `query` — text, symbol, or filename to find
  - `search_type` — `text` or `filename`
  - `path_filter` — optional repo subpath filter
  - `max_results` — optional result cap

### Notes

- `search_repo` runs in the active session/project cwd.
- Text search returns structured match details with `file`, `line`, and `text`.
- Filename search returns structured match details with `path`.
- Tool results distinguish command failures from genuine no-result searches.

## Cosplay Extension

### Commands

- `/cos <preset>` — enable a named preset from `cosplay.json`
- `/cos <persona prompt>` — enable a custom persona
- `/cos` — show current cosplay state
- `/cos list` — list presets
- `/uncos` — disable cosplay mode

### Presets

Cosplay presets are loaded from:

- `~/.pi/agent/cosplay.json`
- `.pi/cosplay.json`

Example:

```json
{
  "tino": {
    "prompt": "You're Tino, an engineer. Stay fully in character. Be direct, competent, practical, and concise."
  },
  "reviewer": "You're a blunt senior reviewer. Stay fully in character and keep replies concise."
}
```

A starter config is included at:

- `cosplay.sample.json`

Copy it to `~/.pi/agent/cosplay.json` and customize it.

### Behavior

When cosplay is active, the extension:

- injects persona instructions through `before_agent_start`
- keeps replies in character
- pushes for concise, low-fluff responses
- persists state across reload/resume
- writes cosplay state to project/session `.pi` files so the dashboard can render it
- shows status in both the footer and the dashboard

Custom personas also get a derived short name for dashboard display.

## Themed UI

### Commands

- `/pi-theme` — pick a theme
- `/pi-theme <name>` — set theme directly
- `/pi-theme-next` / `/pi-theme-prev` / `/pi-theme-back`
- `/pi-mascot` — pick a mascot
- `/pi-mascot <name>` — set mascot directly
- `/pi-mascot random`
- `/pi-mascot-next` / `/pi-mascot-prev` / `/pi-mascot-back`
- `/pi-header-default` / `/pi-header-theme`

### Notes

- The dashboard extension now defers footer ownership when `themed-ui` is installed so both can coexist better.
- Themes are installed into `~/.pi/agent/themes/` by `install.sh`.

## Install

Run:

```bash
./install.sh
```

This symlinks the extensions into `~/.pi/agent/extensions/`.

## Notes

- The repo is the source of truth.
- PI loads the symlinked files from `~/.pi/agent/extensions/`.
- Reload or restart PI after updating an extension.
