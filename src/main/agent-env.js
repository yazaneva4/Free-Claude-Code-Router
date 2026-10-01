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
  // Where npm puts its shims on Windows, which is where the agent CLIs land
  // there when they are installed the ordinary way.
  path.join('AppData', 'Roaming', 'npm'),
  path.join('scoop', 'shims'),
];

// The homebrew, local, usr and bin directories do not exist on Windows, and
// Node lives somewhere else entirely, so the Windows locations are listed too.
// They cost nothing where they are absent because a missing directory is
// skipped, and without them a Windows install would never find claude or codex.
const SYSTEM_BIN_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  'C:\\Program Files\\nodejs',
  'C:\\ProgramData\\chocolatey\\bin',
];

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
