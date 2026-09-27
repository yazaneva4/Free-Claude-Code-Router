'use strict';

/**
 * Checks that a packed build is actually a readable archive.
 *
 * Used by the test workflow, which cannot run `./run.command --dist` because
 * the router bundle is not in this repository. It packs the tree and then reads
 * the header back the way the app will, so a build that cannot be opened is
 * caught here rather than at install time.
 *
 *   node scripts/verify-pack.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/* Reading a `.asar` path back needs the archive layer off, under Electron. */
process.noAsar = true;

const { execFileSync } = require('node:child_process');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const packed = path.join(os.tmpdir(), `ccr-verify-pack-${process.pid}.asar`);
try {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'pack-asar.js'), ROOT, packed], { stdio: 'ignore' });

  const body = fs.readFileSync(packed);
  if (body.length < 16) fail('the packed build is too small to be an archive');

  // The header is a 16 byte preamble: the JSON length at offset 12, and the
  // first file byte at 16 + (readUInt32LE(8) - 4).
  if (body.readUInt32LE(0) !== 4) fail('unexpected asar header');
  const jsonLength = body.readUInt32LE(12);
  const paddedLength = body.readUInt32LE(8) - 4;
  if (!jsonLength || paddedLength < jsonLength) fail('the asar header lengths do not make sense');

  const tree = JSON.parse(body.subarray(16, 16 + jsonLength).toString('utf8'));

  // The header is a nested tree, so a path is walked rather than indexed.
  const has = (relative) => {
    let node = { files: tree.files };
    for (const part of relative.split('/')) {
      if (!node || !node.files || !node.files[part]) return null;
      node = node.files[part];
    }
    return node;
  };
  const count = (node) => Object.values((node && node.files) || {}).reduce((total, child) => total + (child.files ? count(child) : 1), 0);

  if (!has('package.json')) fail('the packed build has no package.json');
  if (!has('src/main/main.js')) fail('the packed build has no main process');
  if (!has('src/renderer/index.html')) fail('the packed build has no account page');
  if (!has('src/renderer/js/i18n.js')) fail('the packed build has no translations runtime');
  for (const needed of ['scripts/pack-asar.js', 'run.command']) {
    if (!has(needed)) fail(`the packed build is missing ${needed}`);
  }

  const pkg = has('package.json');
  const start = 16 + paddedLength + Number(pkg.offset || 0);
  const version = JSON.parse(body.subarray(start, start + pkg.size).toString('utf8')).version;
  if (!version) fail('the packed build has no version');

  process.stdout.write(`packed ${body.length} bytes, ${count(tree)} entries, version ${version}\n`);
  process.stdout.write('the build is a readable archive and carries the files the app needs\n');
} finally {
  fs.rmSync(packed, { force: true });
}
