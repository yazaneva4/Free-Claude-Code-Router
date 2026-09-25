'use strict';

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

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${name}: ${err && err.message ? err.message : err}`);
  }
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

test('model normalization handles ollama and openai shapes', () => {
  assert.deepStrictEqual(providers.normalizeModels({ data: [{ id: 'llama3.2:1b' }] }), [{ id: 'llama3.2:1b', ownedBy: null, contextWindow: null }]);
  const tags = providers.normalizeModels({ models: [{ name: 'qwen2.5', model: 'qwen2.5' }] });
  assert.deepStrictEqual(tags.map((m) => m.id), ['qwen2.5']);
});

test('settings default to local providers and refuse unknown or forbidden routing', () => {
  const h = harness();
  const defaults = h.settings.get();
  assert.strictEqual(defaults.routing.preferredProvider, 'ollama');
  assert.deepStrictEqual(defaults.routing.fallbackOrder, ['lmstudio', 'ollama', 'llamacpp']);
  assert.throws(() => h.settings.setRouting({ preferredProvider: 'huggingface' }), /Unknown preferred provider/);
  assert.throws(() => h.settings.setRouting({ preferredProvider: 'made-up' }), /Unknown preferred provider/);
  const updated = h.settings.setRouting({ preferredProvider: 'llamacpp', fallbackOrder: ['llamacpp', 'huggingface'] });
  assert.strictEqual(updated.routing.preferredProvider, 'llamacpp');
  assert.deepStrictEqual(updated.routing.fallbackOrder, ['llamacpp'], 'unknown providers are dropped from fallback');
});

test('provider and integration settings persist per provider', () => {
  const h = harness();
  h.settings.setProvider('ollama', { baseUrl: 'http://127.0.0.1:11435/v1', enabled: false });
  assert.strictEqual(h.settings.get().providers.ollama.baseUrl, 'http://127.0.0.1:11435/v1');
  h.settings.setIntegration('cli', 'claudeCode', { enabled: true, model: 'ollama/llama3.2' });
  assert.strictEqual(h.settings.get().integrations.cli.claudeCode.model, 'ollama/llama3.2');
  assert.throws(() => h.settings.setIntegration('cli', 'nope', {}), /Unknown integration/);
  assert.throws(() => h.settings.setProvider('huggingface', {}), /Unknown provider/);
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
  assert.strictEqual(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
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
  assert.strictEqual(paid.length, 4);
  assert.ok(paid.every((harness) => harness.builtInModels.length === 0), 'paid harnesses get no built-in models');
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
