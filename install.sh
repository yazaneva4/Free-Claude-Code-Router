#!/usr/bin/env bash
#
# Installs this repository's build into the installed router app.
#
#   macOS   ./install.sh
#   Linux   ./install.sh
#   Windows powershell -ExecutionPolicy Bypass -File install.ps1
#
# The router app is not in this repository, so it has to be installed once
# first. This script finds it, packs this repository, and puts the result
# where the app looks for it. It only ever replaces one file, and it takes a
# copy of the build it replaced first.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="Claude Code Router"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) PLATFORM="macos" ;;
  Linux)  PLATFORM="linux" ;;
  *) die "unsupported platform: $(uname -s). Use install.ps1 on Windows." ;;
esac

say "platform: $PLATFORM"

# --- find the installed router -------------------------------------------
# macOS is an app bundle, Windows is a resources directory, and on Linux the
# router ships as an AppImage, which is a read-only image that cannot have a
# file swapped inside it.
find_app() {
  if [ -n "${CCR_APP_PATH:-}" ] && [ -d "$CCR_APP_PATH" ]; then
    printf '%s' "$CCR_APP_PATH"; return 0
  fi
  if [ "$PLATFORM" = "macos" ]; then
    for candidate in "/Applications/$APP_NAME.app" "$HOME/Applications/$APP_NAME.app"; do
      [ -d "$candidate" ] && { printf '%s' "$candidate"; return 0; }
    done
  else
    for candidate in \
      "$HOME/.local/opt/$APP_NAME" \
      "$HOME/opt/$APP_NAME" \
      "/opt/$APP_NAME" \
      "/usr/lib/$APP_NAME"; do
      [ -d "$candidate/resources" ] && { printf '%s' "$candidate"; return 0; }
    done
  fi
  return 1
}

APP="$(find_app || true)"
if [ -z "$APP" ]; then
  die "the $APP_NAME app is not installed, and this repository layers on top of it.
Install it from https://github.com/musistudio/claude-code-router/releases and
run this again. Set CCR_APP_PATH if it is somewhere unusual."
fi
say "app: $APP"

RESOURCES="$APP/Contents/Resources"
[ -d "$RESOURCES" ] || RESOURCES="$APP/resources"
[ -d "$RESOURCES" ] || die "could not find a resources directory inside $APP"

UPSTREAM="$RESOURCES/app-original.asar"
[ -f "$UPSTREAM" ] || die "$RESOURCES/app-original.asar is missing, so this does not look like the router."

# --- a node to run the packer with ---------------------------------------
# The app's own binary is used, the same way the macOS installer does, so
# nothing else has to be installed.
case "$PLATFORM" in
  macos)  BIN="$APP/Contents/MacOS/$APP_NAME" ;;
  linux)  BIN="$APP/$APP_NAME" ;;
esac
[ -x "$BIN" ] || BIN="$(command -v "$APP_NAME" || true)"
if [ -z "$BIN" ] || [ ! -x "$BIN" ]; then
  die "no usable binary to run the packer with. Install Node, or set CCR_NODE to a node binary."
fi
NODE="${CCR_NODE:-$BIN}"
say "packer: $NODE"

# --- an AppImage cannot be modified in place -----------------------------
if [ "$PLATFORM" = "linux" ] && [ ! -d "$RESOURCES" ]; then
  die "this looks like an AppImage, which is a read-only image: a file cannot be
swapped inside it. Extract it and run the installer against the extracted
directory, or rebuild it with appimagetool."
fi

# --- pack and install ----------------------------------------------------
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

say "packing this repository"
ELECTRON_RUN_AS_NODE=1 "$NODE" "$HERE/scripts/pack-asar.js" "$HERE" "$STAGE/app.asar"

BACKUP="$RESOURCES/app.asar.before-gate"
if [ -f "$RESOURCES/app.asar" ] && [ ! -f "$BACKUP" ]; then
  cp "$RESOURCES/app.asar" "$BACKUP"
  say "kept the build it replaced at $BACKUP"
fi

cp "$STAGE/app.asar" "$RESOURCES/app.asar.tmp"
mv "$RESOURCES/app.asar.tmp" "$RESOURCES/app.asar"
say "installed into $RESOURCES/app.asar"

# macOS will not launch a bundle whose contents changed after signing.
if [ "$PLATFORM" = "macos" ]; then
  if command -v codesign >/dev/null 2>&1; then
    codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
    say "re-signed the bundle so macOS will launch it"
  else
    say "warning: codesign was not found, so the bundle may not launch"
  fi
fi

say ""
say "done. Open the app and it will use this build."
case "$PLATFORM" in
  macos) say "  open \"$APP\"" ;;
  linux) say "  \"$BIN\" &" ;;
esac
