'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try {
    fs.chmodSync(dir, DIR_MODE);
  } catch {}
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback;
    throw err;
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: FILE_MODE });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, FILE_MODE);
  } catch {}
}

class Store {
  constructor(dir) {
    this.dir = dir;
    ensureDir(dir);
  }

  file(name) {
    return path.join(this.dir, name);
  }

  read(name, fallback) {
    return readJson(this.file(name), fallback);
  }

  write(name, value) {
    writeJson(this.file(name), value);
    return value;
  }

  exists(name) {
    return fs.existsSync(this.file(name));
  }

  remove(name) {
    try {
      fs.unlinkSync(this.file(name));
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }
  }
}

module.exports = { Store, ensureDir, readJson, writeJson, FILE_MODE, DIR_MODE };
