#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${HOME}/.pi/agent/extensions"

mkdir -p "${TARGET_DIR}"

ln -sf "${REPO_DIR}/extensions/auto-memory.ts" "${TARGET_DIR}/auto-memory.ts"
ln -sf "${REPO_DIR}/extensions/dashboard-ui.ts" "${TARGET_DIR}/dashboard-ui.ts"
ln -sf "${REPO_DIR}/extensions/context-hygiene.ts" "${TARGET_DIR}/context-hygiene.ts"
ln -sf "${REPO_DIR}/extensions/terse-mode.ts" "${TARGET_DIR}/terse-mode.ts"
ln -sf "${REPO_DIR}/extensions/phase-tracker.ts" "${TARGET_DIR}/phase-tracker.ts"

echo "Installed:"
echo "  auto-memory.ts"
echo "  dashboard-ui.ts"
echo "  context-hygiene.ts"
echo "  terse-mode.ts"
echo "  phase-tracker.ts"
echo
echo "Reload or restart PI to pick up extension changes."
