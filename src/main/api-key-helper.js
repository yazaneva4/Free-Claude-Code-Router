'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Keeps the `apiKeyHelper` scripts working.
 *
 * A harness config names the script that prints its gateway token, and the
 * name carries the profile it belongs to, so it changes when the profile
 * changes: `ccr-claude-code-api-key-claude-code` and
 * `ccr-claude-code-api-key-default-claude-code` are two names for two scopes.
 * The config and the script are written separately, so a profile change can
 * leave a config pointing at a script that was never created. Claude Code then
 * fails on every start with `exited 127`, because the file it was told to run
 * is not there.
 *
 * So the token is read from whichever script exists, and any script a config
 * refers to but that is missing gets written. Nothing is invented: only paths
 * a real config already points at are created.
 */

const BIN_DIR = path.join('.claude-code-router', 'bin');
const HELPER_PREFIX = 'ccr-claude-code-api-key-';
const TOKEN_PREFIX = 'ccr-profile-';
/** The harness configs worth checking, newest convention first. */
const CONFIG_PATHS = [
  path.join('.claude', 'settings.json'),
  path.join('.claude-code-router', 'profiles', 'claude-code', 'claude', 'settings.json'),
];

function binDir(home = os.homedir()) {
  return path.join(home, BIN_DIR);
}

function helperName(scope) {
  return `${HELPER_PREFIX}${scope || 'claude-code'}`;
}

function helperPath(scope, home = os.homedir()) {
  return path.join(binDir(home), helperName(scope));
}

/** The script body upstream writes, kept byte for byte so nothing else changes. */
function scriptFor(token) {
  return `#!/bin/sh\nprintf '%s\\n' '${token}'\n`;
}

function tokenIn(text) {
  const printed = String(text || '').match(/printf\s+'%s\\n'\s+'([^']+)'/);
  const token = printed ? printed[1] : String(text || '').trim();
  return token && token.startsWith(TOKEN_PREFIX) ? token : null;
}

function helperFiles(home = os.homedir()) {
  try {
    return fs
      .readdirSync(binDir(home))
      .filter((name) => name.startsWith(HELPER_PREFIX) && !name.endsWith('.cmd'))
      .map((name) => path.join(binDir(home), name));
  } catch {
    return [];
  }
}

/**
 * The token to hand out: whatever the scripts already agree on. A token in more
 * than one script means the scopes drifted apart, and the newest one wins
 * because that is the profile that was written last.
 */
function currentToken(home = os.homedir()) {
  const files = helperFiles(home);
  let newest = null;
  for (const file of files) {
    let token = null;
    try {
      token = tokenIn(fs.readFileSync(file, 'utf8'));
    } catch {}
    if (!token) continue;
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {}
    if (!newest || mtime > newest.mtime) newest = { token, file, mtime };
  }
  return newest ? newest.token : null;
}

function configFiles(home = os.homedir(), extra = []) {
  return [...extra, ...CONFIG_PATHS.map((relative) => path.join(home, relative))].filter((file) => {
    try {
      return fs.existsSync(file);
    } catch {
      return false;
    }
  });
}

/**
 * Every helper path the given configs actually refer to. Only paths inside the
 * home this was asked about count, so a config cannot make this app write a
 * script somewhere else on the disk.
 */
function referencedHelpers(files, home = os.homedir()) {
  const found = new Set();
  const owned = binDir(home);
  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const value = parsed && typeof parsed.apiKeyHelper === 'string' ? parsed.apiKeyHelper : '';
    if (!value) continue;
    // Only ever a script inside this app's own bin directory.
    const resolved = path.resolve(value);
    if (path.dirname(resolved) !== owned) continue;
    if (path.basename(resolved).endsWith('.cmd')) continue;
    found.add(resolved);
  }
  return [...found];
}

function backupFile(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    fs.copyFileSync(file, `${file}.ccr-backup-${stamp}`);
    return `${file}.ccr-backup-${stamp}`;
  } catch {
    return null;
  }
}

function newestExisting(files) {
  let best = null;
  for (const file of files) {
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (!best || mtime > best.mtime) best = { file, mtime };
  }
  return best;
}

/**
 * Makes a config's `apiKeyHelper` point at a script that exists.
 *
 * Creating the missing script is not a fix here. The router deletes the key
 * helper of any profile it is not currently using, on every launch, so a script
 * invented for an inactive profile is removed again straight away and the
 * failure comes back. The durable repair is to point the config at the helper
 * for the profile that is actually in use, which is the one that survives.
 *
 * A helper is only written when there is no helper at all to point at, and only
 * from a token this app can already read. No token is ever invented.
 */
/**
 * Creates any helper a config names but that is missing. Kept for the case where
 * there is nothing to repoint at; see repairHelper for the usual path.
 */
function ensureHelpers({ home = os.homedir(), configs = null, token = null } = {}) {
  const files = configs || configFiles(home);
  const referenced = referencedHelpers(files, home);
  const missing = referenced.filter((file) => {
    try {
      return !fs.existsSync(file);
    } catch {
      return true;
    }
  });
  if (!missing.length) return { ok: true, created: [], missing: [], token: null };
  const secret = token || currentToken(home);
  if (!secret) return { ok: false, created: [], missing, token: null, error: 'No gateway token was found.' };
  const created = [];
  for (const file of missing) {
    writeHelper(file, secret);
    created.push(file);
  }
  return { ok: true, created, missing: [], token: secret };
}

function repairHelper({ home = os.homedir(), configs = null } = {}) {
  const files = configs || configFiles(home);
  const referenced = referencedHelpers(files, home);
  const missing = referenced.filter((file) => {
    try {
      return !fs.existsSync(file);
    } catch {
      return true;
    }
  });
  if (!missing.length) return { ok: true, changed: false, repointed: [], created: [], missing: [] };

  const survivor = newestExisting(helperFiles(home));
  if (!survivor) {
    const token = currentToken(home);
    if (!token) {
      return {
        ok: false,
        changed: false,
        repointed: [],
        created: [],
        missing,
        error: 'No gateway key helper exists for a profile that is in use, so the config was left alone. Turn the profile on in the router once and this will settle itself.',
      };
    }
    const created = [];
    for (const file of missing) {
      writeHelper(file, token);
      created.push(file);
    }
    return { ok: true, changed: true, repointed: [], created, missing: [] };
  }

  const repointed = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const value = parsed && typeof parsed.apiKeyHelper === 'string' ? parsed.apiKeyHelper : '';
    if (!value || !missing.includes(path.resolve(value))) continue;
    backupFile(file);
    parsed.apiKeyHelper = survivor.file;
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
    repointed.push({ file, from: path.resolve(value), to: survivor.file });
  }

  return { ok: true, changed: repointed.length > 0, repointed, created: [], missing: [] };
}

function writeHelper(file, token) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.new`;
  fs.writeFileSync(temp, scriptFor(token), { mode: 0o700 });
  fs.renameSync(temp, file);
  try {
    fs.chmodSync(file, 0o700);
  } catch {}
}

module.exports = {
  BIN_DIR,
  HELPER_PREFIX,
  CONFIG_PATHS,
  binDir,
  helperName,
  helperPath,
  helperFiles,
  scriptFor,
  tokenIn,
  currentToken,
  configFiles,
  referencedHelpers,
  repairHelper,
  ensureHelpers,
};
