#!/bin/zsh
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="/Applications/Claude Code Router.app"
BIN="$APP/Contents/MacOS/Claude Code Router"
RES="$APP/Contents/Resources"
SELFTEST_LOG="$HOME/.claude-code-router/selftest.log"

if [ ! -x "$BIN" ]; then
  print -u2 "Claude Code Router not found at: $APP"
  exit 1
fi

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
    pgrep -f "$BIN" >/dev/null 2>&1 || return 0
    sleep 0.25
  done
  pkill -f "$BIN" >/dev/null 2>&1 || true
  sleep 1
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

case "$1" in
  --install)
    stop_app
    install_build
    open -a "Claude Code Router"
    ;;
  --tests)
    run_node "$HERE/scripts/check.js"
    run_node "$HERE/test/run.js"
    run_node "$HERE/test/ipc.js"
    selftest
    open -a "Claude Code Router"
    ;;
  --selftest)
    selftest
    ;;
  --log)
    tail -n 20 "$HOME/.claude-code-router/gate.log"
    ;;
  --help|-h)
    print "usage: run.command [--install | --tests | --selftest | --log]"
    ;;
  *)
    open -a "Claude Code Router"
    ;;
esac
