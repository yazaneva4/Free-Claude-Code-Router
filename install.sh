#!/usr/bin/env bash
# Ensure Git and Node.js are available before installing the desktop router.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
FCR_NODE="${CCR_NODE:-node}"

node_ok() {
  command -v "$FCR_NODE" >/dev/null 2>&1 &&
    "$FCR_NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'
}
install_deps() {
  local packages=("$@")
  if command -v brew >/dev/null 2>&1; then
    brew install "${packages[@]}"
  elif command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y "${packages[@]}"
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y "${packages[@]}"
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -S --needed --noconfirm "${packages[@]}"
  else
    printf '%s\n' 'No supported package manager found (brew, apt, dnf, pacman). Install Git and Node.js 22+ manually.' >&2
    exit 1
  fi
}
# Upgrade only when the package manager reports a newer available package.
if [[ "${CCR_SKIP_DEPENDENCY_UPDATE:-0}" == 1 ]]; then
  command -v git >/dev/null 2>&1 || { printf '%s\n' 'Git is required when dependency updates are skipped.' >&2; exit 1; }
elif command -v brew >/dev/null 2>&1; then
  for pkg in git node; do
    if ! brew list --versions "$pkg" >/dev/null 2>&1; then
      brew install "$pkg"
    elif brew outdated --quiet "$pkg" | grep -qx "$pkg"; then
      brew upgrade "$pkg"
    fi
  done
elif command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y git nodejs
elif command -v dnf >/dev/null 2>&1; then
  sudo dnf upgrade -y git nodejs
  install_deps git nodejs
elif command -v pacman >/dev/null 2>&1; then
  sudo pacman -Syu --needed --noconfirm git nodejs
else
  if ! command -v git >/dev/null 2>&1; then install_deps git; fi
  if ! node_ok; then install_deps nodejs; fi
fi
if ! node_ok; then
  printf '%s\n' 'Node.js 22+ is still unavailable. Your package manager may provide an older release; install a supported Node.js version and retry.' >&2
  exit 1
fi
exec "$FCR_NODE" "$HERE/scripts/install.js" "$@"
