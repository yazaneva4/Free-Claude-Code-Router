'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROFILES_DIR = path.join('.claude-code-router', 'profiles');
const MODEL_KEYS = ['ANTHROPIC_MODEL', 'CCR_CLAUDE_CODE_MODEL', 'CODEXL_CLAUDE_CODE_MODEL'];

function profilesRoot(home = os.homedir()) {
  return path.join(home, PROFILES_DIR);
}

function profileIds(home = os.homedir()) {
  try {
    return fs.readdirSync(profilesRoot(home), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function settingsFiles(home = os.homedir(), onlyProfileId = null) {
  const files = [];
  for (const id of profileIds(home)) {
    if (onlyProfileId && id !== onlyProfileId) continue;
    for (const relative of ['settings.json', 'claude/settings.json']) {
      const file = path.join(profilesRoot(home), id, relative);
      if (fs.existsSync(file)) files.push({ profileId: id, file });
    }
  }
  return files;
}

function applyModel(model, { home = os.homedir(), profileId = null, files = null } = {}) {
  const targets = files || settingsFiles(home, profileId);
  const applied = [];
  for (const entry of targets) {
    const current = readJson(entry.file);
    const env = current.env && typeof current.env === 'object' ? current.env : {};
    let changed = false;
    for (const key of MODEL_KEYS) {
      if (env[key] !== model) {
        env[key] = model;
        changed = true;
      }
    }
    if (!changed) continue;
    writeJson(entry.file, { ...current, env });
    applied.push({ file: entry.file, model });
  }
  return applied;
}

function readModel({ home = os.homedir(), profileId = null, files = null } = {}) {
  for (const entry of files || settingsFiles(home, profileId)) {
    const env = readJson(entry.file).env;
    if (env && typeof env === 'object' && env.ANTHROPIC_MODEL) return { file: entry.file, model: env.ANTHROPIC_MODEL };
  }
  return null;
}

module.exports = { MODEL_KEYS, profilesRoot, profileIds, settingsFiles, readJson, writeJson, applyModel, readModel };
