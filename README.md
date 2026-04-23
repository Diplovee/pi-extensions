# pi-extensions

Reusable PI extensions for token-efficient memory, phased execution, dashboard visibility, and in-character agent workflows.

## Included Extensions

- `extensions/auto-memory.ts`
  Keeps a slim, persistent memory store up to date without injecting it into prompt context every turn.

- `extensions/phase-tracker.ts`
  Tracks implementation phases, todos, testing, regressions, and explicit user review before advancing.

- `extensions/agent-search-tools.ts`
  Adds lightweight `web_search` (DuckDuckGo HTML) and `search_repo` (ripgrep/find) tools plus `/search` command to reduce context-heavy exploration.

- `extensions/plan-gate.ts`
  Adds `/plan` command and `plan_gate` tool to keep sessions in planning mode until you explicitly approve coding (`/plan go`).

- `extensions/dashboard-ui.ts`
  Renders a PI dashboard widget showing memory, hygiene, phase state, and cosplay state.

- `extensions/cosplay.ts`
  Adds full-character cosplay mode with concise prompting, preset support, persistence, and dashboard/footer status.

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
