#!/usr/bin/env bash
# Sensors for one loop iteration. Exit code 0 = green.
#   scripts/check.sh          typecheck, lint, unit tests, build
#   scripts/check.sh --full   + browser sensor (every scene, WebGPU and WebGL2) + bench table
#   SCENES=a,b scripts/check.sh --full   limit the browser sensor to some scenes
set -euo pipefail
cd "$(dirname "$0")/.."

full=0
[[ "${1:-}" == "--full" ]] && full=1

step() { printf '\n▶ %s\n' "$1"; }

step typecheck; pnpm -s typecheck
step lint;      pnpm -s lint
step unit;      pnpm -s test
step build;     pnpm -s build

if [[ $full == 1 ]]; then
  step "browser sensor (screens → artifacts/screens, bench → artifacts/bench)"
  pnpm -s e2e
  node scripts/bench-report.mjs
fi

printf '\nALL OK\n'
