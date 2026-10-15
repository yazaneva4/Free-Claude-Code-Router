'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { install, patchApp, resourceDir, defaultPath, selectAsset, download, hasUpstreamMain } = require('../scripts/install');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fcr-install-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'gate');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '3.1.1', main: 'src/main/main.js' }));
  const upstream = path.join(home, 'upstream');
  fs.mkdirSync(path.join(upstream, 'dist', 'main'), { recursive: true });
  fs.writeFileSync(path.join(upstream, 'dist', 'main', 'main.js'), 'module.exports = {};');
  fs.writeFileSync(path.join(upstream, 'package.json'), JSON.stringify({ version: '3.1.3', main: 'dist/main/main.js' }));
  const runtime = appPath => {
    const platform = appPath.endsWith('.app') ? 'darwin' : 'linux';
    const resources = resourceDir(appPath, platform);
    fs.mkdirSync(resources, { recursive: true });
    // The gate packer deliberately excludes dist/, so this fixture writes a
    // minimal valid ASAR header for an upstream dist/main/main.js entry.
    const tree = { files: { dist: { files: { main: { files: { 'main.js': { size: 0, offset: '0' } } } } } } };
    const json = Buffer.from(JSON.stringify(tree));
    const padded = Math.ceil(json.length / 4) * 4;
    const header = Buffer.alloc(16);
    header.writeUInt32LE(4, 0); header.writeUInt32LE(padded + 8, 4);
    header.writeUInt32LE(padded + 4, 8); header.writeUInt32LE(json.length, 12);
    fs.writeFileSync(path.join(resources, 'app.asar'), Buffer.concat([header, json, Buffer.alloc(padded - json.length, 0x20)]));
    return resources;
  };
  return { home, root, runtime };
}

const names = {
  darwin: 'Claude-Code-Router_3.1.3-mac-Apple-Silicon-arm64.zip',
  linux: 'Claude-Code-Router_3.1.3.AppImage',
  win32: 'Claude-Code-Router_3.1.3.exe',
};
const payload = Buffer.from('verified runtime fixture');
const digest = 'sha256:' + crypto.createHash('sha256').update(payload).digest('hex');
const asset = platform => ({ name: names[platform], digest, size: payload.length, browser_download_url: 'https://github.com/musistudio/claude-code-router/releases/download/v3.1.3/' + names[platform] });

for (const platform of ['darwin', 'linux', 'win32']) {
  test(`${platform}: fresh terminal install downloads/verifies runtime, then patches and preserves the original`, async t => {
    const f = fixture(t), env = {};
    const destination = defaultPath(platform, f.home, env);
    const calls = [];
    const run = (command, args, options) => {
      calls.push([command, args]);
      if (platform === 'darwin' && command === 'ditto') f.runtime(path.join(args[3], 'Claude Code Router.app'));
      else if (platform === 'linux') f.runtime(path.join(options.cwd, 'squashfs-root'));
      else if (platform === 'win32') { assert.equal(args[0], '/S'); f.runtime(args[1].slice(3)); }
    };
    let requests = 0;
    await install({ platform, arch: platform === 'darwin' ? 'arm64' : 'x64', home: f.home, env, root: f.root, run, log() {}, fetchImpl: async () => ++requests === 1 ? Response.json({ assets: [asset(platform)] }) : new Response(payload) });
    const resources = resourceDir(destination, platform);
    assert.ok(hasUpstreamMain(path.join(resources, 'app-original.asar')));
    assert.ok(hasUpstreamMain(path.join(resources, 'app.asar.before-gate')));
    assert.equal(hasUpstreamMain(path.join(resources, 'app.asar')), false);
    assert.equal(requests, 2);
    if (platform === 'darwin') assert.ok(calls.some(([cmd]) => cmd === 'codesign'));
    const original = fs.readFileSync(path.join(resources, 'app-original.asar'));
    // Reinstall uses existing files and never downloads or replaces the original.
    await install({ platform, home: f.home, env, root: f.root, run: platform === 'darwin' ? run : () => { throw new Error('no native installer on reinstall'); }, log() {}, fetchImpl: async () => { throw new Error('unexpected network request'); } });
    assert.deepEqual(fs.readFileSync(path.join(resources, 'app-original.asar')), original);
  });
}

test('Linux accepts an existing AppImage and extracts without downloading', async t => {
  const f = fixture(t), file = path.join(f.home, 'router.AppImage');
  fs.writeFileSync(file, 'fixture');
  let calls = 0;
  await install({ platform: 'linux', home: f.home, env: {}, appPath: file, root: f.root, log() {}, fetchImpl: async () => { throw new Error('must not fetch'); }, run(command, args, options) {
    assert.equal(command, file); assert.deepEqual(args, ['--appimage-extract']); calls++;
    f.runtime(path.join(options.cwd, 'squashfs-root'));
  } });
  assert.equal(calls, 1);
});

test('download integrity failures stop before extraction', async t => {
  const f = fixture(t);
  await assert.rejects(() => download(asset('linux'), path.join(f.home, 'bad'), async () => new Response(Buffer.alloc(payload.length))), /SHA-256/);
  let calls = 0, requests = 0;
  await assert.rejects(() => install({ platform: 'linux', arch: 'x64', home: f.home, env: {}, root: f.root, log() {}, run() { calls++; }, fetchImpl: async () => ++requests === 1 ? Response.json({ assets: [asset('linux')] }) : new Response('truncated') }), /incomplete/);
  assert.equal(calls, 0);
});

test('unsupported or ambiguous release assets fail before installation', () => {
  assert.throws(() => selectAsset({ assets: [asset('linux')] }, 'linux', 'arm64'), /No unambiguous/);
  assert.throws(() => selectAsset({ assets: [asset('linux'), asset('linux')] }, 'linux', 'x64'), /No unambiguous/);
  assert.throws(() => selectAsset({ assets: [{ ...asset('linux'), digest: null }] }, 'linux', 'x64'), /no SHA-256/);
});

test('macOS signing failure restores the previous archive and reports failure', t => {
  const f = fixture(t), appPath = path.join(f.home, 'Claude Code Router.app');
  const resources = f.runtime(appPath), target = path.join(resources, 'app.asar');
  const previous = fs.readFileSync(target);
  assert.throws(() => patchApp(appPath, 'darwin', { root: f.root, log() {}, run() { throw new Error('codesign failed'); } }), /codesign failed/);
  assert.deepEqual(fs.readFileSync(target), previous);
});

test('terminal entry point honors CCR_NODE and works from a path with spaces', t => {
  const f = fixture(t), appPath = path.join(f.home, 'app with spaces' + (process.platform === 'darwin' ? '.app' : ''));
  f.runtime(appPath);
  const env = { ...process.env, CCR_NODE: process.execPath };
  if (process.platform === 'darwin') {
    // Signing the fake bundle is simulated; the shell/Node handoff is real.
    const bin = path.join(f.home, 'bin'); fs.mkdirSync(bin);
    const signer = path.join(bin, 'codesign'); fs.writeFileSync(signer, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    env.PATH = bin + path.delimiter + env.PATH;
  }
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve(__dirname, '../install.ps1'), '-AppPath', appPath], { env, stdio: 'pipe' });
  } else {
    execFileSync('bash', [path.resolve(__dirname, '../install.sh'), '--app-path', appPath], { env, stdio: 'pipe' });
  }
  assert.ok(fs.existsSync(path.join(resourceDir(appPath, process.platform), 'app-original.asar')));
});
