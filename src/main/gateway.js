'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const apiKeyHelper = require('./api-key-helper');

const DEFAULT_ENDPOINT = 'http://127.0.0.1:3456';
const PROBE_TIMEOUT_MS = 60000;
const LIST_TIMEOUT_MS = 8000;
const BLOCKED_FILE = 'blocked-models.json';

const KINDS = {
  OK: 'ok',
  QUOTA: 'quota',
  UNAVAILABLE: 'unavailable',
  AUTH: 'auth',
  REFUSED: 'refused',
  UNKNOWN: 'unknown',
};

const MESSAGES = {
  [KINDS.OK]: 'The model answered.',
  [KINDS.QUOTA]: 'The provider refused this model because a quota or daily free allowance is used up. Pick another model or top up the provider.',
  [KINDS.UNAVAILABLE]: 'The provider is up but cannot serve this model right now. Load the model or pick another one.',
  [KINDS.AUTH]: 'The provider rejected the credential for this model.',
  [KINDS.REFUSED]: 'The router refused this model before it reached the provider.',
  [KINDS.UNKNOWN]: 'The request failed for an unknown reason.',
};

function classifyStatus(status, body = '') {
  const text = typeof body === 'string' ? body.toLowerCase() : '';
  const quotaWords = ['rate limit', 'rate_limit', 'quota', 'free-models-per-day', 'insufficient_quota', '429'];
  if (status === 429 || quotaWords.some((word) => text.includes(word))) return KINDS.QUOTA;
  if (status === 401 || status === 403) return KINDS.AUTH;
  if ([404, 400, 422, 502, 503, 504].includes(status)) {
    if (text.includes('all target providers failed') || text.includes('upstream')) return KINDS.UNAVAILABLE;
    return KINDS.UNAVAILABLE;
  }
  if (status >= 200 && status < 300) return KINDS.OK;
  return KINDS.UNKNOWN;
}

/**
 * The gateway's own token, read from whichever key helper script exists. The
 * file name carries the profile it belongs to, so it is discovered rather than
 * assumed, and a token that is not shaped like one is refused.
 */
function readToken(home = os.homedir()) {
  const token = apiKeyHelper.currentToken(home);
  if (!token) return null;
  return /^[A-Za-z0-9._-]{8,}$/.test(token) ? token : null;
}

function blockedFile(home = os.homedir()) {
  return path.join(home, '.claude-code-router', BLOCKED_FILE);
}

function readBlocked(home = os.homedir()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(blockedFile(home), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeBlocked(map, home = os.homedir()) {
  try {
    fs.mkdirSync(path.dirname(blockedFile(home)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(blockedFile(home), `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 });
  } catch {}
}

function rememberBlocked(model, result, home = os.homedir()) {
  const map = readBlocked(home);
  const id = String(model || '').trim();
  if (!id) return map;
  if (result && result.kind === KINDS.OK) {
    if (map[id]) {
      delete map[id];
      writeBlocked(map, home);
    }
    return map;
  }
  if (!result || result.kind !== KINDS.QUOTA) return map;
  const previous = map[id];
  map[id] = { kind: result.kind, at: new Date().toISOString(), message: result.message || MESSAGES[result.kind] };
  if (!previous || previous.at !== map[id].at) writeBlocked(map, home);
  return map;
}

function isBlocked(model, home = os.homedir()) {
  return Object.prototype.hasOwnProperty.call(readBlocked(home), String(model || '').trim());
}

function clearBlocked(home = os.homedir()) {
  writeBlocked({}, home);
}

async function request(endpoint, { path: suffix, method = 'GET', body, token, timeoutMs = LIST_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const base = String(endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${base}${suffix}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { 'x-api-key': token, authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {}
    return { status: response.status, text, body: parsed };
  } catch (err) {
    return { status: 0, text: String(err && err.message ? err.message : err), body: null, failed: true };
  } finally {
    clearTimeout(timer);
  }
}

async function probeModel(model, { endpoint = DEFAULT_ENDPOINT, token = null, home = os.homedir(), timeoutMs = PROBE_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const usedToken = token || readToken(home);
  const response = await request(endpoint, {
    path: '/v1/messages',
    method: 'POST',
    token: usedToken,
    timeoutMs,
    fetchImpl,
    body: { model, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] },
  });
  const detail = response.body && response.body.error ? response.body.error.message : response.text;
  const kind = response.failed ? KINDS.UNAVAILABLE : classifyStatus(response.status, response.text);
  const result = {
    model,
    kind,
    ok: kind === KINDS.OK,
    httpStatus: response.status,
    detail: String(detail || '').slice(0, 300),
    message: kind === KINDS.OK ? MESSAGES[KINDS.OK] : (response.failed ? `The gateway is not answering: ${String(detail).slice(0, 160)}` : MESSAGES[kind]),
    probedAt: new Date().toISOString(),
  };
  if (response.status > 0) rememberBlocked(model, result, home);
  return result;
}

async function listModels({ endpoint = DEFAULT_ENDPOINT, token = null, home = os.homedir(), includeBlocked = false, fetchImpl = fetch } = {}) {
  const usedToken = token || readToken(home);
  const response = await request(endpoint, { path: '/v1/models', token: usedToken, fetchImpl });
  const blocked = readBlocked(home);
  const data = response.body && Array.isArray(response.body.data) ? response.body.data : [];
  const models = data
    .map((item) => String(item && item.id ? item.id : '').trim())
    .filter(Boolean)
    .filter((id) => includeBlocked || !Object.prototype.hasOwnProperty.call(blocked, id));
  return { models, status: response.status, blocked: Object.keys(blocked) };
}

function looksLocal(model) {
  return /^(ollama|lmstudio|llamacpp)\//i.test(String(model || '').trim());
}

async function findWorkingModel(preferred, candidates, options = {}) {
  const order = [];
  const push = (model) => {
    const id = String(model || '').trim();
    if (id && !order.includes(id)) order.push(id);
  };
  push(preferred);
  for (const model of candidates.filter(looksLocal)) push(model);
  for (const model of candidates) push(model);

  const tried = [];
  for (const model of order) {
    if (options.isBlocked && options.isBlocked(model)) {
      tried.push({ model, kind: KINDS.QUOTA, skipped: true, message: 'Skipped: this model already hit its quota.' });
      continue;
    }
    const result = await probeModel(model, options);
    tried.push(result);
    if (result.ok) return { model, result, tried };
  }
  return { model: null, result: null, tried };
}

module.exports = {
  DEFAULT_ENDPOINT,
  KINDS,
  MESSAGES,
  BLOCKED_FILE,
  classifyStatus,
  readToken,
  readBlocked,
  writeBlocked,
  rememberBlocked,
  isBlocked,
  clearBlocked,
  request,
  probeModel,
  listModels,
  looksLocal,
  findWorkingModel,
};
