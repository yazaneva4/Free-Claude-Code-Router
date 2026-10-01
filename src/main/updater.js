'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { RELEASES_URL, check: checkRelease, compareVersions, parseVersion } = require('./updates');

/**
 * Updates for this build.
 *
 * The bundled router updates itself with Squirrel.Mac, which only ever works
 * for an app signed with a real Apple Developer ID. This build is ad-hoc
 * signed, so that path can download a release and then always fail with
 * "code-signature validation" while leaving a dead button behind. Worse, the
 * only feed it knows is upstream, and installing that would overwrite the whole
 * custom build.
 *
 * So updates are applied the same way this build is installed in the first
 * place: the release carries one packed `app.asar` plus its SHA-256, and
 * installing means verifying that hash and swapping that single file. No Apple
 * certificate, and nothing here can revert the customisations.
 */

const ASSET_NAME = 'app.asar';
const CHECKSUM_NAME = `${ASSET_NAME}.sha256`;
/*
 * Electron patches `fs` so that any path containing ".asar" is opened as an
 * archive rather than as a file, and it decides that once when it starts, so
 * the flag cannot be turned off again at runtime. Everything this module keeps
 * on disk therefore avoids that substring, and the one file that must keep the
 * name -- the installed build -- is only ever touched by shelling out to
 * /bin/cp and /bin/mv, which no such patch can intercept.
 */
const STAGED_NAME = 'app.build';
const BACKUP_SUFFIX = '.build';
const MAX_ASSET_BYTES = 256 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120000;
const PROGRESS_STEPS = 20;

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function updateDir(home = os.homedir()) {
  return path.join(home, '.claude-code-router', 'updates');
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Accepts the many shapes a checksum file is written in. */
function readChecksum(text) {
  const match = String(text || '')
    .trim()
    .match(/^([a-f0-9]{64})/i);
  return match ? match[1].toLowerCase() : null;
}

function findAsset(assets, name) {
  if (!Array.isArray(assets)) return null;
  return assets.find((asset) => asset && asset.name === name && !asset.draft) || null;
}

/**
 * A release is only installable when it ships both the build and its hash, and
 * the version parses. Anything else is reported rather than half-applied.
 */
function describeRelease(release) {
  const version = release && release.latestVersion ? String(release.latestVersion) : null;
  const notes = parseVersion(version);
  if (!release || !release.ok) {
    return { ok: false, code: 'check_failed', error: (release && release.error) || 'The update check did not finish.' };
  }
  if (release.noRelease) {
    return { ok: true, state: 'no-release', version: null, notes: release.notes || null, releaseUrl: release.releaseUrl || null };
  }
  if (!notes) {
    return { ok: false, code: 'bad_version', error: 'The published release is not named as a version like 1.2.3.' };
  }
  if (!release.assetUrl || !release.checksumUrl) {
    return {
      ok: false,
      state: 'incomplete-release',
      code: 'missing_asset',
      version,
      error: `Release ${version} does not carry ${ASSET_NAME} and ${CHECKSUM_NAME}, so it cannot be installed safely.`,
    };
  }
  return {
    ok: true,
    state: 'ready',
    version,
    notes: release.notes || null,
    releaseUrl: release.releaseUrl || null,
    publishedAt: release.publishedAt || null,
    assetUrl: release.assetUrl,
    checksumUrl: release.checksumUrl,
    assetName: ASSET_NAME,
  };
}

/**
 * Resolves the newest release and decides whether it is actually an upgrade.
 * Never offers the same version, a downgrade, or a release with no build.
 */
async function check({ currentVersion, home = os.homedir(), force = false, fetchImpl = fetch, now = Date.now() } = {}) {
  const found = await checkRelease({ currentVersion, home, force, fetchImpl, now });
  const described = describeRelease(found);

  if (described.state === 'no-release') {
    return {
      ok: true,
      state: 'no-release',
      currentVersion,
      updateAvailable: false,
      latestVersion: null,
      notes: described.notes,
      releaseUrl: described.releaseUrl,
      // Carried through like every other branch, so a caller can tell a real
      // answer from one replayed out of the cache.
      cached: Boolean(found.cached),
      checkedAt: new Date(now).toISOString(),
    };
  }

  if (!described.ok && described.code === 'check_failed') {
    return {
      ok: false,
      state: 'check-failed',
      code: described.code,
      currentVersion,
      updateAvailable: false,
      error: described.error,
      cached: Boolean(found.cached),
      checkedAt: new Date(now).toISOString(),
    };
  }

  const order = described.version ? compareVersions(described.version, currentVersion) : null;
  const updateAvailable = described.state === 'ready' && order === 1;

  let state = described.state;
  if (described.state === 'ready' && !updateAvailable) {
    state = order === 0 ? 'current' : 'ahead';
  }

  return {
    ok: described.ok || state === 'incomplete-release',
    state,
    code: described.ok ? null : described.code,
    currentVersion,
    latestVersion: described.version || null,
    updateAvailable,
    notes: described.notes || null,
    releaseUrl: described.releaseUrl || null,
    publishedAt: described.publishedAt || null,
    assetUrl: described.assetUrl || null,
    checksumUrl: described.checksumUrl || null,
    error: described.ok ? null : described.error,
    cached: Boolean(found.cached),
    checkedAt: new Date(now).toISOString(),
  };
}

async function fetchBuffer(url, { fetchImpl = fetch, timeoutMs = DOWNLOAD_TIMEOUT_MS, onProgress = null, maxBytes = MAX_ASSET_BYTES } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/octet-stream', 'user-agent': 'claude-code-router-update' },
      signal: controller.signal,
    });
    if (!response.ok) throw fail('download_failed', `The download answered HTTP ${response.status}.`);

    const length = Number(response.headers && response.headers.get ? response.headers.get('content-length') : 0);
    if (length && length > maxBytes) {
      throw fail('asset_too_large', `The build is ${Math.round(length / 1048576)} MB, which is larger than this app will install.`);
    }

    const declared = response.headers && response.headers.get ? Number(response.headers.get('content-length')) : 0;
    if (response.body && typeof response.body.getReader === 'function' && declared > 0) {
      // Streamed so a large build reports progress instead of stalling silently.
      const reader = response.body.getReader();
      const chunks = [];
      let seen = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        seen += value.length;
        if (seen > maxBytes) {
          reader.cancel().catch(() => {});
          throw fail('asset_too_large', 'The build grew larger than this app will install.');
        }
        chunks.push(Buffer.from(value));
        if (onProgress) onProgress(Math.min(1, seen / declared));
      }
      return { buffer: Buffer.concat(chunks), bytes: seen };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw fail('asset_too_large', 'The build is larger than this app will install.');
    if (onProgress) onProgress(1);
    return { buffer, bytes: buffer.length };
  } catch (err) {
    if (err && err.code) throw err;
    throw fail('download_failed', `The download did not finish: ${err && err.message ? err.message : err}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches the build and its hash, and only accepts them as a pair. A build that
 * does not match its published hash is never written to disk.
 */
async function download({ version, assetUrl, checksumUrl, home = os.homedir(), fetchImpl = fetch, onProgress = null } = {}) {
  if (!parseVersion(version)) throw fail('bad_version', 'No version was given to download.');
  if (!assetUrl || !checksumUrl) throw fail('missing_asset', `This release does not carry ${ASSET_NAME} and ${CHECKSUM_NAME}.`);

  const report = typeof onProgress === 'function' ? onProgress : () => {};
  report({ phase: 'download', ratio: 0 });

  const [asset, checksum] = await Promise.all([
    fetchBuffer(assetUrl, { fetchImpl, onProgress: (ratio) => report({ phase: 'download', ratio: ratio * 0.9 }) }),
    fetchBuffer(checksumUrl, { fetchImpl }),
  ]);

  const expected = readChecksum(checksum.buffer.toString('utf8'));
  if (!expected) throw fail('bad_checksum', 'The published checksum file is not a SHA-256 hash, so the build cannot be trusted.');

  const actual = sha256(asset.buffer);
  if (actual !== expected) {
    throw fail('checksum_mismatch', 'The downloaded build does not match the hash published with it, so it was not installed.');
  }

  const dir = path.join(updateDir(home), String(version));
  const file = path.join(dir, STAGED_NAME);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${file}.part`;
  fs.writeFileSync(temp, asset.buffer, { mode: 0o600 });
  fs.renameSync(temp, file);
  report({ phase: 'verified', ratio: 1 });

  return { ok: true, version: String(version), file, bytes: asset.bytes, sha256: actual };
}

/**
 * Swaps in a verified build. The old one is kept so a bad release can be put
 * back, and the new file is written beside the target and renamed over it so a
 * half-written asar is never possible.
 */
/**
 * Reads the version out of a packed build.
 *
 * The header is a 16 byte preamble: the JSON length sits at offset 12, while
 * offset 8 holds the padded length plus four, so the first file byte is at
 * `16 + (readUInt32LE(8) - 4)` rather than straight after the JSON. Getting
 * that wrong reads padding as file content.
 */
function packedVersionOf(buffer) {
  if (!buffer || buffer.length < 16) return null;
  const jsonLength = buffer.readUInt32LE(12);
  const paddedLength = buffer.readUInt32LE(8) - 4;
  if (!Number.isFinite(jsonLength) || jsonLength <= 0) return null;
  if (!Number.isFinite(paddedLength) || paddedLength < jsonLength) return null;
  if (16 + paddedLength > buffer.length) return null;
  let tree;
  try {
    tree = JSON.parse(buffer.subarray(16, 16 + jsonLength).toString('utf8'));
  } catch {
    return null;
  }
  const entry = tree && tree.files && tree.files['package.json'];
  if (!entry || !entry.size) return null;
  const start = 16 + paddedLength + Number(entry.offset || 0);
  if (start + entry.size > buffer.length) return null;
  try {
    return JSON.parse(buffer.subarray(start, start + entry.size).toString('utf8')).version || null;
  } catch {
    return null;
  }
}

/**
 * Copies and renames files with the archive layer switched off.
 *
 * Electron patches `fs` so that any path containing ".asar" is opened as an
 * archive rather than as a file. That is right for the running app and wrong
 * here, where the build is being moved as plain bytes. Setting the flag works,
 * unlike the usual `if ('noAsar' in process)` guard, which never fires because
 * Electron does not define the property up front. This replaces shelling out
 * to /bin/cp and /bin/mv, which only ever worked on macOS and Linux.
 */
function withPlainFs(fn) {
  const prior = process.noAsar;
  process.noAsar = true;
  try {
    return fn();
  } finally {
    process.noAsar = prior;
  }
}

/**
 * Swaps in a build that has already been verified.
 *
 * The artifact is checked before anything live is touched: it has to be a real
 * packed build and it has to report the version it was published as. Only then
 * is the installed file replaced, by writing beside it and renaming over the
 * top, so an interrupted install leaves the previous build in place. The build
 * that was there is kept so it can be put back.
 */
function install({ version, file, target, home = os.homedir(), now = Date.now() } = {}) {
  if (!parseVersion(version)) throw fail('bad_version', 'No version was given to install.');
  if (!file || !fs.existsSync(file)) throw fail('missing_download', 'The downloaded build is no longer on disk. Check for updates again.');

  const body = fs.readFileSync(file);
  const claimed = packedVersionOf(body);
  if (!claimed) throw fail('not_an_asar', 'The downloaded file is not a packed build.');
  if (claimed !== String(version)) {
    throw fail('version_mismatch', `The build reports ${claimed} but was published as ${version}, so nothing was installed.`);
  }

  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(home, '.claude-code-router', 'backups');
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const backup = path.join(backupDir, `app-${stamp}${BACKUP_SUFFIX}`);

  const targetDir = path.dirname(target);
  if (!fs.existsSync(targetDir)) throw fail('missing_target', `The app is not installed at ${target}.`);

  let hadPrevious = false;
  try {
    withPlainFs(() => fs.copyFileSync(target, backup));
    hadPrevious = true;
  } catch {
    // No previous build to keep, which only happens on a first install.
  }

  // Written beside the target and renamed over it, so an interrupted install
  // cannot leave half a build where the app expects a whole one.
  const staged = path.join(targetDir, `.ccr-update-${process.pid}${BACKUP_SUFFIX}`);
  try {
    withPlainFs(() => {
      fs.copyFileSync(file, staged);
      fs.chmodSync(staged, 0o644);
      fs.renameSync(staged, target);
    });
  } catch (err) {
    try { withPlainFs(() => fs.unlinkSync(staged)); } catch {}
    if (hadPrevious) {
      try { withPlainFs(() => fs.copyFileSync(backup, target)); } catch {}
    }
    throw fail('install_failed', `The new build could not be put in place: ${err && err.message ? err.message : err}`);
  }

  return { ok: true, version: String(version), installedVersion: claimed, target, backup: hadPrevious ? backup : null };
}

function installedVersionOf(file) {
  try {
    return packedVersionOf(fs.readFileSync(file));
  } catch {
    return null;
  }
}

module.exports = {
  ASSET_NAME,
  CHECKSUM_NAME,
  RELEASES_URL,
  updateDir,
  STAGED_NAME,
  packedVersionOf,
  withPlainFs,
  sha256,
  readChecksum,
  findAsset,
  describeRelease,
  check,
  download,
  install,
  installedVersionOf,
  MAX_ASSET_BYTES,
  PROGRESS_STEPS,
};
