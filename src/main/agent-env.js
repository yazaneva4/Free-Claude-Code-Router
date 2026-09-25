'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_BIN_DIRS = [
  path.join('.local', 'bin'),
  path.join('.claude', 'local'),
  path.join('.bun', 'bin'),
  path.join('.npm-global', 'bin'),
  path.join('.volta', 'bin'),
];

const SYSTEM_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

function candidateDirs(home) {
  return [
    ...DEFAULT_BIN_DIRS.map((dir) => path.join(home, dir)),
    ...SYSTEM_BIN_DIRS,
  ];
}

function missingBinDirs(currentPath, home, exists = fs.existsSync) {
  const current = String(currentPath || '').split(path.delimiter).filter(Boolean);
  return candidateDirs(home).filter((dir) => !current.includes(dir) && exists(dir));
}

function ensureAgentPath(env = process.env, home = os.homedir(), exists = fs.existsSync) {
  const missing = missingBinDirs(env.PATH, home, exists);
  if (!missing.length) return { added: [], path: String(env.PATH || '') };
  env.PATH = [...missing, String(env.PATH || '')].join(path.delimiter);
  return { added: missing, path: env.PATH };
}

module.exports = { candidateDirs, missingBinDirs, ensureAgentPath, DEFAULT_BIN_DIRS, SYSTEM_BIN_DIRS };
