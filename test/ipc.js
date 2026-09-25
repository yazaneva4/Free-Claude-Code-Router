'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../src/main/store');
const { createCrypto } = require('../src/main/crypto');
const { AccountService } = require('../src/main/accounts');
const { Vault } = require('../src/main/vault');
const { Settings } = require('../src/main/settings');
const { registerIpc } = require('../src/main/ipc');

let passed = 0;
let failed = 0;
const queue = [];

function test(name, fn) {
  queue.push({ name, fn });
}

async function run() {
  for (const item of queue) {
    try {
      await item.fn();
      passed += 1;
      console.log(`ok   ${item.name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL ${item.name}: ${err && err.message ? err.message : err}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

function build() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-ipc-'));
  const store = new Store(dir);
  const crypto = createCrypto({ keyFile: store.file('.devicekey') });
  const vault = new Vault({ store, crypto });
  const accounts = new AccountService({ store, crypto, purge: (id) => vault.deleteAllForAccount(id) });
  const settings = new Settings({ store });
  const handlers = {};
  registerIpc({
    ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; } },
    accounts,
    vault,
    settings,
    crypto,
  });
  const call = async (channel, payload) => {
    const response = await handlers[channel]({}, payload || {});
    assert.strictEqual(response.ok, true, `${channel} should succeed but said: ${JSON.stringify(response.error)}`);
    return response.value;
  };
  const callFail = async (channel, payload) => {
    const response = await handlers[channel]({}, payload || {});
    assert.strictEqual(response.ok, false, `${channel} should have failed`);
    return response.error;
  };
  return { dir, store, call, callFail, handlers };
}

const GOOD = { displayName: 'Yazan', email: 'yazan@example.com', password: 'correcthorse9', storageMode: 'device' };

test('every privileged channel is closed before sign in', async () => {
  const h = build();
  const boot = await h.call('auth:bootstrap');
  assert.strictEqual(boot.signedIn, false);
  assert.strictEqual(boot.account, null);
  assert.strictEqual(boot.accountCount, 0);
  for (const channel of ['settings:get', 'vault:list', 'providers:models', 'account:updateProfile', 'account:delete']) {
    const err = await h.callFail(channel, { providerId: 'openai' });
    assert.strictEqual(err.code, 'signed_out', `${channel} must demand a session`);
  }
});

test('bootstrap advertises providers with no Hugging Face', async () => {
  const h = build();
  const boot = await h.call('auth:bootstrap');
  assert.ok(!JSON.stringify(boot.providers).toLowerCase().includes('huggingface'));
  assert.deepStrictEqual(boot.providers.local.map((p) => p.id).sort(), ['llamacpp', 'lmstudio', 'ollama']);
  assert.deepStrictEqual(boot.storageModes, ['device', 'synced']);
});

test('signup through IPC then privileged channels open', async () => {
  const h = build();
  const session = await h.call('auth:signup', GOOD);
  assert.strictEqual(session.account.email, 'yazan@example.com');
  assert.strictEqual(session.accountCount, 1);
  const settings = await h.call('settings:get');
  assert.strictEqual(settings.routing.preferredProvider, 'ollama');
  const vault = await h.call('vault:list');
  assert.deepStrictEqual(vault.credentials, []);
  const bootstrap = await h.call('auth:bootstrap');
  assert.strictEqual(bootstrap.signedIn, true);
});

test('IPC never returns credential plaintext', async () => {
  const h = build();
  await h.call('auth:signup', GOOD);
  const saved = await h.call('vault:save', { providerId: 'openai', secret: 'sk-live-abc-123' });
  assert.strictEqual(saved.entry.hasSecret, true);
  assert.strictEqual(saved.replaced, false);
  const list = await h.call('vault:list');
  const serialized = JSON.stringify(list);
  assert.ok(!serialized.includes('sk-live-abc-123'), 'vault:list must not leak the secret');
  assert.ok(!serialized.includes('sk-live'), 'no partial leak either');
  const replaced = await h.call('vault:save', { providerId: 'openai', secret: 'sk-live-xyz-789' });
  assert.strictEqual(replaced.replaced, true);
  const after = await h.call('vault:list');
  assert.strictEqual(after.credentials.length, 1);
  assert.ok(!JSON.stringify(after).includes('sk-live'));
});

test('vault:save refuses empty secrets and vault:delete removes', async () => {
  const h = build();
  await h.call('auth:signup', GOOD);
  const err = await h.callFail('vault:save', { providerId: 'openai', secret: '' });
  assert.strictEqual(err.code, 'invalid_secret');
  await h.call('vault:save', { providerId: 'openai', secret: 'sk-temp' });
  const deleted = await h.call('vault:delete', { providerId: 'openai' });
  assert.strictEqual(deleted.deleted, true);
  const gone = await h.callFail('vault:delete', { providerId: 'openai' });
  assert.strictEqual(gone.code, 'not_found');
});

test('cloud providers demand a credential before listing models', async () => {
  const h = build();
  await h.call('auth:signup', GOOD);
  const err = await h.callFail('providers:models', { providerId: 'openai' });
  assert.strictEqual(err.code, 'missing_credential');
  const unknown = await h.callFail('providers:models', { providerId: 'huggingface' });
  assert.strictEqual(unknown.code, 'unknown_provider');
});

test('local runtime probing works against the live Ollama on this machine', async () => {
  const h = build();
  await h.call('auth:signup', GOOD);
  const result = await h.call('providers:probe', { providerId: 'ollama' });
  assert.strictEqual(typeof result.reachable, 'boolean');
  if (result.reachable) {
    assert.ok(Array.isArray(result.models));
    assert.ok(!result.models.some((m) => String(m.id).toLowerCase().startsWith('hf/')), 'no HF models may appear');
  } else {
    assert.ok(result.error, 'an unreachable probe must explain itself');
  }
});

test('routing and integration updates persist over IPC', async () => {
  const h = build();
  await h.call('auth:signup', GOOD);
  const routed = await h.call('settings:updateRouting', { preferredProvider: 'lmstudio' });
  assert.strictEqual(routed.routing.preferredProvider, 'lmstudio');
  const bad = await h.callFail('settings:updateRouting', { preferredProvider: 'huggingface' });
  assert.ok(/Unknown preferred provider/.test(bad.message));
  const integration = await h.call('settings:updateIntegration', { kind: 'cli', name: 'claudeCode', patch: { enabled: true } });
  assert.strictEqual(integration.integrations.cli.claudeCode.enabled, true);
});

test('logout closes privileged channels again', async () => {
  const h = build();
  await h.call('auth:signup', GOOD);
  await h.call('auth:logout');
  const err = await h.callFail('settings:get');
  assert.strictEqual(err.code, 'signed_out');
  const boot = await h.call('auth:bootstrap');
  assert.strictEqual(boot.signedIn, false);
  assert.strictEqual(boot.accountCount, 1, 'the account survives logout');
});

test('account deletion wipes credentials and closes the session', async () => {
  const h = build();
  await h.call('auth:signup', GOOD);
  await h.call('vault:save', { providerId: 'openai', secret: 'sk-doomed' });
  const deleted = await h.call('account:delete');
  assert.strictEqual(deleted.deleted, true);
  const boot = await h.call('auth:bootstrap');
  assert.strictEqual(boot.accountCount, 0);
  assert.strictEqual(boot.signedIn, false);
  const vaultRaw = fs.readFileSync(h.store.file('vault.json'), 'utf8');
  assert.ok(!vaultRaw.includes('sk-doomed'), 'no orphan credential may remain on disk');
});

test('wrong password and duplicate email surface friendly codes over IPC', async () => {
  const h = build();
  await h.call('auth:signup', GOOD);
  const wrong = await h.callFail('auth:login', { email: GOOD.email, password: 'wrongpass9' });
  assert.strictEqual(wrong.code, 'invalid_credentials');
  const dupe = await h.callFail('auth:signup', { ...GOOD, password: 'otherpass9' });
  assert.strictEqual(dupe.code, 'email_taken');
  const weak = await h.callFail('auth:signup', { ...GOOD, email: 'new@example.com', password: 'abc' });
  assert.strictEqual(weak.code, 'invalid_password');
});

test('bootstrap lists the harnesses and the first setup step', async () => {
  const h = build();
  const before = await h.call('auth:bootstrap');
  assert.strictEqual(before.harnesses.length, 5);
  assert.strictEqual(before.onboarding.nextStep, 'sync');
  await h.call('auth:signup', GOOD);
  const after = await h.call('auth:bootstrap');
  assert.strictEqual(after.onboarding.nextStep, 'sync', 'a fresh device always starts at the sync question');
  assert.strictEqual(after.onboarding.complete, false);
});

test('setup channels are closed before sign in', async () => {
  const h = build();
  const sync = await h.callFail('onboarding:saveSync', { storageMode: 'device' });
  assert.strictEqual(sync.code, 'signed_out');
  const harness = await h.callFail('onboarding:saveHarnesses', { selections: {} });
  assert.strictEqual(harness.code, 'signed_out');
});

test('the setup flow records both answers and then reports completion', async () => {
  const h = build();
  await h.call('auth:signup', GOOD);
  const sync = await h.call('onboarding:saveSync', { storageMode: 'device', syncEndpoint: '' });
  assert.strictEqual(sync.onboarding.nextStep, 'harnesses');
  assert.strictEqual(sync.account.storageMode, 'device');
  const harness = await h.call('onboarding:saveHarnesses', {
    selections: { 'gemini-cli': { enabled: true, model: 'gemini-2.5-pro' } },
  });
  assert.strictEqual(harness.onboarding.complete, true);
  assert.strictEqual(harness.onboarding.nextStep, null);
  assert.strictEqual(harness.settings.integrations.cli.gemini.enabled, true);
  assert.strictEqual(harness.settings.integrations.cli.gemini.model, 'gemini-2.5-pro');
  assert.strictEqual(harness.settings.integrations.app.claude.enabled, false);
});

test('synced setup without a real https endpoint is refused', async () => {
  const h = build();
  await h.call('auth:signup', GOOD);
  const insecure = await h.callFail('onboarding:saveSync', { storageMode: 'synced', syncEndpoint: 'http://insecure' });
  assert.strictEqual(insecure.code, 'invalid_sync_endpoint');
  const missing = await h.callFail('onboarding:saveSync', { storageMode: 'synced', syncEndpoint: '' });
  assert.strictEqual(missing.code, 'invalid_sync_endpoint');
  const state = await h.call('auth:bootstrap');
  assert.strictEqual(state.onboarding.nextStep, 'sync', 'a refused answer must not count as answered');
});

run();
