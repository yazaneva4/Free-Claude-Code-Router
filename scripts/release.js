'use strict';

/**
 * Cuts a release so the in-app update check has something real to find.
 *
 *   GITHUB_TOKEN=... node scripts/release.js 1.1.0 "What changed"
 *   GITHUB_TOKEN=... node scripts/release.js 1.1.0 "notes" ./Claude Code Router.app.zip
 *
 * The token is read from the environment and never printed. Nothing is
 * published until every check below has passed.
 */

const fs = require('node:fs');
const path = require('node:path');

const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const PACKAGE = path.join(ROOT, 'package.json');
const REPO = process.env.CCR_RELEASE_REPO || 'yazaneva4/Free-Claude-Code-Router';
const API = `https://api.github.com/repos/${REPO}`;
const BUILD_ASSET = 'app.asar';
const CHECKSUM_ASSET = 'app.asar.sha256';
const STAGE = path.join(require('node:os').tmpdir(), 'ccr-release');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readPackage() {
  return JSON.parse(fs.readFileSync(PACKAGE, 'utf8'));
}

function isSemver(value) {
  return /^\d+\.\d+\.\d+$/.test(String(value || ''));
}

function compare(a, b) {
  const left = String(a).split('.').map(Number);
  const right = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

/**
 * A release is only installable if it carries the packed build and the hash of
 * that build, so both are always produced here rather than left to the caller.
 *
 * The build is packed here rather than taken from dist/ so a release can never
 * go out carrying a build that does not match this source tree.
 */
function stageBuild(version) {
  fs.mkdirSync(STAGE, { recursive: true });
  const packed = path.join(STAGE, BUILD_ASSET);
  require('node:child_process').execFileSync(
    process.execPath,
    [path.join(ROOT, 'scripts', 'pack-asar.js'), ROOT, packed],
    { stdio: 'inherit' },
  );
  const hash = crypto.createHash('sha256').update(fs.readFileSync(packed)).digest('hex');
  const checksum = path.join(STAGE, CHECKSUM_ASSET);
  fs.writeFileSync(checksum, `${hash}  ${BUILD_ASSET}\n`);
  process.stdout.write(`staged ${BUILD_ASSET} (${fs.statSync(packed).size} bytes) sha256 ${hash.slice(0, 16)}\u2026\n`);
  return { packed, checksum };
}

async function upload(url, token, file) {
  const name = path.basename(file);
  const body = fs.readFileSync(file);
  const response = await fetch(url, { method: 'POST', headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'claude-code-router-release', 'content-type': 'application/octet-stream', 'content-length': String(body.length) }, body });
  return { name, ok: response.ok, status: response.status, text: await response.text() };
}

async function call(api, token, target, options = {}) {
  const response = await fetch(`${API}${target}`, {
    ...options,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'claude-code-router-release',
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { ok: response.ok, status: response.status, body, text };
}

async function main() {
  const [version, notes, ...assets] = process.argv.slice(2);
  if (!isSemver(version)) fail('Usage: release.js <x.y.z> "release notes" [asset...]');
  if (!notes || !notes.trim()) fail('Release notes are required so the update screen has something to show.');

  const token = process.env.GITHUB_TOKEN;
  if (!token) fail('GITHUB_TOKEN is required. Create one at https://github.com/settings/tokens with repo scope.');

  const pkg = readPackage();
  if (compare(version, pkg.version) < 1) {
    fail(`Version ${version} is not newer than the packed ${pkg.version}. Raise package.json first or pass a higher version.`);
  }

  for (const asset of assets) {
    if (!fs.existsSync(asset)) fail(`Asset not found: ${asset}`);
  }

  const existing = await call(api, token, '/releases/latest');
  if (existing.ok && existing.body && existing.body.tag_name) {
    const latest = String(existing.body.tag_name).replace(/^v/i, '');
    if (compare(version, latest) < 1) fail(`Release ${latest} is already published, so ${version} would not be offered as an update.`);
  } else if (existing.status !== 404) {
    fail(`Could not read the latest release: HTTP ${existing.status} ${existing.text.slice(0, 200)}`);
  }

  const previous = { ...pkg };
  pkg.version = version;
  fs.writeFileSync(PACKAGE, `${JSON.stringify(pkg, null, 2)}\n`);
  process.stdout.write(`package.json ${previous.version} -> ${pkg.version}\n`);

  const created = await call(api, token, '/releases', {
    method: 'POST',
    body: JSON.stringify({
      tag_name: `v${version}`,
      name: `v${version}`,
      body: notes,
      draft: false,
      prerelease: false,
    }),
  });

  if (!created.ok) {
    fs.writeFileSync(PACKAGE, `${JSON.stringify(previous, null, 2)}\n`);
    fail(`Release was not created (HTTP ${created.status}); package.json was put back to ${previous.version}. ${created.text.slice(0, 300)}`);
  }

  process.stdout.write(`published ${REPO} release v${version}: ${created.body.html_url}\n`);

  const uploadBase = created.body.upload_url.replace(/\{.*\}$/, '');
  const staged = stageBuild(version);
  const files = [staged.checksum, staged.packed, ...assets];
  let allOk = true;
  for (const file of files) {
    const result = await upload(`${uploadBase}?name=${encodeURIComponent(path.basename(file))}`, token, file);
    if (result.ok) process.stdout.write(`attached ${result.name}\n`);
    else {
      allOk = false;
      process.stdout.write(`could not attach ${result.name}: HTTP ${result.status} ${result.text.slice(0, 200)}\n`);
    }
  }
  if (!allOk) fail('The release exists but is missing assets, so the app will report it as not installable. Re-upload them before closing it.');

  process.stdout.write(`\nDone. The app offers ${version} on its next update check.\n`);
  process.stdout.write(`Installing it downloads ${BUILD_ASSET}, checks the hash published beside it,\n`);
  process.stdout.write(`and swaps the build in. A release missing either file is reported as not\n`);
  process.stdout.write(`installable rather than half applied.\n`);
}

main().catch((err) => fail(err && err.stack ? err.stack : String(err)));
