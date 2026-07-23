#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${HOME}/.pi/agent/extensions"
CLI_TARGET_DIR="${HOME}/.local/bin"

mkdir -p "${TARGET_DIR}" "${CLI_TARGET_DIR}"

if command -v bun >/dev/null 2>&1; then
  (cd "${REPO_DIR}/cli" && bun install --production --frozen-lockfile >/dev/null)
elif command -v npm >/dev/null 2>&1; then
  (cd "${REPO_DIR}/cli" && npm install --omit=dev --no-fund --no-audit >/dev/null)
else
  echo "Warning: bun or npm is required for the thaplan interactive CLI dependencies." >&2
fi

ln -sf "${REPO_DIR}/extensions/auto-memory.ts" "${TARGET_DIR}/auto-memory.ts"
ln -sf "${REPO_DIR}/extensions/dashboard-ui.ts" "${TARGET_DIR}/dashboard-ui.ts"
ln -sf "${REPO_DIR}/extensions/context-hygiene.ts" "${TARGET_DIR}/context-hygiene.ts"
ln -sf "${REPO_DIR}/extensions/terse-mode.ts" "${TARGET_DIR}/terse-mode.ts"
ln -sf "${REPO_DIR}/extensions/working-ui.ts" "${TARGET_DIR}/working-ui.ts"
ln -sf "${REPO_DIR}/extensions/phase-tracker.ts" "${TARGET_DIR}/phase-tracker.ts"
ln -sf "${REPO_DIR}/extensions/agent-search-tools.ts" "${TARGET_DIR}/agent-search-tools.ts"
ln -sf "${REPO_DIR}/extensions/plan-gate.ts" "${TARGET_DIR}/plan-gate.ts"
ln -sf "${REPO_DIR}/extensions/cosplay.ts" "${TARGET_DIR}/cosplay.ts"
ln -sfn "${REPO_DIR}/extensions/themed-ui" "${TARGET_DIR}/themed-ui"
ln -sf "${REPO_DIR}/cli/thaplan.mjs" "${CLI_TARGET_DIR}/thaplan"

# Subagent extension and reusable role/workflow definitions.
mkdir -p "${TARGET_DIR}/subagent" "${HOME}/.pi/agent/agents" "${HOME}/.pi/agent/prompts"
ln -sf "${REPO_DIR}/extensions/subagent/index.ts" "${TARGET_DIR}/subagent/index.ts"
ln -sf "${REPO_DIR}/extensions/subagent/agents.ts" "${TARGET_DIR}/subagent/agents.ts"
for agent_file in "${REPO_DIR}"/extensions/subagent/agents/*.md; do
  ln -sf "${agent_file}" "${HOME}/.pi/agent/agents/$(basename "${agent_file}")"
done
for prompt_file in "${REPO_DIR}"/extensions/subagent/prompts/*.md; do
  ln -sf "${prompt_file}" "${HOME}/.pi/agent/prompts/$(basename "${prompt_file}")"
done

mkdir -p "${HOME}/.pi/agent/themes"
ln -sf "${REPO_DIR}/themes/zim-flag.json" "${HOME}/.pi/agent/themes/zim-flag.json"
ln -sf "${REPO_DIR}/themes/nord-night.json" "${HOME}/.pi/agent/themes/nord-night.json"
ln -sf "${REPO_DIR}/themes/everforest-dark.json" "${HOME}/.pi/agent/themes/everforest-dark.json"
ln -sf "${REPO_DIR}/themes/pi-blueprint.json" "${HOME}/.pi/agent/themes/pi-blueprint.json"
ln -sf "${REPO_DIR}/themes/tokyo-night.json" "${HOME}/.pi/agent/themes/tokyo-night.json"

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
echo "  themed-ui/"
echo "  thaplan -> ${CLI_TARGET_DIR}/thaplan"
echo "  subagent/"
echo "  agents/{scout,researcher,planner,worker,reviewer,tester,thaplan}.md"
echo "  prompts/{implement,scout-and-plan,implement-and-review,research-and-plan,verify}.md"
echo "  themes/{zim-flag,nord-night,everforest-dark,pi-blueprint,tokyo-night}.json"
echo
echo "Optional: copy ${REPO_DIR}/cosplay.sample.json to ~/.pi/agent/cosplay.json and customize presets."
echo "Reload or restart PI to pick up extension changes. Ensure ${CLI_TARGET_DIR} is on PATH."
