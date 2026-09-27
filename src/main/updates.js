'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RELEASES_URL = 'https://api.github.com/repos/yazaneva4/Free-Claude-Code-Router/releases/latest';
const CHECK_TIMEOUT_MS = 10000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STATE_FILE = 'update-check.json';
const BUILD_ASSET = 'app.asar';
const CHECKSUM_ASSET = 'app.asar.sha256';

function parseVersion(value) {
  const match = String(value || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  if (left.major !== right.major) return left.major > right.major ? 1 : -1;
  if (left.minor !== right.minor) return left.minor > right.minor ? 1 : -1;
  if (left.patch !== right.patch) return left.patch > right.patch ? 1 : -1;
  return 0;
}

function stateFile(home = os.homedir()) {
  return path.join(home, '.claude-code-router', STATE_FILE);
}

function readState(home = os.homedir()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(home), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(value, home = os.homedir()) {
  try {
    fs.mkdirSync(path.dirname(stateFile(home)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(stateFile(home), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  } catch {}
}

function assetUrl(assets, name) {
  if (!Array.isArray(assets)) return null;
  const found = assets.find((asset) => asset && asset.name === name && !asset.draft);
  return found && typeof found.browser_download_url === 'string' ? found.browser_download_url : null;
}

async function fetchLatest({ fetchImpl = fetch, url = RELEASES_URL, timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'claude-code-router-update-check' },
      signal: controller.signal,
    });
    if (response.status === 404) return { ok: true, version: null, noRelease: true };
    if (!response.ok) return { ok: false, error: `The update service answered HTTP ${response.status}.` };
    const body = await response.json();
    const tag = body && (body.tag_name || body.name);
    if (!parseVersion(tag)) return { ok: false, error: 'The update service did not name a version.' };
    return {
      ok: true,
      version: String(tag).replace(/^v/i, ''),
      url: typeof body.html_url === 'string' ? body.html_url : null,
      notes: typeof body.body === 'string' ? body.body.slice(0, 2000) : null,
      publishedAt: body.published_at || null,
      assetUrl: assetUrl(body.assets, BUILD_ASSET),
      checksumUrl: assetUrl(body.assets, CHECKSUM_ASSET),
    };
  } catch (err) {
    return { ok: false, error: `Could not reach the update service: ${err && err.message ? err.message : err}` };
  } finally {
    clearTimeout(timer);
  }
}

async function check({ currentVersion, home = os.homedir(), force = false, fetchImpl = fetch, now = Date.now() } = {}) {
  const previous = readState(home);
  const fresh = previous.checkedAt && now - Date.parse(previous.checkedAt) < CHECK_INTERVAL_MS;
  if (!force && fresh && previous.currentVersion === currentVersion) return { ...previous, cached: true };

  const latest = await fetchLatest({ fetchImpl });
  if (latest.noRelease) {
    const state = {
      currentVersion,
      checkedAt: new Date(now).toISOString(),
      ok: true,
      noRelease: true,
      error: null,
      latestVersion: previous.latestVersion || null,
      releaseUrl: previous.releaseUrl || null,
      notes: previous.notes || null,
      publishedAt: previous.publishedAt || null,
      assetUrl: null,
      checksumUrl: null,
      updateAvailable: false,
    };
    writeState(state, home);
    return state;
  }
  const state = {
    currentVersion,
    checkedAt: new Date(now).toISOString(),
    ok: latest.ok,
    noRelease: false,
    error: latest.ok ? null : latest.error,
    latestVersion: latest.ok ? latest.version : (previous.latestVersion || null),
    releaseUrl: latest.ok ? latest.url : (previous.releaseUrl || null),
    notes: latest.ok ? latest.notes : (previous.notes || null),
    publishedAt: latest.ok ? latest.publishedAt : (previous.publishedAt || null),
    assetUrl: latest.ok ? (latest.assetUrl || null) : (previous.assetUrl || null),
    checksumUrl: latest.ok ? (latest.checksumUrl || null) : (previous.checksumUrl || null),
  };
  state.updateAvailable = Boolean(latest.ok && compareVersions(latest.version, currentVersion) === 1);
  writeState(state, home);
  return state;
}

module.exports = {
  RELEASES_URL,
  CHECK_INTERVAL_MS,
  STATE_FILE,
  BUILD_ASSET,
  CHECKSUM_ASSET,
  parseVersion,
  compareVersions,
  readState,
  writeState,
  fetchLatest,
  check,
};
