#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${HOME}/.pi/agent/extensions"

mkdir -p "${TARGET_DIR}"

ln -sf "${REPO_DIR}/extensions/auto-memory.ts" "${TARGET_DIR}/auto-memory.ts"
ln -sf "${REPO_DIR}/extensions/dashboard-ui.ts" "${TARGET_DIR}/dashboard-ui.ts"
ln -sf "${REPO_DIR}/extensions/context-hygiene.ts" "${TARGET_DIR}/context-hygiene.ts"
ln -sf "${REPO_DIR}/extensions/terse-mode.ts" "${TARGET_DIR}/terse-mode.ts"
ln -sf "${REPO_DIR}/extensions/working-ui.ts" "${TARGET_DIR}/working-ui.ts"
ln -sf "${REPO_DIR}/extensions/phase-tracker.ts" "${TARGET_DIR}/phase-tracker.ts"
ln -sf "${REPO_DIR}/extensions/agent-search-tools.ts" "${TARGET_DIR}/agent-search-tools.ts"
ln -sf "${REPO_DIR}/extensions/plan-gate.ts" "${TARGET_DIR}/plan-gate.ts"
ln -sf "${REPO_DIR}/extensions/cosplay.ts" "${TARGET_DIR}/cosplay.ts"

echo "Installed:"
echo "  auto-memory.ts"
echo "  dashboard-ui.ts"
echo "  context-hygiene.ts"
echo "  terse-mode.ts"
echo "  working-ui.ts"
echo "  phase-tracker.ts"
echo "  agent-search-tools.ts"
echo "  plan-gate.ts"
echo "  cosplay.ts"
echo
echo "Optional: copy ${REPO_DIR}/cosplay.sample.json to ~/.pi/agent/cosplay.json and customize presets."
echo "Reload or restart PI to pick up extension changes."
