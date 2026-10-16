#!/usr/bin/env node
'use strict';
// Explicit opt-in routed Claude Code. Never changes native Claude settings.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { currentToken } = require('../src/main/api-key-helper');
function launch(args = process.argv.slice(2), options = {}) {
  if (args[0] !== 'claude') {
    console.error('Usage: fcr claude [Claude Code arguments...]');
    return 2;
  }
  const home = options.home || os.homedir();
  const token = currentToken(home);
  if (!token) {
    console.error('FCR gateway token unavailable. Open Free Claude Code Router and configure a routed profile first.');
    return 1;
  }
  const env = { ...(options.env || process.env) };
  const scoped = path.join(home, '.claude-code-router', 'fcr-claude-config');
  fs.mkdirSync(scoped, { recursive: true, mode: 0o700 });
  env.CLAUDE_CONFIG_DIR = scoped;
  env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:3456';
  env.ANTHROPIC_AUTH_TOKEN = token;
  delete env.ANTHROPIC_API_KEY;
  const bin = options.binary || 'claude';
  const result = (options.spawn || spawnSync)(bin, args.slice(1), { env, stdio: 'inherit', shell: false });
  if (result.error) {
    console.error('Unable to start native Claude Code: ' + result.error.message);
    return 1;
  }
  return result.status === null ? 1 : result.status;
}
if (require.main === module) process.exitCode = launch();
module.exports = { launch };
