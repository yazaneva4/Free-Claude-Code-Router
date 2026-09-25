'use strict';

const fs = require('node:fs');
const path = require('node:path');

if ('noAsar' in process) process.noAsar = true;

const SKIP_DIRS = new Set(['.git', 'node_modules', '.DS_Store']);
const SKIP_FILES = new Set(['.DS_Store']);

function walk(dir, files, prefix, blobs) {
  const names = fs.readdirSync(dir).sort();
  for (const name of names) {
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const stat = fs.lstatSync(full);
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      const subtree = { files: {} };
      files[name] = subtree;
      walk(full, subtree.files, rel, blobs);
    } else if (stat.isFile()) {
      if (SKIP_FILES.has(name)) continue;
      const body = fs.readFileSync(full);
      const meta = { size: body.length };
      files[name] = meta;
      blobs.push({ rel, body, meta });
    }
  }
}

function buildHeaderJson(tree) {
  return JSON.stringify({ files: tree });
}

function pack(srcDir, outFile) {
  const files = {};
  const blobs = [];
  walk(srcDir, files, '', blobs);

  let offset = 0;
  for (const blob of blobs) {
    const meta = blob.meta;
    meta.offset = String(offset);
    if (blob.body.length % 4 !== 0) {
      blob.pad = 4 - (blob.body.length % 4);
      offset += blob.body.length + blob.pad;
    } else {
      blob.pad = 0;
      offset += blob.body.length;
    }
  }

  const json = buildHeaderJson(files);
  const jsonLen = Buffer.byteLength(json);
  const paddedLen = jsonLen + ((4 - (jsonLen % 4)) % 4);
  const header = Buffer.alloc(16);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(paddedLen + 8, 4);
  header.writeUInt32LE(paddedLen + 4, 8);
  header.writeUInt32LE(jsonLen, 12);

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const staging = `${outFile}.building`;
  const fd = fs.openSync(staging, 'w');
  try {
    fs.writeSync(fd, header);
    fs.writeSync(fd, Buffer.from(json, 'utf8'));
    fs.writeSync(fd, Buffer.alloc(paddedLen - jsonLen, 0x20));
    for (const blob of blobs) {
      fs.writeSync(fd, blob.body);
      if (blob.pad) fs.writeSync(fd, Buffer.alloc(blob.pad));
    }
  } finally {
    fs.closeSync(fd);
  }
  const size = fs.statSync(staging).size;
  fs.renameSync(staging, outFile);

  return { files: blobs.length, jsonLen, size };
}

if (require.main === module) {
  const src = process.argv[2];
  const out = process.argv[3];
  if (!src || !out) {
    console.error('usage: pack-asar.js <src-dir> <out.asar>');
    process.exit(2);
  }
  const result = pack(path.resolve(src), path.resolve(out));
  console.log(`packed ${result.files} files | header json ${result.jsonLen} bytes | asar ${result.size} bytes -> ${out}`);
}

module.exports = { pack };
