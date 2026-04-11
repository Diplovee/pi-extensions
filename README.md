# pi-extensions

Reusable PI extensions for token-efficient memory, phased execution, and review-gated development.

## Included Extensions

- `extensions/auto-memory.ts`
  Keeps a slim, persistent memory store up to date without injecting it into prompt context every turn.

- `extensions/phase-tracker.ts`
  Tracks implementation phases, todos, testing, regressions, and explicit user review before advancing.

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
