#!/usr/bin/env bash
# macOS/Linux terminal entry point. Node is used directly, not the app binary.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
FCR_NODE="${CCR_NODE:-node}"
if ! command -v "$FCR_NODE" >/dev/null 2>&1; then
  printf '%s\n' 'Install Node.js 22 or newer, then run this command again.' >&2
  exit 1
fi
exec "$FCR_NODE" "$HERE/scripts/install.js" "$@"
