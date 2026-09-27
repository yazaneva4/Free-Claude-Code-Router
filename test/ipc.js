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
const { SyncWorker } = require('../src/main/sync');
const { UpdateService } = require('../src/main/update-service');

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

function build(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-ipc-'));
  const store = new Store(dir);
  const crypto = createCrypto({ keyFile: store.file('.devicekey') });
  const vault = new Vault({ store, crypto });
  const accounts = new AccountService({ store, crypto, purge: (id) => vault.deleteAllForAccount(id) });
  const settings = new Settings({ store });
  const parts = { dir, store, crypto, vault, accounts, settings };
  // A test can hand in a factory so the worker is wired exactly as the app does.
  const sync = options.syncFor ? options.syncFor(parts) : null;
  const updateService = options.updateFor ? options.updateFor(parts) : null;
  const handlers = {};
  registerIpc({
    ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; } },
    accounts,
    vault,
    settings,
    crypto,
    sync,
    updateService,
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
  return { dir, store, call, callFail, handlers, accounts, vault, settings, updateService };
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

test('a credential can never be stored for an unsupported provider', async () => {
  const h = build();
  await h.call('auth:signup', GOOD);
  for (const providerId of ['huggingface', 'hf', 'hugging-face', 'HF', 'hugging_face']) {
    const err = await h.callFail('vault:save', { providerId, secret: 'hf_leaked_key' });
    assert.strictEqual(err.code, 'unsupported_provider', `${providerId} must be refused`);
  }
  const unknown = await h.callFail('vault:save', { providerId: 'made-up', secret: 'sk-x' });
  assert.strictEqual(unknown.code, 'unknown_provider');
  const list = await h.call('vault:list');
  assert.deepStrictEqual(list.credentials, [], 'nothing is stored for a provider we refuse');
  const stored = JSON.stringify(h.store.read('vault.json', {}));
  assert.ok(!stored.includes('hf_leaked_key'), 'the key never reaches disk');
  const del = await h.callFail('vault:delete', { providerId: 'huggingface' });
  assert.strictEqual(del.code, 'unsupported_provider');
  for (const channel of ['providers:models', 'providers:probe']) {
    const err = await h.callFail(channel, { providerId: 'hf/gpt' });
    assert.strictEqual(err.code, 'unsupported_provider', `${channel} refuses it too`);
  }
  const routing = await h.callFail('settings:updateRouting', { preferredProvider: 'huggingface' });
  assert.strictEqual(routing.code, 'unsupported_provider');
  await h.call('vault:save', { providerId: 'openai', secret: 'sk-still-works' });
  assert.strictEqual((await h.call('vault:list')).credentials.length, 1, 'supported providers still work');
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
  assert.strictEqual(unknown.code, 'unsupported_provider');
  const madeUp = await h.callFail('providers:models', { providerId: 'made-up' });
  assert.strictEqual(madeUp.code, 'unknown_provider');
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
  assert.ok(/not a supported provider/.test(bad.message), 'an unsupported provider is named as such');
  const integration = await h.call('settings:updateIntegration', { kind: 'cli', name: 'claudeCode', patch: { enabled: true } });
  assert.strictEqual(integration.integrations.cli.claudeCode.enabled, true);
});

test('an unsupported API is refused at the IPC boundary', async () => {
  const h = build();
  await h.call('auth:signup', GOOD);
  const catalog = await h.call('providers:catalog');
  assert.ok(catalog.apis.includes('openai_responses'), 'the catalog lists what the router speaks');

  for (const api of ['made_up', 'huggingface', 'openai_completions', '']) {
    const err = await h.callFail('settings:updateProvider', { providerId: 'ollama', patch: { api } });
    assert.strictEqual(err.code, 'unsupported_api', `${api || '(empty)'} must be refused`);
  }
  const harnessErr = await h.callFail('settings:updateIntegration', { kind: 'cli', name: 'claudeCode', patch: { api: 'telepathy' } });
  assert.strictEqual(harnessErr.code, 'unsupported_api');

  const accepted = await h.call('settings:updateProvider', { providerId: 'ollama', patch: { api: 'openai_responses' } });
  assert.strictEqual(accepted.providers.ollama.api, 'openai_responses');
  const harnessOk = await h.call('settings:updateIntegration', { kind: 'cli', name: 'claudeCode', patch: { api: 'anthropic_messages' } });
  assert.strictEqual(harnessOk.integrations.cli.claudeCode.api, 'anthropic_messages');

  const secret = await h.call('settings:updateProvider', { providerId: 'openai', patch: { secret: 'sk-smuggled' } });
  assert.strictEqual(secret.providers.openai.secret, undefined, 'an unknown key is dropped instead of stored');
  const openai = (await h.call('settings:get')).providers.openai;
  assert.strictEqual(openai.secret, undefined, 'no unknown key is ever written');
});

test('the new realtime channels are closed before sign in', async () => {
  const h = build();
  const channels = [
    'agents:list', 'agents:add', 'agents:update', 'agents:remove',
    'gateway:status', 'gateway:models', 'gateway:probe', 'gateway:repair', 'gateway:hidden',
    'updates:check', 'updates:state', 'sync:push', 'sync:pull', 'sync:state',
    'sync:pushVault', 'sync:pullVault', 'updates:install', 'agents:login',
    'validate:field', 'settings:updateGateway',
  ];
  for (const channel of channels) {
    const err = await h.callFail(channel, { providerId: 'openai', agentId: 'claude-code', model: 'openai', field: 'model', value: 'openai', patch: {} });
    assert.strictEqual(err.code, 'signed_out', `${channel} must be closed`);
  }
});

test('an agent profile is added explicitly and refuses what the router will not use', async () => {
  const h = build();
  await h.call('auth:signup', GOOD);
  const before = await h.call('agents:list');
  assert.deepStrictEqual(before.agents.filter((agent) => agent.added), [], 'nothing is connected yet');
  assert.ok(before.agents.every((agent) => agent.needsLogin === false), 'no agent login is ever requested');

  const added = await h.call('agents:add', { agentId: 'claude-code', patch: { enabled: true } });
  assert.strictEqual(added.profiles['claude-code'].enabled, true);
  assert.strictEqual(added.profiles['claude-code'].model, 'auto');
  assert.strictEqual(added.profiles['claude-code'].baseUrl, 'http://127.0.0.1:3456');

  const banned = await h.callFail('agents:add', { agentId: 'huggingface', patch: { enabled: true } });
  assert.strictEqual(banned.code, 'unknown_agent');
  const forbiddenModel = await h.callFail('agents:update', { agentId: 'claude-code', patch: { model: 'hf/gpt-oss' } });
  assert.strictEqual(forbiddenModel.code, 'forbidden_model');
  const badUrl = await h.callFail('agents:update', { agentId: 'claude-code', patch: { baseUrl: 'https://evil.example.com' } });
  assert.strictEqual(badUrl.code, 'invalid_base_url');
  const notAdded = await h.callFail('agents:update', { agentId: 'gemini-cli', patch: { enabled: true } });
  assert.strictEqual(notAdded.code, 'profile_not_added');

  const validated = await h.call('validate:field', { field: 'providerId', value: 'openai' });
  assert.strictEqual(validated.ok, true);
  const refusedProvider = await h.callFail('validate:field', { field: 'providerId', value: 'huggingface' });
  assert.strictEqual(refusedProvider.code, 'unsupported_provider');
  const refusedModel = await h.callFail('validate:field', { field: 'model', value: 'hf/gpt' });
  assert.strictEqual(refusedModel.code, 'forbidden_model');
  const goodApi = await h.call('validate:field', { field: 'api', value: 'openai_responses' });
  assert.strictEqual(goodApi.value, 'openai_responses');
  const badApi = await h.callFail('validate:field', { field: 'api', value: 'made_up' });
  assert.strictEqual(badApi.code, 'unsupported_api');

  const removed = await h.call('agents:remove', { agentId: 'claude-code' });
  assert.deepStrictEqual(removed.profiles, {});
});

test('the gateway channels answer without a live gateway', async () => {
  const h = build();
  await h.call('auth:signup', GOOD);
  const status = await h.call('gateway:status');
  assert.strictEqual(typeof status.reachable, 'boolean');
  assert.ok(status.endpoint.startsWith('http'), 'the endpoint is reported');
  assert.ok(Array.isArray(status.models));
  assert.ok(Array.isArray(status.hidden));
  const models = await h.call('gateway:models');
  assert.ok(Array.isArray(models.models));
  const hidden = await h.call('gateway:hidden', { clear: true });
  assert.deepStrictEqual(hidden.hidden, []);
  const forbiddenProbe = await h.callFail('gateway:probe', { model: 'hf/gpt-oss' });
  assert.strictEqual(forbiddenProbe.code, 'forbidden_model', 'the probe refuses a model the router will not use');
  const updates = await h.call('updates:state');
  assert.ok('currentVersion' in updates);
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

test('saving a key from the app shares it with the account other devices', async () => {
  const wire = new Map();
  const server = async (url, options = {}) => {
    if (options.method === 'POST') {
      wire.set(url, options.body);
      return { ok: true, status: 200, text: async () => '{}' };
    }
    if (!wire.has(url)) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, json: async () => JSON.parse(wire.get(url)) };
  };
  const ENDPOINT = 'https://sync.example.com';
  const device = () => build({
    syncFor: (parts) => new SyncWorker({
      settings: parts.settings,
      vault: parts.vault,
      accounts: parts.accounts,
      resolveEndpoint: () => ENDPOINT,
      fetchImpl: server,
    }),
  });

  const one = device();
  await one.call('auth:signup', { ...GOOD, storageMode: 'synced' });
  await one.call('account:updateProfile', { displayName: 'Yazan', storageMode: 'synced', syncEndpoint: ENDPOINT });
  const saved = await one.call('vault:save', { providerId: 'openai', secret: 'sk-real-openai', label: 'OpenAI' });
  assert.strictEqual(saved.sharedWithDevices, true, 'the app reports the key went to the account');
  assert.ok(!JSON.stringify([...wire.values()]).includes('sk-real-openai'), 'the endpoint still only holds the sealed copy');

  const two = device();
  await two.call('auth:signup', { ...GOOD, storageMode: 'synced' });
  await two.call('account:updateProfile', { displayName: 'Yazan', storageMode: 'synced', syncEndpoint: ENDPOINT });
  assert.deepStrictEqual((await two.call('vault:list')).credentials, [], 'the other device has no keys yet');

  const pulled = await two.call('sync:pullVault');
  assert.strictEqual(pulled.ok, true, pulled.error);
  assert.strictEqual(pulled.imported, 1);
  const after = await two.call('vault:list');
  assert.strictEqual(after.credentials.length, 1);
  assert.strictEqual(after.credentials[0].providerId, 'openai');
  assert.strictEqual(after.credentials[0].hasSecret, true, 'the second device has a usable key');
  assert.strictEqual(after.credentials[0].secret, undefined, 'the listing still hides the key itself');
});

test('the update channels are wired to a real check and refuse an empty install', async () => {
  const h = build({
    updateFor: (parts) => new UpdateService({
      currentVersion: '1.0.0',
      home: parts.dir,
      target: path.join(parts.dir, 'app.build'),
      // No release has been published, which is a normal answer, not a failure.
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
      relaunch: () => {},
    }),
  });
  await h.call('auth:signup', GOOD);

  const before = await h.call('updates:state');
  assert.strictEqual(before.currentVersion, '1.0.0');
  assert.strictEqual(before.updateAvailable, false);

  const checked = await h.call('updates:check', { force: true });
  assert.strictEqual(checked.state, 'no-release');
  assert.strictEqual(checked.updateAvailable, false);

  // Nothing was found, so installing says so instead of reaching for a download.
  const refused = await h.call('updates:install');
  assert.strictEqual(refused.refused, 'nothing_to_install');
});

test('an agent profile change is saved, not the old config', async () => {
  const h = build();
  await h.call('auth:signup', GOOD);

  const added = await h.call('agents:add', { agentId: 'claude-code', patch: { model: 'auto' } });
  assert.strictEqual(added.profiles['claude-code'].enabled, true);
  assert.ok(added.profiles['claude-code'].addedAt, 'the profile records when it was added');

  // What the app just wrote has to be what is on disk, and what comes back.
  const onDisk = JSON.parse(fs.readFileSync(path.join(h.dir, 'settings.json'), 'utf8'));
  const stored = onDisk.agents.profiles['claude-code'];
  assert.strictEqual(stored.model, 'auto');
  assert.ok(stored.addedAt, 'saving the profile does not throw the added time away');
  assert.ok(stored.baseUrl, 'and does not throw the endpoint away');

  // Changing the model has to replace the old one everywhere, not beside it.
  const changed = await h.call('agents:update', { agentId: 'claude-code', patch: { model: 'auto', baseUrl: 'http://127.0.0.1:3456' } });
  assert.strictEqual(changed.profiles['claude-code'].model, 'auto');
  assert.strictEqual(changed.profiles['claude-code'].baseUrl, 'http://127.0.0.1:3456');

  const reread = JSON.parse(fs.readFileSync(path.join(h.dir, 'settings.json'), 'utf8'));
  assert.deepStrictEqual(reread.agents.profiles['claude-code'], {
    enabled: true,
    model: 'auto',
    baseUrl: 'http://127.0.0.1:3456',
    addedAt: stored.addedAt,
  });

  // Turning one agent off must not disturb another one.
  await h.call('agents:add', { agentId: 'codex-cli', patch: { model: 'auto' } });
  await h.call('agents:update', { agentId: 'claude-code', patch: { enabled: false } });
  const both = await h.call('agents:list');
  assert.strictEqual(both.agents.find((a) => a.id === 'claude-code').enabled, false, 'the change stuck');
  assert.strictEqual(both.agents.find((a) => a.id === 'codex-cli').enabled, true, 'the other profile is untouched');

  // A refused change must leave the saved profile exactly as it was.
  const before = JSON.parse(fs.readFileSync(path.join(h.dir, 'settings.json'), 'utf8')).agents.profiles['claude-code'];
  const refused = await h.callFail('agents:update', { agentId: 'claude-code', patch: { model: 'hf/gpt-oss' } });
  assert.strictEqual(refused.code, 'forbidden_model');
  const after = JSON.parse(fs.readFileSync(path.join(h.dir, 'settings.json'), 'utf8')).agents.profiles['claude-code'];
  assert.deepStrictEqual(after, before, 'a refused change writes nothing');

  // Removing has to remove it from disk too, not only from the reply.
  await h.call('agents:remove', { agentId: 'claude-code' });
  const gone = JSON.parse(fs.readFileSync(path.join(h.dir, 'settings.json'), 'utf8')).agents.profiles;
  assert.strictEqual(gone['claude-code'], undefined, 'the old profile is gone from disk');
  assert.ok(gone['codex-cli'], 'the other profile survived');
  assert.strictEqual((await h.call('agents:list')).agents.find((a) => a.id === 'claude-code').added, false);
});

test('a profile survives a fresh read of the settings file', async () => {
  const h = build();
  await h.call('auth:signup', GOOD);
  await h.call('agents:add', { agentId: 'gemini-cli', patch: { model: 'auto' } });
  // A new Settings instance is what the app gets on the next launch.
  const reopened = new Settings({ store: new Store(h.dir) });
  const profiles = reopened.get().agents.profiles;
  assert.ok(profiles['gemini-cli'], 'the profile is still there after a restart');
  assert.strictEqual(profiles['gemini-cli'].enabled, true);
  assert.ok(profiles['gemini-cli'].addedAt, 'its metadata survived too');
});
