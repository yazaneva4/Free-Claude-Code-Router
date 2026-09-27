'use strict';

/**
 * Builds something installable.
 *
 * This repo only holds the gate: the account layer, the gateway, the settings
 * and the updates. The router it wraps lives inside the installed application
 * bundle, which is why the app has to exist before anything here can run. So a
 * distributable is made by taking that bundle and swapping in a freshly packed
 * `app.asar`, which is exactly what `--install` does to the copy on this
 * machine. The result is a normal double clickable app plus a zip and a hash,
 * so the same artifact can be installed by hand or by the in-app updater.
 *
 *   node scripts/build-app.js [version]
 *
 * Writes into dist/: the app, a zip, and a SHA-256 of each.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/*
 * Electron patches `fs` so any path containing ".asar" is opened as an archive
 * rather than as a file, which is right for the running app and wrong for a
 * build script that is copying those files around as bytes.
 *
 * This is set unconditionally on purpose. The usual guard, `if ('noAsar' in
 * process)`, never fires here: Electron does not define the property up front,
 * so the check is false and the flag is never turned on.
 */
process.noAsar = true;

const ROOT = path.join(__dirname, '..');
const APP = process.env.CCR_APP_PATH || '/Applications/Claude Code Router.app';
const APP_NAME = path.basename(APP).replace(/\.app$/, '');
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(require('node:os').tmpdir(), 'ccr-dist');
const RESOURCE = 'Contents/Resources';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function say(message) {
  process.stdout.write(`${message}\n`);
}

function requireApp() {
  if (!fs.existsSync(APP)) {
    fail(
      `The router application is not installed at:\n  ${APP}\n\n` +
        'This project layers on top of it rather than replacing it, so install it first from\n' +
        'https://github.com/musistudio/claude-code-router/releases, then run this again.\n' +
        'Set CCR_APP_PATH if it lives somewhere else.',
    );
  }
  const upstream = path.join(APP, RESOURCE, 'app-original.asar');
  if (!fs.existsSync(upstream)) {
    fail(`That app bundle has no ${RESOURCE}/app-original.asar, so it does not look like the router. Check CCR_APP_PATH.`);
  }
  return { app: APP, upstream, resources: path.join(APP, RESOURCE) };
}

function pack(version) {
  const packed = path.join(STAGE, 'app.asar');
  require('node:child_process').execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'pack-asar.js'), ROOT, packed], { stdio: 'ignore' });
  const versioned = path.join(STAGE, `app-${version}.asar`);
  fs.copyFileSync(packed, versioned);
  return { packed, versioned, bytes: fs.statSync(versioned).size };
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const source = path.join(from, name);
    const target = path.join(to, name);
    const stat = fs.lstatSync(source);
    if (stat.isDirectory()) copyTree(source, target);
    else if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), target);
    else fs.copyFileSync(source, target);
  }
}

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function writeHash(file) {
  const out = `${file}.sha256`;
  fs.writeFileSync(out, `${hash(file)}  ${path.basename(file)}\n`);
  return out;
}

function main() {
  const version = process.argv[2] || JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const { app, upstream, resources } = requireApp();

  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });
  fs.mkdirSync(DIST, { recursive: true });

  say(`building ${version} from ${path.basename(app)}`);
  const built = pack(version);
  say(`packed app.asar (${built.bytes} bytes)`);

  // A copy of the bundle with our build in place of the previous one.
  const stagedApp = path.join(STAGE, `${APP_NAME}.app`);
  fs.rmSync(stagedApp, { recursive: true, force: true });
  copyTree(app, stagedApp);
  fs.copyFileSync(built.versioned, path.join(stagedApp, RESOURCE, 'app.asar'));
  // The upstream bundle is what the app reads at run time, so it stays.
  if (!fs.existsSync(path.join(stagedApp, RESOURCE, 'app-original.asar'))) {
    fs.copyFileSync(upstream, path.join(stagedApp, RESOURCE, 'app-original.asar'));
  }
  say(`assembled ${path.basename(stagedApp)}`);

  // Re-signing matters: a bundle edited after signing will not launch, and this
  // one has just had a file inside it replaced. An ad-hoc signature is enough
  // for a local install and needs no certificate.
  try {
    require('node:child_process').execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', stagedApp], { stdio: 'ignore' });
    say('signed the bundle ad hoc so it will launch');
  } catch (err) {
    fail(`The bundle could not be signed, so it would not launch: ${err && err.message ? err.message : err}`);
  }

  const zip = path.join(DIST, `${APP_NAME.replace(/\s+/g, '-')}-${version}.zip`);
  fs.rmSync(zip, { force: true });
  require('node:child_process').execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', stagedApp, zip], { stdio: 'ignore' });
  say(`zipped ${path.basename(zip)} (${fs.statSync(zip).size} bytes)`);

  const build = path.join(DIST, `app-${version}.asar`);
  fs.copyFileSync(built.versioned, build);
  writeHash(build);
  writeHash(zip);

  say('');
  say(`dist/${path.basename(build)}      the build the in-app updater installs`)
  say(`dist/${path.basename(zip)}  the whole app, for a manual install`)
  say('');
  say('Manual install: unzip it, move the app to /Applications, then run');
  say('  ./run.command --install');
  say('from this repository to put the current build in place.');
  say('');
  say('In-app install: the app checks this repository\'s releases and verifies the');
  say('hash of the build before swapping it in.');
}

main();
