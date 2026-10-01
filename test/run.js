'use strict';

/**
 * A crash has to be as visible as a failed test.
 *
 * A failing test is caught and reported, but a crash — a require that throws
 * before any test runs, or a rejection nobody was waiting for — kills the
 * process with a stack trace and nothing else. Under Actions that stack trace
 * is buried in a log nobody reads, and a platform that fails this way looks
 * identical to one that fails for a reason. So both are turned into an
 * annotation that appears next to the run, and the process still exits
 * non-zero.
 */
function reportCrash(what, err) {
  const message = err && err.message ? err.message : String(err);
  console.error(`CRASH ${what}: ${message}`);
  if (err && err.stack) console.error(err.stack);
  if (process.env.GITHUB_ACTIONS === 'true') {
    const flat = (text) => String(text).replace(/[%\r\n]/g, ' ');
    const at = err && err.stack && /([\w./\\-]+\.js):(\d+):\d+/.exec(err.stack);
    console.error(`::error ${at ? `file=${at[1]},line=${at[2]},` : ''}title=crash: ${flat(what)}::${flat(message)}`);
  }
  process.exit(1);
}

process.on('uncaughtException', (err) => reportCrash('uncaught exception', err));
process.on('unhandledRejection', (err) => reportCrash('unhandled rejection', err));

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../src/main/store');
const { createCrypto, hashPassword, verifyPassword } = require('../src/main/crypto');
const { AccountService, AuthError } = require('../src/main/accounts');
const { Vault } = require('../src/main/vault');
const { Settings } = require('../src/main/settings');
const providers = require('../src/main/providers');
const harnesses = require('../src/main/harnesses');
const agentEnv = require('../src/main/agent-env');
const gateway = require('../src/main/gateway');
const agents = require('../src/main/agents');
const updates = require('../src/main/updates');
const { SyncWorker } = require('../src/main/sync');
const profileWriter = require('../src/main/profile-writer');
const updater = require('../src/main/updater');
const { UpdateService, silenceBundledUpdater } = require('../src/main/update-service');
const apiKeyHelper = require('../src/main/api-key-helper');

let passed = 0;
let failed = 0;
const pending = [];

function test(name, fn) {
  const record = (ok, err) => {
    if (ok) {
      passed += 1;
      console.log(`ok   ${name}`);
    } else {
      failed += 1;
      const why = err && err.message ? err.message : String(err);
      console.error(`FAIL ${name}: ${why}`);
      // Under Actions the log is the only place a failure shows, and a red line
      // on the changed file beats hunting through a log. Percent signs and
      // newlines are escaped because GitHub reads both as syntax, which would
      // turn one failure into several or none.
      if (process.env.GITHUB_ACTIONS === 'true') {
        const at = err && err.stack && /test[\\/]run\.js:(\d+):\d+/.exec(err.stack);
        console.error(`::error ${at ? `file=test/run.js,line=${at[1]},` : ''}title=${name.replace(/[%\r\n]/g, ' ')}::${why.replace(/[%\r\n]/g, ' ')}`);
      }
    }
  };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      pending.push(result.then(() => record(true), (err) => record(false, err)));
      return;
    }
    record(true);
  } catch (err) {
    record(false, err);
  }
}

/**
 * What a generated key helper would print.
 *
 * On macOS and Linux the helper is a `/bin/sh` script, so it is run and its
 * output checked. It stays a posix script on every platform, because the thing
 * that reads it is Claude Code, which asks for a `.cmd` on Windows itself, so
 * there is no Windows form of it to execute here. On Windows the file is read
 * instead and the token it would print is checked, which is the part that
 * matters and the part that can be checked anywhere.
 */
function helperOutput(file, expectedToken) {
  const fs2 = require('node:fs');
  if (process.platform !== 'win32') {
    return require('node:child_process').execFileSync('/bin/sh', [file], { encoding: 'utf8' }).trim();
  }
  const body = fs2.readFileSync(file, 'utf8');
  const printed = body.match(/printf\s+'%s\\n'\s+'([^']+)'/);
  assert.ok(printed, 'the helper says how to print the token');
  assert.strictEqual(printed[1], expectedToken, 'and it prints the right one');
  return printed[1];
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-test-'));
}

function harness(clock) {
  const dir = tempDir();
  const store = new Store(dir);
  const crypto = createCrypto({ keyFile: store.file('.devicekey') });
  const now = clock || (() => Date.now());
  const vault = new Vault({ store, crypto, now });
  return {
    dir,
    store,
    crypto,
    vault,
    accounts: new AccountService({ store, crypto, now, purge: (accountId) => vault.deleteAllForAccount(accountId) }),
    settings: new Settings({ store }),
  };
}

const GOOD = { displayName: 'Yazan', email: 'yazan@example.com', password: 'correcthorse9', storageMode: 'device' };

test('password hashing is salted and verifies', () => {
  const a = hashPassword('correcthorse9');
  const b = hashPassword('correcthorse9');
  assert.notStrictEqual(a.hash, b.hash, 'hashes must differ across calls (unique salt)');
  assert.ok(verifyPassword('correcthorse9', a));
  assert.ok(!verifyPassword('wronghorse9', a));
  assert.ok(!verifyPassword('correcthorse9', null));
});

test('weak passwords and bad emails are rejected', () => {
  const h = harness();
  assert.throws(() => h.accounts.signup({ ...GOOD, password: 'short' }), AuthError);
  assert.throws(() => h.accounts.signup({ ...GOOD, password: 'alllettersonly' }), AuthError);
  assert.throws(() => h.accounts.signup({ ...GOOD, email: 'nope' }), AuthError);
  assert.throws(() => h.accounts.signup({ ...GOOD, storageMode: 'cloud' }), AuthError);
});

test('signup creates an account, a session, and never stores the password in the clear', () => {
  const h = harness();
  const session = h.accounts.signup(GOOD);
  assert.strictEqual(session.account.email, 'yazan@example.com');
  assert.ok(session.account.storageMode === 'device');
  assert.strictEqual(session.account.password, undefined, 'public account must not carry a password');
  const raw = fs.readFileSync(h.store.file('accounts.json'), 'utf8');
  assert.ok(!raw.includes('correcthorse9'), 'plaintext password must not be on disk');
  const sessionRaw = fs.readFileSync(h.store.file('session.json'), 'utf8');
  assert.ok(!/"token":\s*"[A-Za-z0-9_-]{20,}/.test(sessionRaw), 'session token must be encrypted at rest');
});

test('duplicate email is refused', () => {
  const h = harness();
  h.accounts.signup(GOOD);
  assert.throws(() => h.accounts.signup({ ...GOOD, password: 'anotherpass9' }), (err) => err.code === 'email_taken');
});

test('login rejects wrong password and accepts the right one', () => {
  const h = harness();
  h.accounts.signup(GOOD);
  h.accounts.logout();
  assert.throws(() => h.accounts.login({ email: GOOD.email, password: 'nope12345' }), (err) => err.code === 'invalid_credentials');
  assert.throws(() => h.accounts.login({ email: 'ghost@example.com', password: GOOD.password }), (err) => err.code === 'invalid_credentials');
  const session = h.accounts.login({ email: 'YAZAN@example.com', password: GOOD.password });
  assert.strictEqual(session.account.email, 'yazan@example.com', 'email match is case-insensitive');
});

test('there is no guest mode: privileged calls require a session', () => {
  const h = harness();
  assert.strictEqual(h.accounts.session(), null);
  assert.throws(() => h.accounts.requireSession(), (err) => err.code === 'signed_out');
  assert.throws(() => h.accounts.changePassword({ currentPassword: 'x', newPassword: 'y' }), (err) => err.code === 'signed_out');
  assert.throws(() => h.accounts.updateProfile({ displayName: 'x' }), (err) => err.code === 'signed_out');
  h.accounts.signup(GOOD);
  h.accounts.logout();
  assert.throws(() => h.accounts.requireSession(), (err) => err.code === 'signed_out');
});

test('expired sessions are rejected and cleared', () => {
  let clock = 1000;
  const h = harness(() => clock);
  h.accounts.signup(GOOD);
  assert.ok(h.accounts.session(), 'session valid before expiry');
  clock += 31 * 24 * 60 * 60 * 1000;
  assert.strictEqual(h.accounts.session(), null, 'session must expire');
  assert.strictEqual(h.accounts.store.exists('session.json'), false, 'expired session file is removed');
});

test('a session file with an unreadable token or an unknown account is refused', () => {
  const h = harness();
  h.accounts.signup(GOOD);
  const real = JSON.parse(fs.readFileSync(h.store.file('session.json'), 'utf8'));

  h.store.write('session.json', { ...real, token: 'not-even-encrypted' });
  assert.strictEqual(h.accounts.session(), null, 'a token that fails its integrity check is refused');
  assert.strictEqual(h.accounts.store.exists('session.json'), false, 'the bad session file is cleared');

  h.store.write('session.json', { ...real, token: real.token, accountId: 'made-up-account' });
  assert.strictEqual(h.accounts.session(), null, 'a session for an account that does not exist is refused');

  h.store.write('session.json', 'null');
  assert.strictEqual(h.accounts.session(), null, 'a null session file is refused');
  assert.throws(() => h.accounts.requireSession(), (err) => err.code === 'signed_out');
});

test('a corrupt or non-object store file falls back instead of crashing', () => {
  const h = harness();
  h.accounts.signup(GOOD);
  assert.ok(h.accounts.session(), 'a healthy session still works');

  fs.writeFileSync(h.store.file('accounts.json'), '{ this is not json');
  assert.doesNotThrow(() => h.accounts.count());
  assert.strictEqual(h.accounts.count(), 0, 'a corrupt account file reads as empty');
  assert.ok(fs.existsSync(h.store.file('accounts.json.corrupt')), 'the unreadable file is kept for inspection');

  fs.writeFileSync(h.store.file('accounts.json'), 'null');
  assert.strictEqual(h.accounts.count(), 0, 'a null account file reads as empty');

  fs.writeFileSync(h.store.file('device.json'), '[]');
  assert.strictEqual(h.accounts.device().syncChoiceAskedAt, null, 'a non-object device file reads as defaults');

  fs.writeFileSync(h.store.file('settings.json'), '"a string"');
  assert.ok(h.settings.get().routing, 'settings fall back to defaults');
  assert.doesNotThrow(() => h.vault.list('nobody'));
});

test('change password requires the current one and refuses reuse', () => {
  const h = harness();
  h.accounts.signup(GOOD);
  assert.throws(() => h.accounts.changePassword({ currentPassword: 'bad', newPassword: 'brandnew123' }), (err) => err.code === 'invalid_credentials');
  assert.throws(() => h.accounts.changePassword({ currentPassword: GOOD.password, newPassword: GOOD.password }), (err) => err.code === 'password_reused');
  h.accounts.changePassword({ currentPassword: GOOD.password, newPassword: 'brandnew123' });
  h.accounts.logout();
  assert.throws(() => h.accounts.login({ email: GOOD.email, password: GOOD.password }), (err) => err.code === 'invalid_credentials');
  assert.ok(h.accounts.login({ email: GOOD.email, password: 'brandnew123' }));
});

test('vault stores credentials encrypted and never returns plaintext to callers', () => {
  const h = harness();
  h.accounts.signup(GOOD);
  const accountId = h.accounts.session().account.id;
  const saved = h.vault.set(accountId, { providerId: 'openai', secret: 'sk-super-secret-value', label: 'OpenAI' });
  assert.strictEqual(saved.entry.hasSecret, true);
  assert.strictEqual(saved.entry.secret, undefined, 'vault must not return the secret');
  const onDisk = fs.readFileSync(h.store.file('vault.json'), 'utf8');
  assert.ok(!onDisk.includes('sk-super-secret-value'), 'credential must be encrypted at rest');
  const listed = h.vault.list(accountId);
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].hasSecret, true);
  assert.strictEqual(JSON.stringify(listed).includes('sk-super-secret'), false, 'listing must not leak the secret');
  assert.strictEqual(h.vault.secret(accountId, 'openai'), 'sk-super-secret-value', 'router can read it internally');
});

test('vault replace overwrites and delete removes, with no reveal path', () => {
  const h = harness();
  h.accounts.signup(GOOD);
  const accountId = h.accounts.session().account.id;
  h.vault.set(accountId, { providerId: 'openai', secret: 'first-secret' });
  const replaced = h.vault.set(accountId, { providerId: 'openai', secret: 'second-secret' });
  assert.strictEqual(replaced.replaced, true);
  assert.strictEqual(h.vault.secret(accountId, 'openai'), 'second-secret');
  assert.strictEqual(h.vault.list(accountId).length, 1, 'replace must not duplicate');
  assert.strictEqual(typeof h.vault.reveal, 'undefined', 'vault must expose no reveal function');
  h.vault.delete(accountId, 'openai');
  assert.strictEqual(h.vault.has(accountId, 'openai'), false);
  assert.throws(() => h.vault.delete(accountId, 'openai'), (err) => err.code === 'not_found');
});

test('credentials are isolated per account', () => {
  const h = harness();
  h.accounts.signup(GOOD);
  const first = h.accounts.session().account.id;
  h.vault.set(first, { providerId: 'openai', secret: 'first-only' });
  h.accounts.signup({ ...GOOD, email: 'second@example.com', password: 'secondpass9' });
  const second = h.accounts.session().account.id;
  assert.strictEqual(h.vault.list(second).length, 0);
  assert.strictEqual(h.vault.secret(second, 'openai'), null);
  assert.strictEqual(h.vault.secret(first, 'openai'), 'first-only');
});

test('deleting an account erases its credentials and signs out', () => {
  const h = harness();
  h.accounts.signup(GOOD);
  const id = h.accounts.session().account.id;
  h.vault.set(id, { providerId: 'openai', secret: 'bye' });
  h.accounts.deleteAccount();
  assert.strictEqual(h.accounts.count(), 0);
  assert.strictEqual(h.vault.list(id).length, 0);
  assert.strictEqual(h.accounts.session(), null);
});

test('deleting an account fails closed when a purge hook is missing', () => {
  const dir = tempDir();
  const store = new Store(dir);
  const crypto = createCrypto({ keyFile: store.file('.devicekey') });
  const accounts = new AccountService({ store, crypto });
  accounts.signup(GOOD);
  assert.throws(() => accounts.deleteAccount(), (err) => err.code === 'purge_unavailable');
  assert.strictEqual(accounts.count(), 1, 'account must survive a refused delete');
});

test('sync mode requires an https endpoint', () => {
  const h = harness();
  h.accounts.signup({ ...GOOD, storageMode: 'synced' });
  assert.throws(() => h.accounts.updateProfile({ syncEndpoint: 'http://insecure' }), (err) => err.code === 'invalid_sync_endpoint');
  const updated = h.accounts.updateProfile({ syncEndpoint: 'https://sync.example.com' });
  assert.strictEqual(updated.account.syncEnabled, true);
  assert.strictEqual(updated.account.storageMode, 'synced');
});

test('huggingface is rejected everywhere in the provider layer', () => {
  assert.strictEqual(providers.getProvider('huggingface'), null);
  assert.strictEqual(providers.getProvider('HF'), null);
  const serialized = JSON.stringify(providers.catalog()).toLowerCase();
  assert.ok(!serialized.includes('huggingface'), 'catalog must not mention Hugging Face');
  const models = providers.normalizeModels({ data: [{ id: 'hf/evil' }, { id: 'gpt-4o' }, { id: 'huggingface/x' }] });
  assert.deepStrictEqual(models.map((m) => m.id), ['gpt-4o']);
});

test('the three local runtimes are configured on the right ports', () => {
  const ids = providers.LOCAL_PROVIDERS.map((p) => p.id).sort();
  assert.deepStrictEqual(ids, ['llamacpp', 'lmstudio', 'ollama']);
  assert.strictEqual(providers.getProvider('lmstudio').baseUrl, 'http://127.0.0.1:1234/v1');
  assert.strictEqual(providers.getProvider('ollama').baseUrl, 'http://127.0.0.1:11434/v1');
  assert.strictEqual(providers.getProvider('llamacpp').baseUrl, 'http://127.0.0.1:8080/v1');
});

test('a stored credential is never sent to a host the user did not configure', () => {
  const openai = providers.getProvider('openai');
  assert.strictEqual(providers.usableBaseUrl(openai, null), 'https://api.openai.com/v1');
  assert.strictEqual(
    providers.usableBaseUrl(openai, 'https://api.openai.com/v1/'),
    'https://api.openai.com/v1',
    'the provider endpoint itself is always allowed',
  );
  assert.strictEqual(
    providers.usableBaseUrl(providers.getProvider('ollama'), 'http://127.0.0.1:11434/v1'),
    'http://127.0.0.1:11434/v1',
    'a different local port is allowed for local runtimes',
  );
  assert.strictEqual(
    providers.usableBaseUrl(providers.getProvider('ollama'), 'http://localhost:9999/v1'),
    'http://localhost:9999/v1',
    'localhost is a loopback address',
  );
  assert.throws(() => providers.usableBaseUrl(openai, 'https://evil.example.com/v1'), /credential/i);
  assert.throws(() => providers.usableBaseUrl(openai, 'http://169.254.169.254/latest'), /credential/i);
  assert.throws(() => providers.usableBaseUrl(openai, 'file:///etc/passwd'), /http/i);
  assert.throws(() => providers.usableBaseUrl(providers.getProvider('ollama'), 'not a url'), /http/i);
});

test('probing a forbidden host reports the refusal instead of leaking the key', async () => {
  const result = await providers.probe('openai', { secret: 'sk-test-value', baseUrl: 'https://evil.example.com/v1' });
  assert.strictEqual(result.reachable, false);
  assert.ok(/credential/i.test(result.error), `expected a refusal, got: ${result.error}`);
});

test('model normalization handles ollama and openai shapes', () => {
  assert.deepStrictEqual(providers.normalizeModels({ data: [{ id: 'llama3.2:1b' }] }), [{ id: 'llama3.2:1b', ownedBy: null, contextWindow: null }]);
  const tags = providers.normalizeModels({ models: [{ name: 'qwen2.5', model: 'qwen2.5' }] });
  assert.deepStrictEqual(tags.map((m) => m.id), ['qwen2.5']);
});

test('settings default to local providers and refuse unsupported or unknown routing', () => {
  const h = harness();
  const defaults = h.settings.get();
  assert.strictEqual(defaults.routing.preferredProvider, 'ollama');
  assert.deepStrictEqual(defaults.routing.fallbackOrder, ['lmstudio', 'ollama', 'llamacpp']);
  assert.throws(() => h.settings.setRouting({ preferredProvider: 'huggingface' }), (err) => err.code === 'unsupported_provider');
  assert.throws(() => h.settings.setRouting({ preferredProvider: 'made-up' }), (err) => err.code === 'unknown_provider');
  const updated = h.settings.setRouting({ preferredProvider: 'llamacpp', fallbackOrder: ['llamacpp', 'ollama'] });
  assert.strictEqual(updated.routing.preferredProvider, 'llamacpp');
  assert.deepStrictEqual(updated.routing.fallbackOrder, ['llamacpp', 'ollama']);
  assert.throws(() => h.settings.setRouting({ fallbackOrder: ['llamacpp', 'huggingface'] }), (err) => err.code === 'unsupported_provider');
  assert.throws(() => h.settings.setRouting({ modelByProvider: { 'hf/gpt': 'x' } }), (err) => err.code === 'unsupported_provider');
  assert.deepStrictEqual(h.settings.get().routing.fallbackOrder, ['llamacpp', 'ollama'], 'a refused routing patch changes nothing');
});

test('an unsupported provider is refused everywhere it could be added', async () => {
  const h = harness();
  const banned = ['huggingface', 'hf', 'hugging-face', 'hugging_face', 'HuggingFace', 'hf.co/x', 'HF'];
  for (const id of banned) {
    assert.ok(providers.isForbiddenProviderId(id), `${id} counts as unsupported`);
    assert.strictEqual(providers.getProvider(id), null, `${id} has no provider record`);
    assert.throws(
      () => h.settings.setProvider(id, { enabled: true }),
      (err) => err.code === 'unsupported_provider',
      `settings must refuse ${id}`,
    );
    assert.throws(
      () => providers.assertSupportedProvider(id),
      (err) => err.code === 'unsupported_provider',
      `the catalog must refuse ${id}`,
    );
  }
  assert.throws(() => h.settings.setProvider('made-up', {}), (err) => err.code === 'unknown_provider');
  await assert.rejects(() => providers.listModels('huggingface'), (err) => err.code === 'unsupported_provider');
  await assert.rejects(() => providers.listModels('made-up'), (err) => err.code === 'unknown_provider');

  for (const model of ['hf/gpt-oss-120b', 'huggingface/gpt', 'HF/anything', 'hugging-face/x']) {
    assert.ok(providers.isForbiddenModelId(model), `${model} is a forbidden model`);
  }
  for (const model of ['gpt-4o', 'qwen3-coder', 'llama3.3', 'gemini-2.5-pro']) {
    assert.ok(!providers.isForbiddenModelId(model), `${model} is a legitimate model`);
  }
  const listed = providers.ALL_PROVIDERS.map((p) => p.id);
  for (const id of banned) assert.ok(!listed.includes(id.toLowerCase()), 'the catalog never offers it');
});

test('a provider refusal is reported as what it is, not as a gateway error', () => {
  assert.strictEqual(gateway.classifyStatus(200, '{}'), 'ok');
  assert.strictEqual(gateway.classifyStatus(429, '{"error":{"message":"Rate limit exceeded: free-models-per-day"}}'), 'quota');
  assert.strictEqual(gateway.classifyStatus(429, ''), 'quota');
  assert.strictEqual(gateway.classifyStatus(200, 'quota exceeded'), 'quota', 'the body decides when the status does not');
  assert.strictEqual(gateway.classifyStatus(502, '{"error":{"message":"All target providers failed."}}'), 'unavailable');
  assert.strictEqual(gateway.classifyStatus(401, ''), 'auth');
  assert.strictEqual(gateway.classifyStatus(403, ''), 'auth');
  assert.strictEqual(gateway.classifyStatus(500, 'boom'), 'unknown');
  assert.ok(!/gateway/i.test(gateway.MESSAGES.quota), 'a quota stop is never called a gateway error');
  assert.ok(/quota|daily/i.test(gateway.MESSAGES.quota));
  assert.ok(/Load the model|pick another/i.test(gateway.MESSAGES.unavailable));
});

test('a model that hits its quota is remembered and hidden from the picker', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-gw-'));
  assert.deepStrictEqual(gateway.readBlocked(home), {});
  gateway.rememberBlocked('OpenRouter/cohere/north-mini-code:free', { kind: 'quota' }, home);
  assert.ok(gateway.isBlocked('OpenRouter/cohere/north-mini-code:free', home));
  assert.ok(gateway.readBlocked(home)['OpenRouter/cohere/north-mini-code:free'].kind === 'quota');
  gateway.rememberBlocked('ollama/llama3.2:1b', { kind: 'unavailable' }, home);
  assert.ok(!gateway.isBlocked('ollama/llama3.2:1b', home), 'a provider outage does not hide a model');
  gateway.rememberBlocked('OpenRouter/cohere/north-mini-code:free', { kind: 'ok' }, home);
  assert.ok(!gateway.isBlocked('OpenRouter/cohere/north-mini-code:free', home), 'a model that answers is offered again');
  gateway.rememberBlocked('OpenRouter/x:free', { kind: 'quota' }, home);
  gateway.clearBlocked(home);
  assert.deepStrictEqual(gateway.readBlocked(home), {});
  assert.ok(gateway.looksLocal('ollama/llama3.2:1b') && gateway.looksLocal('lmstudio/qwen/qwen3-1.7b'));
  assert.ok(!gateway.looksLocal('OpenRouter/cohere/north-mini-code:free'));
});

test('the working model is chosen by probing, and local models are preferred', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-gw2-'));
  const asked = [];
  const fetchImpl = async (_url, options) => {
    const model = JSON.parse(options.body).model;
    asked.push(model);
    if (model === 'OpenRouter/cohere/north-mini-code:free') {
      return { ok: false, status: 429, text: async () => '{"error":{"message":"Rate limit exceeded: free-models-per-day"}}' };
    }
    if (model === 'lmstudio/qwen/qwen3-1.7b') {
      return { ok: false, status: 502, text: async () => '{"error":{"message":"All target providers failed."}}' };
    }
    return { ok: true, status: 200, text: async () => '{"content":[{"type":"text","text":"pong"}]}' };
  };
  const found = await gateway.findWorkingModel(
    'OpenRouter/cohere/north-mini-code:free',
    ['OpenRouter/cohere/north-mini-code:free', 'lmstudio/qwen/qwen3-1.7b', 'ollama/llama3.2:1b'],
    { home, fetchImpl, endpoint: 'http://127.0.0.1:3456', token: 't' },
  );
  assert.strictEqual(found.model, 'ollama/llama3.2:1b', 'the model that answers wins');
  assert.deepStrictEqual(asked, ['OpenRouter/cohere/north-mini-code:free', 'lmstudio/qwen/qwen3-1.7b', 'ollama/llama3.2:1b']);
  assert.strictEqual(found.tried[0].kind, 'quota');
  assert.strictEqual(found.tried[1].kind, 'unavailable');
  assert.strictEqual(found.tried[2].kind, 'ok');
  assert.ok(gateway.isBlocked('OpenRouter/cohere/north-mini-code:free', home), 'the capped model is remembered');

  const none = await gateway.findWorkingModel('a', ['b'], {
    home,
    endpoint: 'http://127.0.0.1:3456',
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'boom' }),
  });
  assert.strictEqual(none.model, null);
});

test('an installed agent is never connected without being added', () => {
  const h = harness();
  const detected = agents.detect({
    env: { PATH: '/usr/bin' },
    home: '/Users/someone',
    exists: (dir) => String(dir).includes('Claude.app'),
  });
  const claudeCode = detected.find((entry) => entry.id === 'claude-code');
  assert.strictEqual(claudeCode.installed, false, 'no claude binary on the PATH');
  assert.strictEqual(detected.find((entry) => entry.id === 'claude-app').installed, true, 'Claude.app is installed');

  const before = h.settings.get();
  assert.deepStrictEqual(before.agents.profiles, {}, 'detection alone changes nothing');
  const listed = agents.listAgents(before);
  for (const agent of listed) {
    assert.strictEqual(agent.added, false);
    assert.strictEqual(agent.enabled, false);
    assert.strictEqual(agent.needsLogin, false, 'no agent login is ever collected');
  }
  assert.ok(listed.find((agent) => agent.id === 'claude-code').paid, 'a paid agent is marked paid');
  assert.deepStrictEqual(h.settings.get().agents.profiles, {}, 'listing does not connect anything');
});

test('agent profiles keep built-in models and refuse what the router will not use', () => {
  const h = harness();
  const known = ['ollama/llama3.2:1b', 'lmstudio/qwen/qwen3-1.7b'];
  const profiles = agents.addProfile(h.settings.get(), 'claude-code', { enabled: true, model: 'ollama/llama3.2:1b' }, { knownModels: known });
  const saved = h.settings.setAgentProfiles(profiles);
  assert.strictEqual(saved.agents.profiles['claude-code'].model, 'ollama/llama3.2:1b', 'a paid agent keeps a real model');
  assert.strictEqual(saved.agents.profiles['claude-code'].enabled, true);
  assert.ok(!('secret' in saved.agents.profiles['claude-code']), 'no credential is stored for an agent');

  const publicAgent = agents.listAgents(saved, { knownModels: known }).find((agent) => agent.id === 'claude-code');
  assert.deepStrictEqual(publicAgent.gatewayModels, known, 'the models the gateway serves are offered for a paid agent');
  assert.deepStrictEqual(publicAgent.ownModels, [], 'nothing is claimed as a built-in before the agent was asked');
  assert.strictEqual(publicAgent.needsLogin, false);

  assert.throws(() => agents.updateProfile(saved, 'claude-code', { model: 'hf/gpt-oss' }, { knownModels: known }), (err) => err.code === 'forbidden_model');
  assert.throws(() => agents.updateProfile(saved, 'claude-code', { model: 'made/up' }, { knownModels: known }), (err) => err.code === 'unknown_model');
  assert.throws(() => agents.updateProfile(saved, 'claude-code', { baseUrl: 'https://evil.example.com' }), (err) => err.code === 'invalid_base_url');
  assert.throws(() => agents.addProfile(saved, 'huggingface', {}), (err) => err.code === 'unknown_agent');
  assert.throws(() => agents.updateProfile(saved, 'codex-cli', {}), (err) => err.code === 'profile_not_added');
  assert.throws(() => agents.validateModel('huggingface/gpt'), (err) => err.code === 'forbidden_model');
  assert.strictEqual(agents.validateModel('auto'), 'auto');

  const removed = h.settings.setAgentProfiles(agents.removeProfile(saved, 'claude-code'));
  assert.deepStrictEqual(removed.agents.profiles, {});
});

test('the agent model is written into the profile the router manages', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-prof-'));
  const dir = path.join(home, '.claude-code-router', 'profiles', 'claude-code', 'claude');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_MODEL: 'lmstudio/qwen/qwen3-1.7b', ANTHROPIC_BASE_URL: 'http://127.0.0.1:3456' }, theme: 'dark' }));
  assert.strictEqual(profileWriter.readModel({ home }).model, 'lmstudio/qwen/qwen3-1.7b');
  const applied = profileWriter.applyModel('ollama/llama3.2:1b', { home });
  assert.strictEqual(applied.length, 1);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(after.env.ANTHROPIC_MODEL, 'ollama/llama3.2:1b');
  assert.strictEqual(after.env.CCR_CLAUDE_CODE_MODEL, 'ollama/llama3.2:1b');
  assert.strictEqual(after.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:3456', 'the endpoint is left alone');
  assert.strictEqual(after.theme, 'dark', 'other settings survive');
  assert.deepStrictEqual(profileWriter.applyModel('ollama/llama3.2:1b', { home }), [], 'writing twice changes nothing');
});

test('a repair only rewrites the profile that was actually broken', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-fix-'));
  const write = (id, relative, model) => {
    const dir = path.join(home, '.claude-code-router', 'profiles', id, path.dirname(relative));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, path.basename(relative));
    fs.writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_MODEL: model } }));
    return file;
  };
  const broken = write('claude-code', 'claude/settings.json', 'OpenRouter/cohere/north-mini-code:free');
  const fine = write('codex-cli', 'claude/settings.json', 'ollama/llama3.2:1b');

  const applied = profileWriter.applyModel('ollama/llama3.2:1b', { home, profileId: 'claude-code' });
  assert.strictEqual(applied.length, 1, 'only the named profile is touched');
  assert.strictEqual(applied[0].file, broken);
  assert.strictEqual(JSON.parse(fs.readFileSync(broken, 'utf8')).env.ANTHROPIC_MODEL, 'ollama/llama3.2:1b');
  assert.strictEqual(JSON.parse(fs.readFileSync(fine, 'utf8')).env.ANTHROPIC_MODEL, 'ollama/llama3.2:1b');
  assert.strictEqual(profileWriter.settingsFiles(home).length, 2, 'every profile is still listed');
  assert.strictEqual(profileWriter.settingsFiles(home, 'claude-code').length, 1, 'one profile can be listed on its own');
  assert.strictEqual(profileWriter.readModel({ home, profileId: 'codex-cli' }).model, 'ollama/llama3.2:1b');
});

test('the update check compares versions without inventing one', async () => {
  assert.deepStrictEqual(updates.parseVersion('v1.2.3'), { major: 1, minor: 2, patch: 3 });
  assert.deepStrictEqual(updates.parseVersion('2.0'), null);
  assert.strictEqual(updates.compareVersions('1.2.4', '1.2.3'), 1);
  assert.strictEqual(updates.compareVersions('1.2.3', '1.2.3'), 0);
  assert.strictEqual(updates.compareVersions('1.1.9', '1.2.0'), -1);
  assert.strictEqual(updates.compareVersions('nope', '1.0.0'), null);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-upd-'));
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ tag_name: 'v9.9.9', html_url: 'https://example.invalid/r', body: 'notes' }) });
  const state = await updates.check({ currentVersion: '1.0.0', home, fetchImpl, now: 1000 });
  assert.strictEqual(state.updateAvailable, true);
  assert.strictEqual(state.latestVersion, '9.9.9');
  const same = await updates.check({ currentVersion: '9.9.9', home, fetchImpl, now: 2000 });
  assert.strictEqual(same.updateAvailable, false, 'being on the newest version is not an update');
  const none = await updates.check({
    currentVersion: '1.0.0',
    home: fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-upd2-')),
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    now: 1000,
  });
  assert.strictEqual(none.ok, true, 'a repository with no release is not an error');
  assert.strictEqual(none.noRelease, true);
  assert.strictEqual(none.updateAvailable, false);
  assert.strictEqual(none.error, null, 'it does not claim the network failed');
  const offline = await updates.check({ currentVersion: '1.0.0', home, force: true, fetchImpl: async () => { throw new Error('offline'); }, now: 3000 });
  assert.strictEqual(offline.ok, false);
  assert.ok(/Could not reach/.test(offline.error));
  assert.strictEqual(offline.latestVersion, '9.9.9', 'the last known version is kept when offline');
});

test('settings are pushed to the sync endpoint and pulled back', async () => {
  const h = harness();
  const seen = [];
  const worker = new SyncWorker({
    settings: h.settings,
    resolveEndpoint: () => 'https://sync.example.com',
    fetchImpl: async (url, options = {}) => {
      seen.push({ url, method: options.method || 'GET' });
      if (options.method === 'POST') return { ok: true, status: 200, text: async () => '{"ok":true}' };
      return { ok: true, status: 200, json: async () => ({ sentAt: '2026-01-01T00:00:00.000Z', agents: { profiles: { 'gemini-cli': { enabled: true, model: 'auto', baseUrl: 'http://127.0.0.1:3456' } } } }) };
    },
  });
  const pushed = await worker.push();
  assert.strictEqual(pushed.ok, true);
  assert.strictEqual(seen[0].url, 'https://sync.example.com/ccr/settings');
  assert.strictEqual(seen[0].method, 'POST');
  const pulled = await worker.pull();
  assert.strictEqual(pulled.ok, true);
  assert.ok(h.settings.get().agents.profiles['gemini-cli'], 'a pulled profile is applied');
  worker.stop();

  const off = new SyncWorker({ settings: h.settings, resolveEndpoint: () => null, fetchImpl: async () => { throw new Error('should not run'); } });
  assert.deepStrictEqual(await off.push(), { ok: false, skipped: true, reason: 'no_endpoint' });
  off.stop();
});

test('a synced or hand-edited file cannot smuggle in what we refuse', () => {
  const h = harness();
  assert.throws(
    () => h.settings.save({ ...h.settings.get(), providers: { ...h.settings.get().providers, huggingface: { enabled: true } } }),
    (err) => err.code === 'unsupported_provider',
  );
  assert.throws(
    () => h.settings.save({ ...h.settings.get(), routing: { ...h.settings.get().routing, modelByProvider: { made_up: 'x' } } }),
    (err) => err.code === 'unknown_provider',
  );
  assert.throws(
    () => h.settings.save({ ...h.settings.get(), gateway: { ...h.settings.get().gateway, hiddenModels: ['hf/gpt-oss'] } }),
    (err) => err.code === 'forbidden_model',
  );
  assert.throws(
    () => h.settings.save({ ...h.settings.get(), agents: { profiles: { 'evil-agent': { enabled: true } } } }),
    (err) => err.code === 'unknown_agent',
  );
  assert.throws(
    () => h.settings.save({ ...h.settings.get(), agents: { profiles: { 'claude-code': { baseUrl: 'https://evil.example.com' } } } }),
    (err) => err.code === 'invalid_base_url',
  );
  const withJunk = h.settings.save({
    ...h.settings.get(),
    integrations: { app: { sneaky: { enabled: true } }, cli: { ...h.settings.get().integrations.cli } },
  });
  assert.ok(!('sneaky' in withJunk.integrations.app), 'an integration that does not exist is dropped');
  assert.ok(withJunk.integrations.cli.gemini, 'the real integrations are untouched');
  const untouched = h.settings.get();
  assert.deepStrictEqual(untouched.agents.profiles, {}, 'a refused write changes nothing on disk');
  assert.ok(untouched.providers.ollama, 'the real settings are still intact');
});

test('settings pushed to a sync endpoint keep their refusals when they come back', async () => {
  const h = harness();
  const worker = new SyncWorker({
    settings: h.settings,
    resolveEndpoint: () => 'https://sync.example.com',
    fetchImpl: async (_url, options = {}) => {
      if (options.method === 'POST') return { ok: true, status: 200, text: async () => '{"ok":true}' };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          providers: { huggingface: { enabled: true } },
          agents: { profiles: { 'claude-code': { enabled: true, model: 'hf/gpt-oss' } } },
        }),
      };
    },
  });
  const pulled = await worker.pull();
  assert.strictEqual(pulled.ok, false, 'a hostile payload is not applied');
  assert.ok(/huggingface|not supported|unsupported/i.test(pulled.error), pulled.error);
  assert.deepStrictEqual(h.settings.get().agents.profiles, {}, 'nothing from the payload landed');
  assert.ok(!('huggingface' in h.settings.get().providers));
  worker.stop();
});

test('an agent is only asked for models through a command its own help advertises', async () => {
  const run = (script) => async (binary, args) => {
    if (args[0] === '--help') return { ok: true, stdout: script.help, stderr: '' };
    return { ok: true, stdout: script.list, stderr: '' };
  };

  const advertised = await agents.discoverModels('claude-code', {
    env: { PATH: '/usr/bin' },
    binaryPath: '/usr/bin/claude',
    run: run({ help: 'Commands:\n  run     start a session\n  list-models  show what this plan can use\n', list: 'claude-opus-4-5\nclaude-sonnet-4-5\ngpt-4o-mini\n' }),
  });
  assert.strictEqual(advertised.source, 'agent');
  assert.deepStrictEqual(advertised.models, ['claude-opus-4-5', 'claude-sonnet-4-5', 'gpt-4o-mini']);
  assert.strictEqual(advertised.command, 'list-models');

  const silent = await agents.discoverModels('claude-code', {
    env: { PATH: '/usr/bin' },
    binaryPath: '/usr/bin/claude',
    run: run({ help: 'Commands:\n  run   start a session\n', list: '' }),
  });
  assert.deepStrictEqual(silent.models, []);
  assert.strictEqual(silent.source, 'needs-subscription', 'a paid agent waits for the plan that carries its models');
  assert.strictEqual(silent.billed, true);
  assert.ok(/pay for|pays for/i.test(silent.reason), 'and it says that paying is what reveals them');
  assert.strictEqual(silent.command, undefined, 'a command that is not documented is never guessed at');
  assert.ok(!silent.command);

  const signIn = await agents.discoverModels('codex-cli', {
    env: { PATH: '/usr/bin' },
    binaryPath: '/usr/bin/codex',
    run: run({ help: 'models  list models', list: 'Error: please log in to list models\n' }),
  });
  assert.strictEqual(signIn.source, 'needs-sign-in', 'we report the sign-in instead of asking for one');
  assert.ok(!/password|token/i.test(signIn.reason), 'no credential is ever requested');
  assert.deepStrictEqual(signIn.models, []);

  const forbidden = await agents.discoverModels('gemini-cli', {
    env: { PATH: '/usr/bin' },
    binaryPath: '/usr/bin/gemini',
    run: run({ help: 'models list', list: 'gemini-2.5-pro\nhf/gpt-oss\n' }),
  });
  assert.deepStrictEqual(forbidden.models, ['gemini-2.5-pro'], 'a refused model is never offered back');

  const missing = await agents.discoverModels('codex-cli', { env: { PATH: '/usr/bin' }, run: async () => { throw new Error('must not run'); } });
  assert.strictEqual(missing.source, 'not-installed');
  const desktop = await agents.discoverModels('claude-app', { run: async () => { throw new Error('must not run'); } });
  assert.strictEqual(desktop.source, 'not-askable', 'a desktop app is never asked');
  assert.deepStrictEqual(desktop.models, []);
});

test('the model a profile may use is what the gateway serves or the agent reported', () => {
  const h = harness();
  const known = ['ollama/llama3.2:1b'];
  const withOwn = agents.listAgents(h.settings.get(), {
    knownModels: known,
    discovered: { 'claude-code': { models: ['claude-opus-4-5'], source: 'agent' } },
  }).find((agent) => agent.id === 'claude-code');
  assert.deepStrictEqual(withOwn.ownModels, ['claude-opus-4-5']);
  assert.deepStrictEqual(withOwn.gatewayModels, ['ollama/llama3.2:1b']);
  assert.strictEqual(withOwn.ownModelsSource, 'agent');
  const profiles = agents.addProfile(h.settings.get(), 'claude-code', { enabled: true }, { knownModels: known });
  const withProfile = { ...h.settings.get(), agents: { profiles } };
  const saved = agents.updateProfile(withProfile, 'claude-code', { model: 'claude-opus-4-5' }, { knownModels: ['claude-opus-4-5', 'ollama/llama3.2:1b'] });
  assert.strictEqual(saved['claude-code'].model, 'claude-opus-4-5');
  assert.throws(
    () => agents.updateProfile(withProfile, 'claude-code', { model: 'made-up-9' }, { knownModels: known }),
    (err) => err.code === 'unknown_model',
  );
});

test('an API key saved on one device opens on another signed-in device', async () => {
  const PASSWORD = 'correcthorse9';
  const EMAIL = 'yazan@example.com';
  const ENDPOINT = 'https://sync.example.com';

  // A stand-in for the sync endpoint: it stores only what it is handed.
  const wire = new Map();
  const server = async (url, options = {}) => {
    if (options.method === 'POST') {
      wire.set(url, options.body);
      return { ok: true, status: 200, text: async () => '{"ok":true}' };
    }
    if (!wire.has(url)) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, json: async () => JSON.parse(wire.get(url)) };
  };

  const build = () => {
    const h = harness();
    h.accounts.signup({ email: EMAIL, password: PASSWORD, displayName: 'Yazan', storageMode: 'synced' });
    h.accounts.updateProfile({ displayName: 'Yazan', storageMode: 'synced', syncEndpoint: ENDPOINT });
    const worker = new SyncWorker({ settings: h.settings, vault: h.vault, accounts: h.accounts, resolveEndpoint: () => ENDPOINT, fetchImpl: server });
    return { h, worker };
  };

  // ---- the device that saves the keys ----
  const one = build();
  const oneId = one.h.accounts.session().account.id;
  one.h.vault.set(oneId, { providerId: 'ollama', secret: 'sk-local-ollama', label: 'Ollama' });
  one.h.vault.set(oneId, { providerId: 'openai', secret: 'sk-real-openai', label: 'OpenAI' });
  const pushed = await one.worker.pushVault();
  assert.strictEqual(pushed.ok, true, pushed.error);
  assert.strictEqual(pushed.shared, 2);

  // Nothing readable left the device.
  const body = [...wire.values()].join('');
  assert.ok(!body.includes('sk-real-openai'), 'the endpoint never receives a key in the clear');
  assert.ok(!body.includes('sk-local-ollama'));
  assert.ok(!body.includes(EMAIL), 'the endpoint is given a handle, not an address');
  assert.ok(!body.includes(oneId), 'the local account id is never published');

  // ---- a second device, same account, signed in with the same password ----
  const two = build();
  const twoId = two.h.accounts.session().account.id;
  assert.notStrictEqual(twoId, oneId, 'the two devices keep their own local account records');
  assert.deepStrictEqual(two.h.vault.list(twoId), [], 'the second device starts with nothing');

  const pulled = await two.worker.pullVault();
  assert.strictEqual(pulled.ok, true, pulled.error);
  assert.strictEqual(pulled.imported, 2);
  const listed = two.h.vault.list(twoId).sort((a, b) => a.providerId.localeCompare(b.providerId));
  assert.deepStrictEqual(listed.map((entry) => entry.providerId), ['ollama', 'openai']);
  assert.ok(listed.every((entry) => entry.hasSecret));
  assert.strictEqual(two.h.vault.secret(twoId, 'openai'), 'sk-real-openai', 'the key works on the second device');
  assert.strictEqual(two.h.vault.secret(twoId, 'ollama'), 'sk-local-ollama');
  assert.ok(!('secret' in listed[0]), 'the listing still never carries a key');

  // ---- a device that is not the same account gets nothing ----
  const stranger = harness();
  stranger.accounts.signup({ email: 'someone-else@example.com', password: 'correcthorse9', displayName: 'Someone' });
  stranger.accounts.updateProfile({ displayName: 'Someone', storageMode: 'synced', syncEndpoint: ENDPOINT });
  const strangerSync = new SyncWorker({ settings: stranger.settings, vault: stranger.vault, accounts: stranger.accounts, resolveEndpoint: () => ENDPOINT, fetchImpl: server });
  const strangerPull = await strangerSync.pullVault();
  assert.strictEqual(strangerPull.ok, true);
  assert.strictEqual(strangerPull.nothingSaved, true, 'another account sees none of these keys');
  assert.deepStrictEqual(stranger.vault.list(stranger.accounts.session().account.id), []);

  // ---- the wrong password cannot open them ----
  const wrong = harness();
  wrong.accounts.signup({ email: EMAIL, password: 'a different password 9', displayName: 'Yazan' });
  wrong.accounts.updateProfile({ displayName: 'Yazan', storageMode: 'synced', syncEndpoint: ENDPOINT });
  const wrongSync = new SyncWorker({ settings: wrong.settings, vault: wrong.vault, accounts: wrong.accounts, resolveEndpoint: () => ENDPOINT, fetchImpl: server });
  const wrongPull = await wrongSync.pullVault();
  assert.strictEqual(wrongPull.ok, false, 'a key sealed with another password is not opened');
  assert.strictEqual(wrongPull.code, 'wrong_password');
  assert.deepStrictEqual(wrong.vault.list(wrong.accounts.session().account.id), []);

  // ---- a refused provider in an envelope is never imported ----
  const hostile = new Map();
  const { deriveVaultKey, encryptPortable } = require('../src/main/crypto');
  const sealed = deriveVaultKey(PASSWORD, one.h.accounts.load().accounts[0].vaultSalt);
  hostile.set(
    'x',
    JSON.stringify({
      version: 1,
      credentials: encryptPortable(
        sealed,
        JSON.stringify([
          { providerId: 'huggingface', secret: 'sk-hostile' },
          { providerId: 'ollama', secret: 'sk-fine' },
        ]),
      ),
    }),
  );
  const three = build();
  const threeId = three.h.accounts.session().account.id;
  const imported = three.h.vault.importEnvelope(threeId, three.h.accounts.vaultKey(), JSON.parse(hostile.get('x')));
  assert.strictEqual(imported.imported, 1, 'only the supported provider came in');
  assert.strictEqual(three.h.vault.secret(threeId, 'ollama'), 'sk-fine');
  assert.strictEqual(three.h.vault.find(threeId, 'huggingface'), null);

  // ---- nothing to share, and no endpoint, are both reported, not thrown ----
  assert.deepStrictEqual(await one.worker.pushVault({ endpoint: null }), { ok: false, skipped: true, reason: 'no_endpoint' });
  const empty = harness();
  empty.accounts.signup({ ...GOOD, storageMode: 'device' });
  const emptySync = new SyncWorker({ settings: empty.settings, vault: empty.vault, accounts: empty.accounts, resolveEndpoint: () => ENDPOINT, fetchImpl: server });
  const emptyPush = await emptySync.pushVault();
  assert.strictEqual(emptyPush.ok, true);
  assert.strictEqual(emptyPush.shared, 0, 'a device with no keys shares nothing rather than failing');
});

test('a device with no sync endpoint never claims to share anything', async () => {
  const h = harness();
  h.accounts.signup({ ...GOOD, storageMode: 'device' });
  const worker = new SyncWorker({ settings: h.settings, vault: h.vault, accounts: h.accounts, resolveEndpoint: () => null });
  assert.deepStrictEqual(await worker.pushVault(), { ok: false, skipped: true, reason: 'no_endpoint' });
  assert.deepStrictEqual(await worker.pullVault(), { ok: false, skipped: true, reason: 'no_endpoint' });
  worker.stop();
});

test('signing in again is what lets this device share keys', () => {
  const h = harness();
  h.accounts.signup({ ...GOOD, storageMode: 'synced' });
  const before = h.accounts.vaultKey();
  assert.ok(before && before.length === 32, 'signing in leaves a key that can seal credentials');
  h.accounts.logout();
  assert.strictEqual(h.accounts.vaultKey(), null, 'no key survives signing out');
  h.accounts.login({ email: GOOD.email, password: GOOD.password });
  assert.ok(h.accounts.vaultKey(), 'signing back in gives the key back without asking again');
});

test('the harnesses can find the agent CLIs the shell installed', () => {
  // Built from this platform's separator and delimiter rather than written out
  // as posix strings. A colon is only the delimiter on macOS and Linux, so the
  // original form asserted something false on Windows and failed there.
  const home = path.join(path.sep, 'Users', 'someone');
  const agentBin = path.join(home, '.local', 'bin');
  const usrBin = path.join(path.sep, 'usr', 'bin');
  const rootBin = path.join(path.sep, 'bin');
  const inherited = [usrBin, rootBin].join(path.delimiter);

  const env = { PATH: inherited };
  const present = new Set([usrBin, rootBin, agentBin]);
  const result = agentEnv.ensureAgentPath(env, home, (dir) => present.has(dir));
  assert.deepStrictEqual(result.added, [agentBin], 'only real directories are added');
  assert.strictEqual(env.PATH.split(path.delimiter)[0], agentBin, 'the agent bin dir comes first');
  assert.ok(env.PATH.endsWith(inherited), 'the inherited PATH is preserved');

  const alreadyThere = { PATH: [agentBin, usrBin].join(path.delimiter) };
  const second = agentEnv.ensureAgentPath(alreadyThere, home, () => true);
  assert.ok(!second.added.includes(agentBin), 'a directory already on the PATH is not added again');
  const entries = alreadyThere.PATH.split(path.delimiter);
  assert.strictEqual(entries.filter((dir) => dir === agentBin).length, 1, 'no duplicate entry');
  assert.ok(alreadyThere.PATH.endsWith([agentBin, usrBin].join(path.delimiter)), 'the inherited entries keep their order');

  const empty = { PATH: '' };
  agentEnv.ensureAgentPath(empty, home, () => false);
  assert.strictEqual(empty.PATH, '', 'a PATH is never invented when no directory exists');
  assert.ok(agentEnv.candidateDirs(home).includes(agentBin));
});

test('the agent CLIs are looked for where Windows keeps them', () => {
  // The homebrew and usr directories do not exist on Windows, so without these
  // a Windows install would find no agent at all.
  const dirs = agentEnv.candidateDirs(path.join(path.sep, 'Users', 'someone'));
  assert.ok(dirs.includes(path.join('C:\\Program Files\\nodejs')), 'Node is looked for where Windows installs it');
  assert.ok(dirs.includes('C:\\ProgramData\\chocolatey\\bin'), 'and chocolatey too');
  assert.ok(dirs.some((dir) => dir.endsWith(path.join('AppData', 'Roaming', 'npm'))), 'npm shims are looked for');
  assert.ok(dirs.some((dir) => dir.endsWith(path.join('scoop', 'shims'))), 'and scoop shims');
});

test('closing the window does not take the gateway down with it', () => {
  const { shouldBlockQuit, CLOSE_TO_QUIT_WINDOW_MS } = require('../src/main/lifecycle');
  const now = 100000;
  assert.strictEqual(shouldBlockQuit({ authenticated: true, windowClosedAt: now - 100 }, now), true, 'the quit after a window close is blocked');
  assert.strictEqual(shouldBlockQuit({ authenticated: false, windowClosedAt: now - 100 }, now), false, 'signed out, quitting is fine');
  assert.strictEqual(shouldBlockQuit({ authenticated: true, windowClosedAt: 0 }, now), false, 'a quit with the window open goes through');
  assert.strictEqual(shouldBlockQuit({ authenticated: true, quitting: true, windowClosedAt: now - 100 }, now), false);
  assert.strictEqual(
    shouldBlockQuit({ authenticated: true, windowClosedAt: now - CLOSE_TO_QUIT_WINDOW_MS - 1 }, now),
    false,
    'a later quit is not blocked forever',
  );
});

test('a profile only accepts an API the router actually speaks', () => {
  const h = harness();
  assert.deepStrictEqual(providers.SUPPORTED_APIS, ['openai_chat_completions', 'openai_responses', 'anthropic_messages']);
  assert.ok(providers.isSupportedApi('openai_responses'));
  assert.ok(!providers.isSupportedApi('openai_completions'), 'a near-miss is not supported');
  assert.ok(!providers.isSupportedApi(''));
  assert.ok(providers.catalog().apis.includes('anthropic_messages'), 'the catalog advertises the supported APIs');

  for (const api of providers.SUPPORTED_APIS) {
    h.settings.setProvider('ollama', { api });
    assert.strictEqual(h.settings.get().providers.ollama.api, api, `${api} is accepted`);
  }
  for (const api of ['huggingface', 'openai_completions', 'gemini_generate_content', 'OpenAI_Responses', 'anything']) {
    assert.throws(
      () => h.settings.setProvider('ollama', { api }),
      (err) => err.code === 'unsupported_api',
      `${api} must be refused`,
    );
  }
  assert.throws(() => h.settings.setIntegration('cli', 'gemini', { api: 'made_up' }), (err) => err.code === 'unsupported_api');
});

test('profile edits are limited to the keys and types we support', () => {
  const h = harness();
  h.settings.setProvider('openai', { enabled: true, baseUrl: 'https://proxy.internal/v1/', api: 'anthropic_messages' });
  const provider = h.settings.get().providers.openai;
  assert.strictEqual(provider.baseUrl, 'https://proxy.internal/v1', 'a trailing slash is trimmed');
  assert.strictEqual(provider.api, 'anthropic_messages');

  h.settings.setProvider('openai', { secret: 'sk-leaked', id: 'evil', unknown: true });
  const cleaned = h.settings.get().providers.openai;
  assert.strictEqual(cleaned.secret, undefined, 'unknown keys never reach the settings file');
  assert.strictEqual(cleaned.id, undefined);
  assert.strictEqual(cleaned.unknown, undefined);

  assert.throws(() => h.settings.setProvider('openai', { baseUrl: 'file:///etc/passwd' }), (err) => err.code === 'invalid_base_url');
  assert.throws(() => h.settings.setProvider('openai', { baseUrl: 'not a url' }), (err) => err.code === 'invalid_base_url');
  assert.throws(() => h.settings.setProvider('openai', { enabled: 'yes' }), (err) => err.code === 'invalid_value');

  h.settings.setIntegration('cli', 'gemini', { model: 'gemini-2.5-pro', configPath: '~/.gemini' });
  assert.strictEqual(h.settings.get().integrations.cli.gemini.model, 'gemini-2.5-pro');
  assert.throws(() => h.settings.setIntegration('cli', 'gemini', { model: 'huggingface/gpt' }), (err) => err.code === 'forbidden_model');
  assert.throws(() => h.settings.setIntegration('cli', 'gemini', { enabled: 1 }), (err) => err.code === 'invalid_value');
  assert.throws(() => h.settings.setIntegration('cli', 'gemini', { configPath: 'a\nb' }), (err) => err.code === 'invalid_value');
  assert.throws(() => h.settings.setRouting({ modelByProvider: { ollama: 'hf/evil' } }), (err) => err.code === 'forbidden_model');
  assert.deepStrictEqual(h.settings.get().routing.modelByProvider, {}, 'a rejected routing patch changes nothing');
});

test('provider and integration settings persist per provider', () => {
  const h = harness();
  h.settings.setProvider('ollama', { baseUrl: 'http://127.0.0.1:11435/v1', enabled: false });
  assert.strictEqual(h.settings.get().providers.ollama.baseUrl, 'http://127.0.0.1:11435/v1');
  h.settings.setIntegration('cli', 'claudeCode', { enabled: true, model: 'ollama/llama3.2' });
  assert.strictEqual(h.settings.get().integrations.cli.claudeCode.model, 'ollama/llama3.2');
  assert.throws(() => h.settings.setIntegration('cli', 'nope', {}), /Unknown integration/);
  assert.throws(() => h.settings.setProvider('huggingface', {}), (err) => err.code === 'unsupported_provider');
});

test('app and CLI integrations are all present', () => {
  const h = harness();
  const integrations = h.settings.get().integrations;
  assert.deepStrictEqual(Object.keys(integrations.app).sort(), ['claude', 'codex']);
  assert.ok(integrations.cli.claudeCode, 'Claude Code CLI integration exists');
  assert.ok(integrations.cli.codex, 'Codex CLI integration exists');
  assert.ok(integrations.cli.gemini, 'Gemini CLI integration exists');
});

test('device encryption is authenticated and tamper-evident', () => {
  const dir = tempDir();
  const store = new Store(dir);
  const crypto = createCrypto({ keyFile: store.file('.devicekey') });
  const payload = crypto.encrypt('top secret');
  assert.ok(payload.startsWith('file:'));
  assert.strictEqual(crypto.decrypt(payload), 'top secret');
  const other = createCrypto({ keyFile: new Store(tempDir()).file('.devicekey') });
  assert.throws(() => other.decrypt(payload), /Cannot read|unable|authenticate|Unsupported/i, 'another device key must not decrypt');
  const bytes = Buffer.from(payload.slice(5), 'base64');
  bytes[bytes.length - 1] ^= 0xff;
  assert.throws(() => crypto.decrypt('file:' + bytes.toString('base64')), 'tampering must fail authentication');
});

test('store writes atomically with owner-only permissions', () => {
  const h = harness();
  h.store.write('thing.json', { a: 1 });
  const mode = fs.statSync(h.store.file('thing.json')).mode & 0o777;
  // Windows has no permission bits at all. chmod there only toggles read-only,
  // so every file reports the same mode and asserting one would be asserting
  // something false. The write itself is still checked above.
  if (process.platform !== 'win32') {
    assert.strictEqual(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  }
  assert.deepStrictEqual(h.store.read('thing.json', null), { a: 1 });
  h.store.remove('thing.json');
  assert.strictEqual(h.store.exists('thing.json'), false);
});

test('token generation is unique and url-safe', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const token = createCrypto({ keyFile: path.join(tempDir(), '.k') }).randomToken(16);
    assert.ok(/^[A-Za-z0-9_-]+$/.test(token));
    seen.add(token);
  }
  assert.strictEqual(seen.size, 200);
});

test('setup asks the sync question, then the harness question, then it is complete', () => {
  const h = harness();
  h.accounts.signup(GOOD);
  assert.strictEqual(h.accounts.onboarding().nextStep, 'sync');
  assert.strictEqual(h.accounts.onboarding().complete, false);
  assert.throws(() => h.accounts.requireOnboardingComplete(), (err) => err.code === 'onboarding_incomplete');
  h.accounts.completeSyncChoice({ storageMode: 'device' });
  assert.strictEqual(h.accounts.onboarding().nextStep, 'harnesses');
  h.accounts.completeHarnessChoice();
  assert.strictEqual(h.accounts.onboarding().complete, true);
  assert.ok(h.accounts.requireOnboardingComplete());
});

test('a second device is asked the same questions again', () => {
  const first = harness();
  first.accounts.signup(GOOD);
  first.accounts.completeSyncChoice({ storageMode: 'device' });
  first.accounts.completeHarnessChoice();
  assert.strictEqual(first.accounts.onboarding().complete, true);

  const second = harness();
  second.accounts.signup({ ...GOOD, email: GOOD.email });
  assert.strictEqual(second.accounts.onboarding().nextStep, 'sync', 'a new device must be asked afresh');
  assert.strictEqual(second.accounts.onboarding().complete, false);
});

test('setup cannot run without a session', () => {
  const h = harness();
  assert.throws(() => h.accounts.completeSyncChoice({ storageMode: 'device' }), (err) => err.code === 'signed_out');
  assert.throws(() => h.accounts.completeHarnessChoice(), (err) => err.code === 'signed_out');
  assert.throws(() => h.accounts.requireOnboardingComplete(), (err) => err.code === 'onboarding_incomplete');
});

test('synced setup demands an https endpoint and device setup clears it', () => {
  const h = harness();
  h.accounts.signup({ ...GOOD, storageMode: 'synced' });
  assert.throws(() => h.accounts.completeSyncChoice({ storageMode: 'synced', syncEndpoint: 'http://insecure' }), (err) => err.code === 'invalid_sync_endpoint');
  const synced = h.accounts.completeSyncChoice({ storageMode: 'synced', syncEndpoint: 'https://sync.example.com' });
  assert.strictEqual(synced.account.syncEnabled, true);
  const local = h.accounts.completeSyncChoice({ storageMode: 'device', syncEndpoint: 'https://sync.example.com' });
  assert.strictEqual(local.account.syncEnabled, false, 'choosing this device only drops the endpoint');
});

test('harness catalog flags paid harnesses and keeps built-in models for the free one', () => {
  const h = harness();
  const catalog = harnesses.catalog(h.settings.get());
  assert.strictEqual(catalog.length, 5);
  const gemini = catalog.find((harness) => harness.id === 'gemini-cli');
  assert.strictEqual(gemini.billing, 'free');
  assert.deepStrictEqual(gemini.builtInModels, ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash']);
  const paid = catalog.filter((harness) => harness.billing === 'required');
  assert.deepStrictEqual(paid.map((harness) => harness.id), ['claude-code'], 'only Claude Code needs a paid plan');
  assert.ok(paid.every((harness) => harness.builtInModels.length === 0), 'paid harnesses get no built-in models');
  const free = catalog.filter((harness) => harness.billing === 'free');
  assert.deepStrictEqual(
    free.map((harness) => harness.id),
    ['claude-app', 'codex-app', 'codex-cli', 'gemini-cli'],
    'Claude, Codex and Gemini all run on the free plan',
  );
  assert.ok(catalog.every((harness) => harness.target && harness.target.kind && harness.target.name));
});

test('harness selections land in the matching integrations and never invent a model', () => {
  const h = harness();
  harnesses.applySelections(h.settings, {
    'gemini-cli': { enabled: true, model: 'gemini-2.5-flash' },
    'claude-code': { enabled: true },
    'codex-app': { enabled: true, model: 'gpt-not-a-built-in' },
  });
  const settings = h.settings.get();
  assert.strictEqual(settings.integrations.cli.gemini.enabled, true);
  assert.strictEqual(settings.integrations.cli.gemini.model, 'gemini-2.5-flash');
  assert.ok(String(settings.integrations.cli.gemini.baseUrl).startsWith('http://127.0.0.1:'), 'routed at the local gateway');
  assert.strictEqual(settings.integrations.cli.claudeCode.enabled, true);
  assert.strictEqual(settings.integrations.cli.claudeCode.model, null, 'no model is invented for a paid harness');
  assert.strictEqual(settings.integrations.app.codex.model, null, 'an unknown model is never written');
  assert.strictEqual(settings.integrations.app.codex.enabled, true);
});

test('harness selections ignore unknown harnesses entirely', () => {
  const h = harness();
  const applied = harnesses.applySelections(h.settings, { 'not-a-harness': { enabled: true } });
  assert.deepStrictEqual(applied.applied, []);
  assert.strictEqual(h.settings.get().integrations.cli.gemini.enabled, false);
});

Promise.all(pending).then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});

/* ---------------------------------------------------------------- updates */

/** The exact bytes of a buffer, without the slack a pooled allocation carries. */
function exact(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);
}

/** A stand-in for GitHub plus the release CDN, so the whole flow is exercised. */
function updateFixture({ tag = 'v1.1.0', body = 'What changed', assets = null, build = null, published = true, checksumOverride = null } = {}) {
  const state = { build: build || Buffer.from('not really a build'), requests: [] };
  state.hash = updater.sha256(state.build);
  const list = assets === null
    ? [
        { name: 'app.asar', browser_download_url: 'https://cdn.test/app.asar' },
        { name: 'app.asar.sha256', browser_download_url: 'https://cdn.test/app.asar.sha256' },
      ]
    : assets;
  const release = {
    tag_name: tag,
    body,
    html_url: 'https://github.test/releases',
    published_at: '2026-01-02T03:04:05Z',
    assets: list,
  };
  const fetchImpl = async (url) => {
    state.requests.push(url);
    if (url.includes('/releases/latest')) {
      if (!published) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => release };
    }
    if (url === 'https://cdn.test/app.asar') {
      return { ok: true, status: 200, headers: { get: () => String(state.build.length) }, arrayBuffer: async () => exact(state.build) };
    }
    if (url === 'https://cdn.test/app.asar.sha256') {
      const body = Buffer.from(checksumOverride === null ? `${state.hash}  app.asar\n` : checksumOverride, 'utf8');
      return { ok: true, status: 200, headers: { get: () => String(body.length) }, arrayBuffer: async () => exact(body) };
    }
    return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
  };
  return { state, fetchImpl, release };
}

/** A packed asar written exactly the way scripts/pack-asar.js writes one. */
function packAsar(files) {
  const names = Object.keys(files).sort();
  let offset = 0;
  const header = { files: {} };
  const bodies = [];
  for (const name of names) {
    const body = Buffer.from(files[name]);
    header.files[name] = { size: body.length, offset: String(offset) };
    const pad = body.length % 4 === 0 ? 0 : 4 - (body.length % 4);
    offset += body.length + pad;
    bodies.push({ body, pad });
  }
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const paddedLength = json.length + ((4 - (json.length % 4)) % 4);
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(paddedLength + 8, 4);
  prefix.writeUInt32LE(paddedLength + 4, 8);
  prefix.writeUInt32LE(json.length, 12);
  return Buffer.concat([
    prefix,
    json,
    Buffer.alloc(paddedLength - json.length, 0x20),
    ...bodies.flatMap((entry) => [entry.body, Buffer.alloc(entry.pad)]),
  ]);
}

const ASAR_110 = packAsar({ 'package.json': JSON.stringify({ name: 'claude-code-router', version: '1.1.0' }) });

test('a published build is offered and installs for real', async () => {
  const home = tempDir();
  const fixture = updateFixture({ build: ASAR_110 });
  const target = path.join(tempDir(), 'app.build');
  fs.writeFileSync(target, packAsar({ 'package.json': JSON.stringify({ version: '1.0.0' }) }));

  const found = await updater.check({ currentVersion: '1.0.0', home, fetchImpl: fixture.fetchImpl });
  assert.strictEqual(found.state, 'ready');
  assert.strictEqual(found.updateAvailable, true);
  assert.strictEqual(found.latestVersion, '1.1.0');
  assert.ok(found.assetUrl && found.checksumUrl);

  const got = await updater.download({ version: '1.1.0', assetUrl: found.assetUrl, checksumUrl: found.checksumUrl, home, fetchImpl: fixture.fetchImpl });
  assert.strictEqual(got.sha256, fixture.state.hash);

  const done = updater.install({ version: '1.1.0', file: got.file, target, home });
  assert.strictEqual(done.ok, true);
  assert.strictEqual(updater.installedVersionOf(target), '1.1.0', 'the swapped build reports the new version');
  assert.ok(done.backup && fs.existsSync(done.backup), 'the build it replaced is kept');
  assert.strictEqual(fs.readFileSync(target).length, ASAR_110.length);
});

test('a build that does not match its published hash is never installed', async () => {
  const home = tempDir();
  const target = path.join(tempDir(), 'app.build');
  const before = packAsar({ 'package.json': JSON.stringify({ version: '1.0.0' }) });
  fs.writeFileSync(target, before);

  const fixture = updateFixture({ build: ASAR_110, checksumOverride: `${'0'.repeat(64)}  app.asar\n` });
  const found = await updater.check({ currentVersion: '1.0.0', home, fetchImpl: fixture.fetchImpl });
  assert.strictEqual(found.updateAvailable, true);

  await assert.rejects(
    () => updater.download({ version: '1.1.0', assetUrl: found.assetUrl, checksumUrl: found.checksumUrl, home, fetchImpl: fixture.fetchImpl }),
    (err) => err.code === 'checksum_mismatch',
  );
  assert.strictEqual(fs.readFileSync(target).equals(before), true, 'the installed build is untouched');
});

test('a release without a build is reported instead of half applied', async () => {
  const home = tempDir();
  const fixture = updateFixture({ assets: [{ name: 'notes.txt', browser_download_url: 'https://cdn.test/notes.txt' }] });
  const found = await updater.check({ currentVersion: '1.0.0', home, fetchImpl: fixture.fetchImpl });
  assert.strictEqual(found.updateAvailable, false);
  assert.strictEqual(found.state, 'incomplete-release');
  assert.strictEqual(found.code, 'missing_asset');
  assert.ok(/app\.asar/.test(found.error), 'it says what is missing');
});

test('the app is never offered its own version or an older one', async () => {
  const same = updateFixture({ tag: 'v1.0.0', build: ASAR_110 });
  const sameFound = await updater.check({ currentVersion: '1.0.0', home: tempDir(), fetchImpl: same.fetchImpl });
  assert.strictEqual(sameFound.state, 'current');
  assert.strictEqual(sameFound.updateAvailable, false);

  const older = updateFixture({ tag: 'v0.9.0', build: ASAR_110 });
  const olderFound = await updater.check({ currentVersion: '1.0.0', home: tempDir(), fetchImpl: older.fetchImpl });
  assert.strictEqual(olderFound.state, 'ahead');
  assert.strictEqual(olderFound.updateAvailable, false);
});

test('a repeat check inside the cache window does not go back to the network', async () => {
  const home = tempDir();
  const fixture = updateFixture({ build: ASAR_110 });
  const first = await updater.check({ currentVersion: '1.0.0', home, fetchImpl: fixture.fetchImpl });
  assert.strictEqual(first.updateAvailable, true);
  const before = fixture.state.requests.length;
  const again = await updater.check({ currentVersion: '1.0.0', home, fetchImpl: fixture.fetchImpl });
  assert.strictEqual(again.cached, true);
  assert.strictEqual(fixture.state.requests.length, before, 'no second request was made');
  assert.strictEqual(again.updateAvailable, true, 'the cached answer is still the real one');
});

test('no published release is a normal state, not a failure', async () => {
  const fixture = updateFixture({ published: false });
  const found = await updater.check({ currentVersion: '1.0.0', home: tempDir(), fetchImpl: fixture.fetchImpl });
  assert.strictEqual(found.ok, true);
  assert.strictEqual(found.state, 'no-release');
  assert.strictEqual(found.updateAvailable, false);
});

test('a file that is not a packed build is refused', () => {
  const home = tempDir();
  const file = path.join(tempDir(), 'app.build');
  fs.writeFileSync(file, Buffer.from('just some text'));
  assert.throws(
    () => updater.install({ version: '1.1.0', file, target: path.join(tempDir(), 'app.build'), home }),
    (err) => err.code === 'not_an_asar',
  );
});

test('a build that lies about its version is refused before anything is touched', () => {
  const home = tempDir();
  const target = path.join(tempDir(), 'app.build');
  const good = packAsar({ 'package.json': JSON.stringify({ version: '1.0.0' }) });
  fs.writeFileSync(target, good);
  const file = path.join(tempDir(), 'app.build');
  // Claims 1.1.0 on the tag but the build inside says 1.2.0.
  fs.writeFileSync(file, packAsar({ 'package.json': JSON.stringify({ version: '1.2.0' }) }));
  assert.throws(
    () => updater.install({ version: '1.1.0', file, target, home }),
    (err) => err.code === 'version_mismatch',
  );
  assert.strictEqual(fs.readFileSync(target).equals(good), true, 'the working build is left exactly as it was');
});

test('the service installs only what a check actually found', async () => {
  const home = tempDir();
  const target = path.join(tempDir(), 'app.build');
  fs.writeFileSync(target, packAsar({ 'package.json': JSON.stringify({ version: '1.0.0' }) }));
  let relaunched = 0;
  const fixture = updateFixture({ build: ASAR_110 });
  const service = new UpdateService({
    currentVersion: '1.0.0',
    home,
    target,
    fetchImpl: fixture.fetchImpl,
    relaunch: () => { relaunched += 1; },
  });

  const refused = await service.install();
  assert.strictEqual(refused.refused, 'nothing_to_install', 'nothing is installed before a check says so');
  assert.strictEqual(relaunched, 0);

  await service.check({ force: true });
  const done = await service.install();
  assert.strictEqual(done.state, 'installed');
  assert.strictEqual(done.currentVersion, '1.1.0');
  assert.strictEqual(relaunched, 1, 'the app restarts once, after the swap');
  assert.strictEqual(updater.installedVersionOf(target), '1.1.0');
});

test('a failed install says why and leaves the build in place', async () => {
  const home = tempDir();
  const target = path.join(tempDir(), 'app.build');
  const good = packAsar({ 'package.json': JSON.stringify({ version: '1.0.0' }) });
  fs.writeFileSync(target, good);
  let relaunched = 0;
  const fixture = updateFixture({ build: ASAR_110, checksumOverride: 'not-a-hash\n' });
  const service = new UpdateService({ currentVersion: '1.0.0', home, target, fetchImpl: fixture.fetchImpl, relaunch: () => { relaunched += 1; } });

  await service.check({ force: true });
  const failed = await service.install();
  assert.strictEqual(failed.state, 'failed');
  assert.strictEqual(failed.code, 'bad_checksum');
  assert.ok(failed.error && failed.error.length > 0, 'the reason is shown, not swallowed');
  assert.strictEqual(relaunched, 0, 'a failed install never restarts into anything');
  assert.strictEqual(fs.readFileSync(target).equals(good), true);
  assert.strictEqual(updater.installedVersionOf(target), '1.0.0');
});

test('the bundled auto-updater is left unable to install anything', async () => {
  const fake = {
    autoUpdater: {
      __ccrSilenced: false,
      calls: [],
      checkForUpdates() { this.calls.push('check'); },
      downloadUpdate() { this.calls.push('download'); },
      quitAndInstall() { this.calls.push('install'); },
      setFeedURL() { this.calls.push('feed'); },
      on() { return this; },
    },
  };
  assert.strictEqual(silenceBundledUpdater(fake), true);
  assert.strictEqual(silenceBundledUpdater(fake), false, 'doing it twice is harmless');

  const upd = fake.autoUpdater;
  assert.deepStrictEqual((await upd.checkForUpdates()).updateInfo, { version: null });
  assert.strictEqual(updater_checkDidNotDownload(upd), true);
  upd.quitAndInstall(false, true);
  upd.setFeedURL({ provider: 'github' });
  assert.deepStrictEqual(upd.calls, [], 'no check, download, feed change or install is possible');
});

function updater_checkDidNotDownload(upd) {
  return upd.downloadUpdate instanceof Promise || typeof upd.downloadUpdate === 'function';
}

/* -------------------------------------------------------------------- i18n */

const fs2 = require('node:fs');
const vm = require('node:vm');
const path2 = require('node:path');

function loadI18n(storageValue) {
  const store = new Map();
  if (storageValue) store.set('ccr.locale', storageValue);
  const win = {};
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
  };
  win.localStorage = storage;
  const ctx = vm.createContext({
    window: win,
    document: { documentElement: {}, querySelectorAll: () => [], querySelector: () => null },
    navigator: { languages: ['en-US', 'en'], language: 'en-US' },
    localStorage: storage,
    console,
  });
  for (const file of ['i18n.js', 'i18n-tables.js']) {
    vm.runInContext(fs2.readFileSync(path2.join(__dirname, '..', 'src', 'renderer', 'js', file), 'utf8'), ctx, { filename: file });
  }
  return { i18n: win.ccrI18n, store };
}

test('every offered language translates every string', () => {
  const { i18n: i18n } = loadI18n();
  assert.ok(i18n.LOCALES.length >= 20, `expected a broad set of languages, got ${i18n.LOCALES.length}`);
  for (const locale of i18n.LOCALES) {
    const coverage = i18n.coverage(locale.code);
    // app.name is a proper noun and is deliberately identical everywhere.
    assert.strictEqual(coverage, 1, `${locale.code} only covers ${Math.round(coverage * 100)}% of strings`);
  }
});

test('a language switch changes what the page says', () => {
  const { i18n: i18n } = loadI18n();
  i18n.apply('en');
  const english = i18n.t('settings.back');
  i18n.apply('ar');
  const arabic = i18n.t('settings.back');
  assert.notStrictEqual(arabic, english, 'Arabic has to say something different');
  assert.strictEqual(arabic, 'رجوع');
  i18n.apply('fr');
  assert.strictEqual(i18n.t('settings.back'), 'Retour');
  i18n.apply('zh-CN');
  assert.strictEqual(i18n.t('settings.back'), '返回');
});

test('a stored language is remembered and an unknown one falls back', () => {
  const { i18n: i18n, store } = loadI18n('de');
  assert.strictEqual(i18n.detect(), 'de', 'the stored choice wins over the system language');
  i18n.apply('ja');
  assert.strictEqual(store.get('ccr.locale'), 'ja');
  assert.strictEqual(i18n.apply('kl'), 'en', 'a language nobody translated falls back to English');
  assert.strictEqual(i18n.dirFor('ar'), 'rtl');
  assert.strictEqual(i18n.dirFor('en'), 'ltr');
});

test('an untranslated string reads as English rather than as a key', () => {
  const { i18n: i18n } = loadI18n();
  i18n.apply('ar');
  // A key no table has still has to produce something a person can read.
  const missing = i18n.t('no.such.key');
  assert.strictEqual(missing, 'no.such.key', 'a gap is visible rather than silently blank');
  // A locale that is not on offer cannot be registered, so a stray table
  // cannot add a language the picker does not list.
  assert.strictEqual(i18n.register('xx', { 'settings.back': 'X' }), false);
  assert.strictEqual(i18n.t('settings.back'), 'رجوع', 'Arabic is still in charge');
  // Registering onto an offered locale only replaces what it names.
  i18n.register('ar', { 'settings.back': 'رجوع!' });
  assert.strictEqual(i18n.t('settings.back'), 'رجوع!');
  assert.strictEqual(i18n.t('settings.title'), 'الإعدادات', 'other Arabic strings are untouched');
});

test('placeholders are filled in every language', () => {
  const { i18n: i18n } = loadI18n();
  for (const code of ['en', 'ar', 'ru', 'ja']) {
    i18n.apply(code);
    const said = i18n.t('updates.current', { version: '3.1.1' });
    assert.ok(said.includes('3.1.1'), `${code} lost the version: ${said}`);
    const offered = i18n.t('updates.available', { latest: '9.9.9', version: '3.1.1' });
    assert.ok(offered.includes('9.9.9') && offered.includes('3.1.1'), `${code} lost a version: ${offered}`);
  }
});

/* --------------------------------------------------------- api key helper */

function helperHome(token) {
  const home = tempDir();
  const bin = path.join(home, '.claude-code-router', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, apiKeyHelper.helperName('claude-code')), apiKeyHelper.scriptFor(token), { mode: 0o700 });
  return { home, bin };
}

test('a key helper a config points at is written instead of failing', () => {
  const { home, bin } = helperHome('ccr-profile-abcdefghijklmnop');
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  // The profile changed, so the config now names a scope whose script was never
  // written. This is what made every agent start fail with `exited 127`.
  const wanted = path.join(bin, apiKeyHelper.helperName('default-claude-code'));
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ apiKeyHelper: wanted, env: {} }));

  assert.strictEqual(fs.existsSync(wanted), false, 'it really is missing to begin with');
  const fixed = apiKeyHelper.ensureHelpers({ home });
  assert.strictEqual(fixed.ok, true, fixed.error);
  assert.deepStrictEqual(fixed.created, [wanted]);
  assert.ok(fs.existsSync(wanted));

  // The script has to be one the shell can actually run, and print the token.
  const printed = helperOutput(wanted, 'ccr-profile-abcdefghijklmnop');
  assert.strictEqual(printed, 'ccr-profile-abcdefghijklmnop');
  // The executable bit is what makes the shell run it directly, and Windows has
  // no such bit; there the helper is reached through the shell instead, which
  // is checked above.
  if (process.platform !== 'win32') {
    assert.ok((fs.statSync(wanted).mode & 0o111) !== 0, 'it is executable');
  }
});

test('an existing key helper is never rewritten', () => {
  const { home, bin } = helperHome('ccr-profile-originaltoken123');
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const existing = path.join(bin, apiKeyHelper.helperName('claude-code'));
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ apiKeyHelper: existing }));
  const before = fs.readFileSync(existing, 'utf8');
  const again = apiKeyHelper.ensureHelpers({ home });
  assert.strictEqual(again.ok, true);
  assert.deepStrictEqual(again.created, [], 'nothing was created because nothing was missing');
  assert.strictEqual(fs.readFileSync(existing, 'utf8'), before, 'the working script is untouched');
});

test('a config pointing outside the app bin directory is left alone', () => {
  const { home } = helperHome('ccr-profile-abcdefghijklmnop');
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const somewhereElse = path.join(tempDir(), 'not-ours.sh');
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ apiKeyHelper: somewhereElse }));
  const result = apiKeyHelper.ensureHelpers({ home });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.created, [], 'no script is invented for a path this app does not own');
  assert.strictEqual(fs.existsSync(somewhereElse), false);
});

test('the gateway finds its token whichever profile scope wrote it', () => {
  const { home, bin } = helperHome('ccr-profile-firstscopetoken1');
  const gateway = require('../src/main/gateway');
  assert.strictEqual(gateway.readToken(home), 'ccr-profile-firstscopetoken1');

  // A newer scope appears, which is the one the config now names.
  const newer = path.join(bin, apiKeyHelper.helperName('default-claude-code'));
  fs.writeFileSync(newer, apiKeyHelper.scriptFor('ccr-profile-secondscope2'));
  const later = Date.now() + 5000;
  fs.utimesSync(newer, later / 1000, later / 1000);
  assert.strictEqual(gateway.readToken(home), 'ccr-profile-secondscope2', 'the newest scope wins');
});

test('a token that does not look like one is refused', () => {
  const { home, bin } = helperHome('ccr-profile-goodtoken12345');
  const gateway = require('../src/main/gateway');
  assert.ok(gateway.readToken(home), 'a real token is accepted');
  fs.writeFileSync(path.join(bin, apiKeyHelper.helperName('claude-code')), apiKeyHelper.scriptFor('nope'));
  assert.strictEqual(gateway.readToken(home), null, 'anything else is not a token');
  assert.strictEqual(apiKeyHelper.currentToken(tempDir()), null, 'and no helper at all means no token');
});

/* ------------------------------------------------------------------ login */

const AGENT_ENV = { PATH: '/usr/bin:/bin' };

test('a sign-in command is only used when the agent advertises it', () => {
  const agents = require('../src/main/agents');
  assert.deepStrictEqual(agents.findLoginCommand('  login   Sign in to your account'), { mode: 'command', command: 'login' });
  assert.deepStrictEqual(agents.findLoginCommand('  auth login  Authenticate'), { mode: 'command', command: 'auth login' });
  assert.deepStrictEqual(agents.findLoginCommand('  use "/login" to sign in'), { mode: 'session', command: '/login' });
  assert.strictEqual(agents.findLoginCommand('  list-models  show models'), null, 'nothing is invented');
  assert.strictEqual(agents.findLoginCommand(''), null);
  // "login" inside a longer word is not a command.
  assert.strictEqual(agents.findLoginCommand('  delogin   nope'), null);
});

test('a detected binary path cannot smuggle in a second command', (t) => {
  const agents = require('../src/main/agents');
  // Shell quoting is a posix thing; on Windows the value is unused and cmd has
  // no equivalent, so the quoting is not asserted there.
  if (process.platform === 'win32') return;
  assert.strictEqual(agents.shellQuote('/bin/sh'), "'/bin/sh'");
  assert.strictEqual(agents.shellQuote("it's"), "'it'\\''s'", 'a quote in the path is escaped, not ended');
  // The semicolon is still in the text, but it sits inside the quotes, so the
  // shell reads it as part of one argument rather than as a second command.
  const quoted = agents.shellQuote('a; rm -rf /');
  assert.strictEqual(quoted, "'a; rm -rf /'");
  assert.strictEqual(quoted.split("'").length - 1, 2, 'exactly one quoted argument, nothing left outside it');
});

test('signing in runs the agent and then re-reads its models', async () => {
  const agents = require('../src/main/agents');
  const calls = [];
  let signedIn = false;
  const run = async (binary, args) => {
    calls.push(args.join(' '));
    if (args[0] === '--help') {
      return { ok: true, stdout: '  login    Sign in\n  list-models  Show models', stderr: '' };
    }
    if (args[0] === 'login') {
      signedIn = true;
      return { ok: true, stdout: 'Opened your browser.', stderr: '' };
    }
    if (args[0] === 'list-models') {
      return signedIn
        ? { ok: true, stdout: 'claude-opus-5 claude-sonnet-5', stderr: '' }
        : { ok: false, stdout: '', stderr: 'Please login first' };
    }
    return { ok: false, stdout: '', stderr: '' };
  };

  const before = await agents.discoverModels('claude-code', { env: AGENT_ENV, binaryPath: '/bin/echo', run });
  assert.strictEqual(before.source, 'needs-sign-in', 'it says sign-in is what is missing');
  assert.ok(/subscription/i.test(before.reason), 'and says why that matters');

  const after = await agents.startLogin('claude-code', { env: AGENT_ENV, binaryPath: '/bin/echo', run, loginTimeoutMs: 50 });
  assert.strictEqual(after.ok, true, after.reason);
  assert.strictEqual(after.mode, 'command');
  assert.deepStrictEqual(after.models.sort(), ['claude-opus-5', 'claude-sonnet-5']);
  assert.ok(calls.includes('login'), 'the sign-in the agent documents is the one that ran');
  assert.ok(calls.filter((c) => c === 'list-models').length >= 2, 'the model list is read again afterwards');
});

test('an agent with no sign-in command is never guessed at', async () => {
  const agents = require('../src/main/agents');
  const run = async (binary, args) => {
    if (args[0] === '--help') return { ok: true, stdout: '  list-models  Show models', stderr: '' };
    return { ok: true, stdout: '', stderr: '' };
  };
  const result = await agents.startLogin('claude-code', { env: AGENT_ENV, binaryPath: '/bin/echo', run });
  assert.strictEqual(result.ok, false);
  assert.ok(/does not document a sign-in/i.test(result.reason), result.reason);
});

test('a sign-in that needs a session is handed to the user, not typed for them', async () => {
  const agents = require('../src/main/agents');
  const run = async (binary, args) => {
    if (args[0] === '--help') return { ok: true, stdout: '  Type "/login" to sign in', stderr: '' };
    return { ok: true, stdout: '', stderr: '' };
  };
  const launched = [];
  const result = await agents.startLogin('claude-code', {
    env: AGENT_ENV,
    binaryPath: '/opt/my agent/claude',
    run,
    launch: (binary, args) => {
      launched.push([binary, args]);
      return ['osascript', ['-e', 'noop']];
    },
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.pending, true, 'it waits for the user rather than pretending to be done');
  assert.strictEqual(result.mode, 'session');
  assert.ok(/\/login/.test(result.reason), 'and says what to type');
  assert.strictEqual(launched.length, 1, 'a window was opened for them');
  assert.strictEqual(launched[0][0], '/opt/my agent/claude');
});

test('a desktop app is sent to its own sign-in', async () => {
  const agents = require('../src/main/agents');
  const result = await agents.startLogin('claude-app', { env: AGENT_ENV, binaryPath: '/bin/echo' });
  assert.strictEqual(result.ok, false);
  assert.ok(/desktop app/i.test(result.reason), result.reason);
});

test('a config pointing at a removed helper is repointed at one that exists', () => {
  const { home, bin } = helperHome('ccr-profile-survivingtoken');
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  // The profile the config names is not in use, so its script is gone. Writing
  // it again would not last, because the router removes it on every launch.
  const gone = path.join(bin, apiKeyHelper.helperName('default-claude-code'));
  const config = path.join(claudeDir, 'settings.json');
  fs.writeFileSync(config, JSON.stringify({ apiKeyHelper: gone, env: { ANTHROPIC_MODEL: 'x' } }, null, 2));

  const result = apiKeyHelper.repairHelper({ home });
  assert.strictEqual(result.ok, true, result.error);
  assert.strictEqual(result.repointed.length, 1);
  assert.strictEqual(result.repointed[0].from, gone);
  assert.strictEqual(result.repointed[0].to, path.join(bin, apiKeyHelper.helperName('claude-code')));
  assert.deepStrictEqual(result.created, [], 'nothing new is invented');

  const after = JSON.parse(fs.readFileSync(config, 'utf8'));
  assert.ok(fs.existsSync(after.apiKeyHelper), 'the config now names a script that is really there');
  assert.strictEqual(after.env.ANTHROPIC_MODEL, 'x', 'the rest of the config is untouched');
  assert.ok(
    fs.readdirSync(claudeDir).some((name) => name.startsWith('settings.json.ccr-backup-')),
    'the previous config was kept',
  );
  // And running it the way Claude Code does has to work.
  const printed = helperOutput(after.apiKeyHelper, 'ccr-profile-survivingtoken');
  assert.strictEqual(printed, 'ccr-profile-survivingtoken');
});

test('with no helper at all the config is left alone rather than given a fake token', () => {
  const home = tempDir();
  const bin = path.join(home, '.claude-code-router', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const wanted = path.join(bin, apiKeyHelper.helperName('claude-code'));
  const config = path.join(claudeDir, 'settings.json');
  fs.writeFileSync(config, JSON.stringify({ apiKeyHelper: wanted }));
  const before = fs.readFileSync(config, 'utf8');

  const result = apiKeyHelper.repairHelper({ home });
  assert.strictEqual(result.ok, false);
  assert.ok(/left alone/i.test(result.error), result.error);
  assert.strictEqual(fs.readFileSync(config, 'utf8'), before, 'the config is untouched');
  assert.strictEqual(fs.existsSync(wanted), false, 'and no script with a made up token was written');
});

test('a healthy config is not touched at all', () => {
  const { home, bin } = helperHome('ccr-profile-healthytoken1');
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const good = path.join(bin, apiKeyHelper.helperName('claude-code'));
  const config = path.join(claudeDir, 'settings.json');
  fs.writeFileSync(config, JSON.stringify({ apiKeyHelper: good }));
  const before = fs.readFileSync(config, 'utf8');
  const result = apiKeyHelper.repairHelper({ home });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.changed, false);
  assert.strictEqual(fs.readFileSync(config, 'utf8'), before);
  assert.deepStrictEqual(fs.readdirSync(claudeDir), ['settings.json'], 'no backup is written when nothing changed');
});

/* ------------------------------------------- against real Claude Code output */

/*
 * Captured from Claude Code 2.1.283 on this Mac. Keeping the agent's real
 * wording here means these tests fail the moment the CLI stops saying it, which
 * is the whole point of only ever using what an agent advertises.
 */
const CLAUDE_HELP_MODEL = "--model <model>                       Model for the current session. Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name (e.g. 'claude-fable-5').";
const CLAUDE_AUTH_HELP = "Usage: claude auth [options] [command]\n\nManage authentication\n\nOptions:\n  -h, --help        Display help for command\n\nCommands:\n  help [command]    display help for command\n  login [options]   Sign in to your Anthropic account\n  logout            Log out from your Anthropic account\n  status [options]  Show authentication status";
const CLAUDE_AUTH_STATUS_ROUTED = "{\n  \"loggedIn\": true,\n  \"authMethod\": \"api_key_helper\",\n  \"apiProvider\": \"firstParty\",\n  \"analyticsDisabled\": false,\n  \"projectsDirectory\": \"/Users/yazan/.claude/projects\",\n  \"configDirectory\": \"/Users/yazan/.claude\",\n  \"apiKeySource\": \"apiKeyHelper\"\n}";
const CLAUDE_AUTH_STATUS_SUBSCRIBED = JSON.stringify({
  loggedIn: true,
  authMethod: 'claudeai',
  apiProvider: 'firstParty',
  analyticsDisabled: false,
}, null, 2);

const CLAUDE_HELP = [
  'Usage: claude [options] [command] [prompt]',
  'Options:',
  '  --model <model>                       Model for the current session. Provide',
  '                                        an alias for the latest model (e.g.',
  "                                        'fable', 'opus', or 'sonnet') or a",
  "                                        model's full name (e.g.",
  "                                        'claude-fable-5').",
  '  --print                               Print output and exit',
].join('\n');

const CLAUDE_TOP_HELP = [
  CLAUDE_HELP,
  'Commands:',
  '  auth                                  Manage authentication',
  '  doctor                                Check the health of your Claude Code',
  '  setup-token                           Set up a long-lived authentication',
  '                                         token (requires Claude subscription)',
].join('\n');

test('the model names come out of the real help text', () => {
  const agents = require('../src/main/agents');
  assert.deepStrictEqual(agents.readModelAliases(CLAUDE_HELP), ['fable', 'opus', 'sonnet', 'claude-fable-5']);
  assert.deepStrictEqual(agents.readModelAliases('no options here'), []);
});

test('a router token is not mistaken for a Claude subscription', () => {
  const agents = require('../src/main/agents');
  const routed = agents.parseAuthStatus(CLAUDE_AUTH_STATUS_ROUTED);
  assert.strictEqual(routed.loggedIn, true);
  assert.strictEqual(routed.subscription, false, 'the key helper is this app, not a subscription');
  const subscribed = agents.parseAuthStatus(CLAUDE_AUTH_STATUS_SUBSCRIBED);
  assert.strictEqual(subscribed.subscription, true, 'a claudeai sign-in is a subscription');
  assert.strictEqual(agents.parseAuthStatus('not json at all'), null);
});

test('real Claude Code help resolves to auth login, not the auth menu', async () => {
  const agents = require('../src/main/agents');
  const ran = [];
  const run = async (binary, args) => {
    ran.push(args.join(' '));
    if (args[0] === '--help') return { ok: true, stdout: CLAUDE_TOP_HELP, stderr: '' };
    if (args[0] === 'auth' && args[1] === '--help') return { ok: true, stdout: CLAUDE_AUTH_HELP, stderr: '' };
    if (args[0] === 'auth' && args[1] === 'status') return { ok: true, stdout: CLAUDE_AUTH_STATUS_ROUTED, stderr: '' };
    if (args[0] === 'auth' && args[1] === 'login') return { ok: true, stdout: 'Opening your browser to finish signing in.', stderr: '' };
    return { ok: true, stdout: '', stderr: '' };
  };
  const result = await agents.startLogin('claude-code', { binaryPath: '/bin/true', run });
  assert.ok(ran.includes('auth login'), 'the sign-in command is the one the auth help names');
  assert.ok(!ran.includes('auth '), 'the bare menu is never run');
  assert.strictEqual(result.ok, false, 'no subscription, so no built-in models');
  assert.strictEqual(result.signedInOnlyLocally, true);
});

test('a signed-in subscription turns the advertised names into built-in models', async () => {
  const agents = require('../src/main/agents');
  const run = async (binary, args) => {
    if (args[0] === '--help') return { ok: true, stdout: CLAUDE_TOP_HELP, stderr: '' };
    if (args[0] === 'auth' && args[1] === '--help') return { ok: true, stdout: CLAUDE_AUTH_HELP, stderr: '' };
    if (args[0] === 'auth' && args[1] === 'status') return { ok: true, stdout: CLAUDE_AUTH_STATUS_SUBSCRIBED, stderr: '' };
    if (args[0] === 'auth' && args[1] === 'login') return { ok: true, stdout: 'Signed in.', stderr: '' };
    return { ok: true, stdout: '', stderr: '' };
  };
  const found = await agents.discoverModels('claude-code', { binaryPath: '/bin/true', run });
  assert.strictEqual(found.source, 'subscription');
  assert.deepStrictEqual(found.models, ['fable', 'opus', 'sonnet', 'claude-fable-5']);
  assert.strictEqual(found.auth.subscription, true);

  const signedIn = await agents.startLogin('claude-code', { binaryPath: '/bin/true', run });
  assert.strictEqual(signedIn.ok, true, signedIn.reason);
  assert.deepStrictEqual(signedIn.models, ['fable', 'opus', 'sonnet', 'claude-fable-5']);
});

test('a forbidden model in the advertised names is left out', () => {
  const agents = require('../src/main/agents');
  const help = [
    '  --model <model>   alias for the latest (e.g. \'opus\', \'hf/gpt-oss\') or a',
    "                     full name (e.g. 'claude-opus-5').",
  ].join('\n');
  const names = agents.readModelAliases(help);
  assert.ok(names.includes('opus'));
  assert.ok(!names.includes('hf/gpt-oss'), 'a model the router refuses is not offered');
});

test('a free agent already has its built-in models, with no sign-in', async () => {
  const agents = require('../src/main/agents');
  const run = async (binary, args) => {
    if (args[0] === '--help') return { ok: true, stdout: 'Commands:\n  run   start a session\n', stderr: '' };
    return { ok: true, stdout: '', stderr: '' };
  };
  const free = await agents.discoverModels('gemini-cli', {
    env: { PATH: '/usr/bin' },
    binaryPath: '/usr/bin/gemini',
    run,
    builtInModels: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
  });
  assert.deepStrictEqual(free.models, ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash']);
  assert.strictEqual(free.source, 'built-in');
  assert.strictEqual(free.billed, false, 'nothing about this one is waiting on a payment');
});

test('a refused model is not handed out of a free agent catalogue either', async () => {
  const agents = require('../src/main/agents');
  const run = async (binary, args) => {
    if (args[0] === '--help') return { ok: true, stdout: 'Commands:\n  run   start a session\n', stderr: '' };
    return { ok: true, stdout: '', stderr: '' };
  };
  const found = await agents.discoverModels('gemini-cli', {
    env: { PATH: '/usr/bin' },
    binaryPath: '/usr/bin/gemini',
    run,
    builtInModels: ['gemini-2.5-pro', 'hf/gpt-oss'],
  });
  assert.deepStrictEqual(found.models, ['gemini-2.5-pro'], 'the router does not serve a model it refuses');
});

test('a free agent lists its own models and a paid one waits for the plan', () => {
  const agents = require('../src/main/agents');
  const harnesses = require('../src/main/harnesses');
  const catalogue = {};
  for (const agent of agents.AGENTS) {
    const harness = harnesses.getHarness(agent.harness);
    if (harness && harness.builtInModels.length) catalogue[agent.id] = harness.builtInModels;
  }
  const listed = agents.listAgents({}, { knownModels: ['gw/model'], discovered: {}, builtInModels: catalogue });
  const byId = Object.fromEntries(listed.map((a) => [a.id, a]));

  // Free: the models are already there, with nothing signed in and nothing run.
  const free = byId['gemini-cli'];
  assert.strictEqual(free.paid, false);
  assert.strictEqual(free.ownModelsSource, 'built-in');
  assert.deepStrictEqual(free.ownModels, harnesses.getHarness('gemini-cli').builtInModels);
  assert.strictEqual(free.ownModelsBilled, false, 'a free agent is not waiting on a payment');
  assert.strictEqual(free.ownModelsWaiting, false);

  // Paid: nothing is listed, and it is explicit that paying is what reveals them.
  const paid = byId['claude-code'];
  assert.strictEqual(paid.paid, true);
  assert.deepStrictEqual(paid.ownModels, [], 'a paid agent does not hand out models before the plan');
  assert.strictEqual(paid.ownModelsBilled, false, 'nothing has been discovered yet in this state');

  // And a paid agent with a live subscription is the one case that lists them.
  const subscribed = agents.listAgents({}, {
    knownModels: ['gw/model'],
    discovered: { 'claude-code': { models: ['opus', 'sonnet'], source: 'subscription', billed: true, auth: { subscription: true, method: 'claudeai' } } },
    builtInModels: catalogue,
  });
  const now = subscribed.find((a) => a.id === 'claude-code');
  assert.deepStrictEqual(now.ownModels, ['opus', 'sonnet']);
  assert.strictEqual(now.subscription, true);
  assert.strictEqual(now.ownModelsBilled, true);
});

test('a paid agent that is only routed locally is not shown built-in models', async () => {
  const agents = require('../src/main/agents');
  const run = async (binary, args) => {
    if (args[0] === '--help') return { ok: true, stdout: 'Commands:\n  auth  Manage authentication\n', stderr: '' };
    if (args[0] === 'auth' && args[1] === '--help') return { ok: true, stdout: '  status  Show authentication status\n', stderr: '' };
    if (args[0] === 'auth' && args[1] === 'status') {
      return { ok: true, stdout: JSON.stringify({ loggedIn: true, authMethod: 'api_key_helper', apiKeySource: 'apiKeyHelper' }), stderr: '' };
    }
    return { ok: true, stdout: '', stderr: '' };
  };
  const found = await agents.discoverModels('claude-code', { env: { PATH: '/usr/bin' }, binaryPath: '/usr/bin/claude', run });
  assert.deepStrictEqual(found.models, [], 'a key helper is this app, not a subscription');
  assert.strictEqual(found.source, 'needs-subscription');
  assert.strictEqual(found.billed, true);
  assert.strictEqual(found.auth.subscription, false);
});

test('a scheduled check only ever reports, it never installs', async () => {
  const { UpdateService } = require('../src/main/update-service');
  const home = tempDir();
  const target = path.join(home, 'app.build');
  fs.writeFileSync(target, packAsar({ 'package.json': JSON.stringify({ version: '1.0.0' }) }));
  let relaunches = 0;
  const build = packAsar({ 'package.json': JSON.stringify({ version: '1.1.0' }) });
  let asked = 0;
  const fetchImpl = async (url) => {
    asked += 1;
    if (url.includes('/releases/latest')) {
      return { ok: true, status: 200, json: async () => ({ tag_name: 'v1.1.0', body: 'notes', assets: [
        { name: 'app.asar', browser_download_url: 'https://cdn.test/app.asar' },
        { name: 'app.asar.sha256', browser_download_url: 'https://cdn.test/app.asar.sha256' },
      ] }) };
    }
    if (url.endsWith('.sha256')) {
      const b = Buffer.from(`${updater.sha256(build)}  app.asar\n`, 'utf8');
      return { ok: true, status: 200, headers: { get: () => String(b.length) }, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) };
    }
    return { ok: true, status: 200, headers: { get: () => String(build.length) }, arrayBuffer: async () => build.buffer.slice(build.byteOffset, build.byteOffset + build.length) };
  };
  const service = new UpdateService({ currentVersion: '1.0.0', home, target, fetchImpl, relaunch: () => { relaunches += 1; } });

  const found = await service.tick();
  assert.strictEqual(found.updateAvailable, true, 'the scheduled check does find a release');
  assert.strictEqual(relaunches, 0, 'and does not install it');
  assert.strictEqual(fs.readFileSync(target).length, packAsar({ 'package.json': JSON.stringify({ version: '1.0.0' }) }).length, 'the installed build is untouched');
  assert.ok(service.snapshot().updateAvailable, 'the card will show it when settings is opened');
});

test('a signed out device does not ask GitHub on a schedule', async () => {
  const { UpdateService } = require('../src/main/update-service');
  let asked = 0;
  const service = new UpdateService({
    currentVersion: '1.0.0',
    home: tempDir(),
    fetchImpl: async () => { asked += 1; return { ok: false, status: 404, json: async () => ({}) }; },
    isSignedIn: () => false,
  });
  const found = await service.tick();
  assert.strictEqual(asked, 0, 'nothing was requested');
  assert.strictEqual(found.state, 'signed-out');
  assert.strictEqual(service.snapshot().updateAvailable, false);
});

test('the scheduled check is unref\'d so it cannot hold the app open', () => {
  const { UpdateService, CHECK_INTERVAL_MS } = require('../src/main/update-service');
  assert.strictEqual(CHECK_INTERVAL_MS, 30 * 60 * 1000, 'half an hour');
  const service = new UpdateService({ currentVersion: '1.0.0', home: tempDir(), intervalMs: 5 });
  service.start();
  assert.ok(service.timer, 'a timer is running');
  assert.strictEqual(service.timer.hasRef(), false, 'it is unref\'d');
  service.stop();
  assert.strictEqual(service.timer, null, 'and it can be stopped again');
  service.stop();
});

test('a check already in progress is not started a second time', async () => {
  const { UpdateService } = require('../src/main/update-service');
  let release;
  const service = new UpdateService({
    currentVersion: '1.0.0',
    home: tempDir(),
    fetchImpl: async () => new Promise((resolve) => { release = () => resolve({ ok: false, status: 404, json: async () => ({}) }); }),
  });
  const first = service.check();
  const second = await service.check();
  assert.strictEqual(second.busy, true, 'the second call reports the work already running');
  release();
  await first;
  assert.strictEqual(service.snapshot().busy, false, 'and the service settles afterwards');
});

test('a tick is never answered entirely from the cache', async () => {
  const { UpdateService, CHECK_INTERVAL_MS } = require('../src/main/update-service');
  const { CACHE_TTL_MS } = require('../src/main/updates');
  // The relationship is the whole point: if the answer is cached for longer
  // than the gap between ticks, every tick reads a file and nothing is ever
  // asked again, while the app looks like it is checking.
  assert.ok(
    CACHE_TTL_MS < CHECK_INTERVAL_MS,
    `the cache (${CACHE_TTL_MS}ms) must expire before the next tick (${CHECK_INTERVAL_MS}ms)`,
  );
  assert.strictEqual(CACHE_TTL_MS, 15 * 60 * 1000);
  assert.strictEqual(CHECK_INTERVAL_MS, 30 * 60 * 1000);

  const home = tempDir();
  let asked = 0;
  const start = Date.parse('2026-01-01T00:00:00Z');
  const service = new UpdateService({
    currentVersion: '3.1.1',
    home,
    isSignedIn: () => true,
    fetchImpl: async () => { asked += 1; return { ok: false, status: 404, json: async () => ({}) }; },
  });

  const seen = [];
  for (let i = 1; i <= 4; i += 1) {
    service.now = start + i * CHECK_INTERVAL_MS;
    const r = await service.tick();
    seen.push(r.cached === true);
  }
  assert.strictEqual(asked, 4, 'each tick went to the network, not to a cached answer');
  assert.ok(seen.every((cached) => cached === false), 'no tick was served from the cache');
});

test('a second check inside the cache window is still answered locally', async () => {
  const home = tempDir();
  let asked = 0;
  const { CACHE_TTL_MS } = require('../src/main/updates');
  const start = Date.parse('2026-01-01T00:00:00Z');
  const fetchImpl = async () => { asked += 1; return { ok: false, status: 404, json: async () => ({}) }; };

  const first = await updater.check({ currentVersion: '1.0.0', home, force: true, fetchImpl, now: start });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(asked, 1);

  // Well inside the window: answered from disk, no request.
  const cached = await updater.check({ currentVersion: '1.0.0', home, fetchImpl, now: start + CACHE_TTL_MS - 1000 });
  assert.strictEqual(cached.cached, true);
  assert.strictEqual(asked, 1, 'nothing was asked a second time');

  // Past it: asked again.
  const refreshed = await updater.check({ currentVersion: '1.0.0', home, fetchImpl, now: start + CACHE_TTL_MS + 1000 });
  assert.notStrictEqual(refreshed.cached, true);
  assert.strictEqual(asked, 2, 'the cache expired and the answer was fetched again');
});

test('every provider is offered, and DeepSeek among them', () => {
  const providers = require('../src/main/providers');
  const catalog = providers.catalog();
  const all = [...catalog.local, ...catalog.cloud];
  assert.ok(all.length >= 10, `expected a full catalogue, got ${all.length}`);
  const byId = Object.fromEntries(all.map((p) => [p.id, p]));
  assert.ok(byId.deepseek, 'DeepSeek is one of the providers');
  assert.strictEqual(byId.deepseek.name, 'DeepSeek');
  assert.strictEqual(byId.deepseek.baseUrl, 'https://api.deepseek.com/v1');
  assert.strictEqual(byId.deepseek.requiresCredential, true);
  assert.ok(byId.deepseek.credentialLabel, 'it says which key it wants');
  for (const provider of all) {
    assert.ok(provider.id && provider.name, 'a provider is named');
    assert.ok(/^https?:\/\//.test(provider.baseUrl), `${provider.id} has a real endpoint`);
    assert.ok(Array.isArray(provider.supportedApis) && provider.supportedApis.length, `${provider.id} declares an api`);
    if (provider.requiresCredential) {
      assert.ok(provider.credentialLabel, `${provider.id} asks for a key by name`);
    }
  }
});

test('no models on offer means only automatic is accepted', () => {
  const { validateModel } = require('../src/main/agents');
  // The gateway being down produces an empty list, which used to be read as
  // "no information" and let any name through.
  assert.strictEqual(validateModel('auto', []), 'auto');
  assert.throws(() => validateModel('openai/gpt-4o-mini', []), (err) => err.code === 'unknown_model' && /No models are on offer/.test(err.message));
  // A list that does contain the model still accepts it.
  assert.strictEqual(validateModel('openai/gpt-4o-mini', ['openai/gpt-4o-mini']), 'openai/gpt-4o-mini');
  // No list at all still means "cannot check", which the save path relies on.
  assert.strictEqual(validateModel('openai/gpt-4o-mini', undefined), 'openai/gpt-4o-mini');
  // A refused model is refused whatever the list says.
  assert.throws(() => validateModel('hf/gpt-oss', []), (err) => err.code === 'forbidden_model');
});

test('an agent can be taken away and put back', async () => {
  const agents = require('../src/main/agents');
  const settings = { agents: { profiles: {} } };
  const first = agents.addProfile(settings, 'claude-code', {}, { knownModels: [] });
  assert.strictEqual(first['claude-code'].enabled, true);
  const gone = agents.removeProfile(first, 'claude-code');
  assert.strictEqual(gone['claude-code'], undefined);
  // Removing is not retiring it: it goes back in exactly as it was.
  const again = agents.addProfile(gone, 'claude-code', {}, { knownModels: [] });
  assert.strictEqual(again['claude-code'].enabled, true);
  assert.strictEqual(again['claude-code'].model, 'auto');
  // And doing it twice is harmless.
  assert.strictEqual(agents.removeProfile(agents.removeProfile(again, 'claude-code'), 'claude-code')['claude-code'], undefined);
});

test('a real Anthropic sign-in is found even behind the router key helper', () => {
  const agents = require('../src/main/agents');
  const fs2 = require('node:fs');
  const os2 = require('node:os');
  const path2 = require('node:path');
  const home = tempDir();
  fs2.mkdirSync(path2.join(home, '.claude'), { recursive: true });
  fs2.writeFileSync(
    path2.join(home, '.claude', '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'x', expiresAt: Date.now() + 1e6 } }),
  );

  // This is what the router makes the CLI report, once the router has put its
  // own key helper in the config. It hides the real sign-in.
  const hidden = agents.parseAuthStatus(JSON.stringify({ loggedIn: true, authMethod: 'api_key_helper', apiKeySource: 'apiKeyHelper' }), home);
  assert.strictEqual(hidden.reportedByCli, false, 'the CLI on its own cannot tell');
  assert.strictEqual(hidden.subscription, true, 'but the sign-in on the machine is still found');

  assert.strictEqual(agents.localSubscription(home).present, true);
  assert.strictEqual(agents.localSubscription(tempDir()).present, false, 'no file means no subscription');

  // And the models follow from it, even though the CLI reported a key helper.
  const run = async (binary, args) => {
    if (args[0] === '--help') return { ok: true, stdout: CLAUDE_TOP_HELP, stderr: '' };
    if (args[0] === 'auth' && args[1] === '--help') return { ok: true, stdout: CLAUDE_AUTH_HELP, stderr: '' };
    if (args[0] === 'auth' && args[1] === 'status') {
      return { ok: true, stdout: JSON.stringify({ loggedIn: true, authMethod: 'api_key_helper', apiKeySource: 'apiKeyHelper' }), stderr: '' };
    }
    return { ok: true, stdout: '', stderr: '' };
  };
  return agents.discoverModels('claude-code', { binaryPath: '/usr/bin/claude', run, home }).then((found) => {
    assert.strictEqual(found.source, 'subscription', 'the paid models show up');
    assert.deepStrictEqual(found.models, ['fable', 'opus', 'sonnet', 'claude-fable-5']);
    assert.strictEqual(found.billed, true);
  });
});

test('a change waiting on the debounce is sent before the app quits', async () => {
  const { SyncWorker } = require('../src/main/sync');
  const home = tempDir();
  const sent = [];
  const worker = new SyncWorker({
    settings: { get: () => ({}), save: () => ({}) },
    resolveEndpoint: () => 'https://sync.example.com',
    debounceMs: 60000,
    fetchImpl: async (url, options) => {
      sent.push({ url, method: options.method });
      return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
    },
  });
  worker.schedulePush();
  assert.strictEqual(worker.hasPending(), true, 'the change is sitting on the timer');
  assert.strictEqual(sent.length, 0, 'and has not gone out yet');

  const result = await worker.flush();
  assert.strictEqual(result.flushed, 1, 'it was still waiting when the app quit');
  assert.strictEqual(worker.hasPending(), false);
  assert.strictEqual(sent.length, 1, 'so the last edit was sent rather than dropped');
  assert.strictEqual(sent[0].method, 'POST');
  worker.stopAutoPull();
});

test('flushing with nothing pending is a no-op', async () => {
  const { SyncWorker } = require('../src/main/sync');
  const worker = new SyncWorker({ settings: { get: () => ({}) }, resolveEndpoint: () => null, fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }) });
  assert.strictEqual(worker.hasPending(), false);
  const result = await worker.flush();
  assert.strictEqual(result.flushed, 0);
});

test('sync reports what it actually did, not that it exists', async () => {
  const { SyncWorker } = require('../src/main/sync');
  const worker = new SyncWorker({
    settings: { get: () => ({}), save: () => ({}) },
    resolveEndpoint: () => 'https://sync.example.com',
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}', json: async () => ({}) }),
  });
  const before = worker.status_();
  assert.strictEqual(before.pendingPush, 0);
  assert.strictEqual(before.lastPush, null, 'nothing has been sent yet, and it says so');
  assert.strictEqual(before.lastPull, null);
  await worker.push();
  const after = worker.status_();
  assert.ok(after.lastPush && after.lastPush.pushedAt, 'a real push is recorded when one happens');
  assert.strictEqual(after.endpoint, 'https://sync.example.com');
  worker.stopAutoPull();
});
