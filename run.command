#!/bin/zsh
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="${CCR_APP_PATH:-/Applications/Claude Code Router.app}"
BIN="$APP/Contents/MacOS/Claude Code Router"
RES="$APP/Contents/Resources"
SELFTEST_LOG="$HOME/.claude-code-router/selftest.log"

require_app() {
  if [ ! -x "$BIN" ]; then
    print -u2 "The router application is not installed at:
  $APP

This project layers on top of the router rather than replacing it, so install it
first, then run this again:

  open https://github.com/musistudio/claude-code-router/releases

If it is installed somewhere else, set CCR_APP_PATH to the .app bundle."
    exit 1
  fi
  if [ ! -f "$RES/app-original.asar" ]; then
    print -u2 "That bundle has no Contents/Resources/app-original.asar, so it is not the router.
Check CCR_APP_PATH: $APP"
    exit 1
  fi
}

run_node() {
  ELECTRON_RUN_AS_NODE=1 "$BIN" "$@"
}

install_build() {
  run_node "$HERE/scripts/pack-asar.js" "$HERE" /tmp/ccr-build/app.asar
  cp /tmp/ccr-build/app.asar "$RES/app.asar"
  codesign --force --deep --sign - "$APP" >/dev/null 2>&1
  print "installed into $RES/app.asar"
}

stop_app() {
  osascript -e 'tell application "Claude Code Router" to quit' >/dev/null 2>&1 || true
  for _ in {1..40}; do
    pgrep -f "$BIN" >/dev/null 2>&1 || break
    sleep 0.25
  done
  # An instance can be running from a relative path or a copy of the bundle, and
  # any survivor keeps the single instance lock, which would silently stop the
  # next launch from opening a window.
  pkill -f "$BIN" >/dev/null 2>&1 || true
  pkill -f "com.claudecoderouter.desktop" >/dev/null 2>&1 || true
  sleep 1
  pkill -9 -f "Claude Code Router" >/dev/null 2>&1 || true
  for _ in {1..20}; do
    pgrep -f "Claude Code Router" >/dev/null 2>&1 || return 0
    sleep 0.25
  done
  print -u2 "warning: an older Claude Code Router instance is still running and will block this one"
}

selftest() {
  install_build
  stop_app
  local auth_dir="/tmp/ccr-selftest-auth"
  rm -rf "$auth_dir"
  mkdir -p "$auth_dir"
  rm -f "$SELFTEST_LOG"
  local rc=0
  CCR_SELFTEST=1 CCR_AUTH_DIR="$auth_dir" CCR_INTERNAL_USER_DATA_DIR="$auth_dir/app-data" "$BIN" >/tmp/ccr-selftest.log 2>&1 || rc=$?
  print "\n--- self-test ---"
  if [ -f "$SELFTEST_LOG" ]; then
    cat "$SELFTEST_LOG"
  else
    print -u2 "self-test wrote no log; last app output:"
    tail -n 30 /tmp/ccr-selftest.log
    rc=1
  fi
  return $rc
}

usage() {
  cat <<'USAGE'
usage: ./run.command [option]

  (no option)     open the app
  --install       pack this repository and put it in the installed app, then open
  --tests         syntax, unit, ipc and in-app tests, then open the app
  --selftest      only the in-app tests, against a throwaway account
  --dist [ver]    build an installable app and zip into dist/, with hashes
  --release <ver> "notes"
                  dist, then publish a release the in-app updater can install
  --log           show the last lines of the app's log
  --status        show what is installed, and which build is in place
  --help          this text

The router app must already be installed, because this repository layers on top
of it. Set CCR_APP_PATH if it is not in /Applications.
USAGE
}

status() {
  require_app
  print "app        : $APP"
  print "version    : $(run_node -e "console.log(require('$RES/app.asar/package.json').version)")"
  print "upstream   : $RES/app-original.asar"
  print "built      : $RES/app.asar"
  print "signing    : $(codesign -dv "$APP" 2>&1 | sed -n 's/^Signature=//p')"
  print "repo       : $(git -C "$HERE" remote get-url origin 2>/dev/null || print 'none')"
  print "branch     : $(git -C "$HERE" branch --show-current 2>/dev/null || print 'none')"
  local dirty
  dirty=$(git -C "$HERE" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  if [ "$dirty" = "0" ]; then
    print "uncommitted: none"
  else
    print "uncommitted: $dirty file(s)"
  fi
}

case "$1" in
  --install)
    require_app
    stop_app
    install_build
    open -a "Claude Code Router"
    ;;
  --tests)
    require_app
    run_node "$HERE/scripts/check.js"
    run_node "$HERE/test/run.js"
    run_node "$HERE/test/ipc.js"
    selftest
    open -a "Claude Code Router"
    ;;
  --selftest)
    require_app
    selftest
    ;;
  --dist)
    require_app
    run_node "$HERE/scripts/build-app.js" "$2"
    ;;
  --release)
    require_app
    version="$2"
    notes="$3"
    if [ -z "$version" ] || [ -z "$notes" ]; then
      print -u2 'usage: ./run.command --release <x.y.z> "release notes"'
      exit 1
    fi
    if [ -z "$GITHUB_TOKEN" ]; then
      print -u2 'GITHUB_TOKEN is required to publish a release, because releases go through the
GitHub API rather than over SSH. Create one at https://github.com/settings/tokens
with repo scope, then run this again.'
      exit 1
    fi
    run_node "$HERE/scripts/build-app.js" "$version"
    print ""
    run_node "$HERE/scripts/release.js" "$version" "$notes" "$HERE/dist/Claude-Code-Router-$version.zip"
    ;;
  --log)
    tail -n 20 "$HOME/.claude-code-router/gate.log"
    ;;
  --status)
    status
    ;;
  --help|-h)
    usage
    ;;
  *)
    require_app
    open -a "Claude Code Router"
    ;;
esac
