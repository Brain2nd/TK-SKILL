#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
NODE_BIN=${CODEX_NODE_BIN:-$(command -v node || true)}

if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js was not found. Install Node.js 20+ and run ./setup.sh first." >&2
  exit 1
fi
if [[ ! -d "$SCRIPT_DIR/node_modules/playwright" ]]; then
  echo "Playwright is not installed. Run ./setup.sh first." >&2
  exit 1
fi

read -r -p "FastMoss account (leave blank to log in manually): " FASTMOSS_USERNAME
if [[ -n "$FASTMOSS_USERNAME" ]]; then
  read -r -s -p "FastMoss password: " FASTMOSS_PASSWORD
  echo
  export FASTMOSS_USERNAME FASTMOSS_PASSWORD
  trap 'unset FASTMOSS_PASSWORD' EXIT
fi
if [[ -n "${CODEX_NODE_MODULES:-}" ]]; then
  export NODE_PATH="$CODEX_NODE_MODULES${NODE_PATH:+:$NODE_PATH}"
fi

"$NODE_BIN" "$SCRIPT_DIR/fastmoss_browser.mjs" --setup --setup-timeout 900
