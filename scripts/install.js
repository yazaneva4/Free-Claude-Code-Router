'use strict';

// Terminal installation shared by macOS, Linux and Windows. No npm packages
// are needed: Node downloads the official runtime and packs this repository.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { pack } = require('./pack-asar');

process.noAsar = true;
const ROOT = path.resolve(__dirname, '..');
const APP = 'Claude Code Router';
const RELEASE = 'https://api.github.com/repos/musistudio/claude-code-router/releases/latest';

function resourceDir(appPath, platform) {
  return path.join(appPath, platform === 'darwin' ? 'Contents/Resources' : 'resources');
}

function defaultPath(platform, home, env = process.env) {
  if (platform === 'darwin') return path.join(home, 'Applications', `${APP}.app`);
  if (platform === 'linux') return path.join(home, '.local', 'opt', APP);
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', APP);
  throw new Error(`Unsupported platform: ${platform}`);
}

function findApp(platform, home, env = process.env) {
  const candidates = [defaultPath(platform, home, env)];
  if (platform === 'darwin') candidates.push(`/Applications/${APP}.app`);
  if (platform === 'linux') candidates.push(path.join(home, 'opt', APP), `/opt/${APP}`, `/usr/lib/${APP}`);
  if (platform === 'win32') {
    for (const key of ['ProgramFiles', 'ProgramFiles(x86)']) if (env[key]) candidates.push(path.join(env[key], APP));
  }
  return candidates.find(candidate => fs.existsSync(resourceDir(candidate, platform))) || null;
}

function selectAsset(release, platform, arch) {
  const assets = (release.assets || []).filter(asset => asset && !/blockmap/i.test(asset.name));
  let matches;
  if (platform === 'darwin') matches = assets.filter(a => /\.zip$/i.test(a.name) && new RegExp(`(^|[-_. ])${arch}([-_. ]|$)`, 'i').test(a.name));
  else if (platform === 'linux') matches = assets.filter(a => /\.AppImage$/i.test(a.name) && (arch === 'x64' ? !/arm64|aarch64/i.test(a.name) : /arm64|aarch64/i.test(a.name)));
  else if (platform === 'win32') matches = assets.filter(a => /\.exe$/i.test(a.name) && (arch === 'x64' ? !/arm64|aarch64|ia32/i.test(a.name) : /arm64|aarch64/i.test(a.name)));
  else throw new Error(`Unsupported platform: ${platform}`);
  if (!['x64', 'arm64'].includes(arch) || matches.length !== 1) throw new Error(`No unambiguous official desktop download for ${platform}/${arch}. Install a compatible desktop app and pass --app-path.`);
  const asset = matches[0];
  if (!/^sha256:[a-f0-9]{64}$/i.test(asset.digest || '')) throw new Error('The official download has no SHA-256 digest; install the desktop runtime manually and use --app-path.');
  const url = new URL(asset.browser_download_url);
  if (url.origin !== 'https://github.com' || !url.pathname.startsWith('/musistudio/claude-code-router/releases/download/')) throw new Error('Unexpected upstream download URL.');
  return asset;
}

async function download(asset, destination, fetchImpl = fetch) {
  const response = await fetchImpl(asset.browser_download_url, { signal: AbortSignal.timeout(600000) });
  if (!response.ok || !response.body) throw new Error(`Download failed (HTTP ${response.status}).`);
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const meter = new Transform({ transform(chunk, _encoding, done) {
    bytes += chunk.length;
    if (bytes > 512 * 1024 * 1024) return done(new Error('Desktop download exceeds 512 MB.'));
    hash.update(chunk); done(null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(destination));
  if (asset.size !== undefined && bytes !== asset.size) throw new Error('Desktop download was incomplete.');
  if (hash.digest('hex') !== asset.digest.slice(7).toLowerCase()) throw new Error('Desktop download failed SHA-256 verification. Nothing was installed.');
}

function findBundle(directory, depth = 0) {
  if (depth > 3) return null;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(directory, entry.name);
    if (entry.name === `${APP}.app`) return full;
    const nested = findBundle(full, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function installRuntime(file, destination, platform, stage, run = execFileSync) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (platform === 'win32') {
    // NSIS /D must be the final argument and must not be quoted.
    run(file, ['/S', `/D=${destination}`], { stdio: 'inherit' });
    if (!fs.existsSync(resourceDir(destination, platform))) {
      throw new Error(`Windows installer did not create an application at ${destination}.`);
    }
    return;
  }
  const unpacked = path.join(stage, 'unpacked');
  fs.mkdirSync(unpacked);
  let source;
  if (platform === 'darwin') {
    run('ditto', ['-x', '-k', file, unpacked], { stdio: 'inherit' });
    source = findBundle(unpacked);
  } else {
    fs.chmodSync(file, 0o755);
    run(file, ['--appimage-extract'], { cwd: unpacked, stdio: 'ignore' });
    source = path.join(unpacked, 'squashfs-root');
  }
  if (!source || !fs.existsSync(resourceDir(source, platform))) throw new Error('Downloaded runtime has no application resources.');
  // Fresh runtime installation only: an existing app is patched in place.
  if (fs.existsSync(destination)) throw new Error(`Destination already exists: ${destination}. Pass --app-path to the existing desktop app.`);
  const staging = `${destination}.fcr-new-${process.pid}`;
  try {
    fs.cpSync(source, staging, { recursive: true, verbatimSymlinks: true });
    fs.renameSync(staging, destination);
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

function hasUpstreamMain(file) {
  // Inspect the archive header without executing code from the installed app.
  const fd = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(16);
    if (fs.readSync(fd, header, 0, 16, 0) !== 16 || header.readUInt32LE(0) !== 4) return false;
    const length = header.readUInt32LE(12);
    if (!length || length > 32 * 1024 * 1024) return false;
    const json = Buffer.alloc(length);
    if (fs.readSync(fd, json, 0, length, 16) !== length) return false;
    const tree = JSON.parse(json.toString('utf8'));
    return Boolean(tree.files?.dist?.files?.main?.files?.['main.js']);
  } catch { return false; } finally { fs.closeSync(fd); }
}

function patchApp(appPath, platform, { root = ROOT, run = execFileSync, log = console.log } = {}) {
  const resources = resourceDir(appPath, platform);
  const original = path.join(resources, 'app-original.asar');
  const target = path.join(resources, 'app.asar');
  if (!fs.existsSync(resources)) throw new Error(`No resources directory at ${resources}. Point --app-path to the desktop app or extracted AppImage.`);
  const upstream = fs.existsSync(original) ? original : target;
  if (!fs.existsSync(upstream) || !hasUpstreamMain(upstream)) throw new Error('No compatible original router archive was found. Reinstall the official desktop app first.');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'fcr-patch-'));
  const stagedTarget = path.join(resources, `app.asar.${process.pid}.new`);
  let replaced = false;
  const rollback = path.join(stage, 'previous.build');
  try {
    pack(root, path.join(stage, 'app.asar'));
    if (fs.existsSync(target)) fs.copyFileSync(target, rollback);
    if (!fs.existsSync(original)) fs.copyFileSync(target, original, fs.constants.COPYFILE_EXCL);
    const backup = path.join(resources, 'app.asar.before-gate');
    if (fs.existsSync(target) && !fs.existsSync(backup)) fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
    fs.copyFileSync(path.join(stage, 'app.asar'), stagedTarget);
    fs.renameSync(stagedTarget, target);
    replaced = true;
    if (platform === 'darwin') run('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
    log(`Installed fcr into ${appPath}`);
    return appPath;
  } catch (error) {
    if (replaced) {
      if (fs.existsSync(rollback)) fs.copyFileSync(rollback, target);
      else fs.rmSync(target, { force: true });
      if (platform === 'darwin') {
        try { run('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'ignore' }); } catch {}
      }
    }
    throw error;
  } finally {
    fs.rmSync(stagedTarget, { force: true });
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

async function install(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const home = options.home || os.homedir();
  const env = options.env || process.env;
  const run = options.run || execFileSync;
  const log = options.log || console.log;
  const fetchImpl = options.fetchImpl || fetch;
  let appPath = options.appPath || env.CCR_APP_PATH || findApp(platform, home, env);
  if (appPath) {
    appPath = path.resolve(appPath);
    if (platform === 'linux' && fs.existsSync(appPath) && fs.statSync(appPath).isFile()) {
      const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'fcr-extract-'));
      try {
        const destination = defaultPath(platform, home, env);
        installRuntime(appPath, destination, platform, stage, run);
        appPath = destination;
      } finally { fs.rmSync(stage, { recursive: true, force: true }); }
    }
  } else {
    const response = await fetchImpl(RELEASE, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'fcr-terminal-installer' }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Could not find the official desktop release (HTTP ${response.status}).`);
    const asset = selectAsset(await response.json(), platform, arch);
    appPath = defaultPath(platform, home, env);
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'fcr-download-'));
    try {
      const file = path.join(stage, platform === 'darwin' ? 'runtime.zip' : platform === 'win32' ? 'runtime.exe' : 'runtime.AppImage');
      log(`Downloading and verifying ${asset.name}…`);
      await download(asset, file, fetchImpl);
      installRuntime(file, appPath, platform, stage, run);
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  }
  patchApp(appPath, platform, { root: options.root || ROOT, run, log });
  log(platform === 'darwin' ? `Open: open ${JSON.stringify(appPath)}` : platform === 'linux' ? `Open: ${JSON.stringify(path.join(appPath, 'AppRun'))}` : `Open: ${path.join(appPath, APP + '.exe')}`);
  return appPath;
}

async function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    console.log('Usage: node scripts/install.js [--app-path <desktop app or Linux AppImage>]\nRequires Node.js 22+ and a desktop session. With no installed app, downloads the official runtime and verifies its SHA-256. Close the app before installing.');
    return;
  }
  let appPath;
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--app-path') throw new Error('Use --help for installer options.');
    appPath = args[1];
  }
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Install Node.js 22 or newer first.');
  await install({ appPath });
}

if (require.main === module) main().catch(error => { console.error(`Installation failed: ${error.message}`); process.exitCode = 1; });
module.exports = { install, patchApp, installRuntime, selectAsset, download, hasUpstreamMain, findApp, defaultPath, resourceDir, main };
