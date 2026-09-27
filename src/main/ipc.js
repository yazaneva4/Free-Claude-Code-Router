'use strict';

const providers = require('./providers');
const harnesses = require('./harnesses');
const gateway = require('./gateway');
const agents = require('./agents');
const profileWriter = require('./profile-writer');
const validators = require('./validators');

function result(value) {
  return { ok: true, value };
}

function failure(err) {
  const code = err && err.code ? err.code : 'error';
  const message = err && err.message ? err.message : String(err);
  return { ok: false, error: { code, message } };
}

function handle(ipcMain, channel, fn) {
  ipcMain.handle(channel, async (_event, payload) => {
    try {
      return result(await fn(payload || {}));
    } catch (err) {
      return failure(err);
    }
  });
}

/**
 * The models a free agent already ships with. A free agent has these without
 * paying for anything, so its catalogue is what it can use; a paid agent's
 * models come with the plan instead, and are not handed out here.
 */
/** Every free agent's own models, keyed by agent id. */
function builtInCatalogue() {
  const out = {};
  for (const agent of agents.AGENTS) {
    const models = builtInFor(agent.id);
    if (models.length) out[agent.id] = models;
  }
  return out;
}

function builtInFor(agentId) {
  try {
    const agent = agents.getAgent(agentId);
    const harness = agent ? harnesses.getHarness(agent.harness) : null;
    return harness && Array.isArray(harness.builtInModels) ? harness.builtInModels : [];
  } catch {
    return [];
  }
}

function registerIpc({ ipcMain, accounts, vault, settings, crypto, onSessionEnded = null, sync = null, updateService = null, appVersion = '0.0.0' }) {
  const session = () => accounts.requireSession();
  const endpoint = () => (settings.get().gateway || {}).endpoint || gateway.DEFAULT_ENDPOINT;
  const knownModels = async () => {
    const found = await gateway.listModels({ endpoint: endpoint() });
    return found.models;
  };
  // A model is acceptable if the gateway serves it or the agent itself reported
  // it, so a published built-in is never refused as "unknown".
  const acceptableModels = async (agentId) => {
    const models = await knownModels();
    const found = await agents.discoverModels(agentId);
    return Array.from(new Set([...models, ...(found.models || [])]));
  };
  const gatewayStatus = async () => {
    const found = await gateway.listModels({ endpoint: endpoint() });
    const current = profileWriter.readModel();
    const configured = agents.listAgents(settings.get()).filter((agent) => agent.enabled && agent.model !== 'auto');
    return {
      endpoint: endpoint(),
      reachable: found.status >= 200 && found.status < 300,
      httpStatus: found.status,
      models: found.models,
      hidden: found.blocked,
      activeModel: current ? current.model : null,
      activeModelFile: current ? current.file : null,
      configured,
      autoRepair: (settings.get().gateway || {}).autoRepair !== false,
      checkedAt: new Date().toISOString(),
    };
  };
  const repairGateway = async (payload = {}) => {
    const preferred = payload.model || (profileWriter.readModel() || {}).model || null;
    const found = await knownModels();
    const result = await gateway.findWorkingModel(preferred, found, { endpoint: endpoint(), isBlocked: (model) => gateway.isBlocked(model) });
    const current = settings.get();
    if (result.model) {
      // Only a profile that was actually pointing at a model that failed is
      // rewritten. A profile the user left on another model is left alone.
      const broken = new Set(result.tried.filter((try_) => !try_.ok).map((try_) => try_.model));
      for (const entry of profileWriter.settingsFiles()) {
        const held = profileWriter.readModel({ files: [entry] });
        if (held && broken.has(held.model)) {
          profileWriter.applyModel(result.model, { files: [entry] });
        }
      }
      const profiles = agents.profileState(current);
      const next = {};
      let changed = false;
      for (const [id, profile] of Object.entries(profiles)) {
        if (profile.model && profile.model !== 'auto' && !result.tried.find((try_) => try_.model === profile.model && try_.ok)) {
          next[id] = { ...profile, model: result.model };
          changed = true;
        } else {
          next[id] = profile;
        }
      }
      if (changed) settings.setAgentProfiles(next);
      if (current.gateway && current.gateway.activeModel !== result.model) settings.setGateway({ activeModel: result.model });
    }
    return {
      repaired: Boolean(result.model),
      model: result.model,
      preferred: preferred || null,
      tried: result.tried,
      profilesUpdated: result.model ? agents.listAgents(settings.get()).filter((agent) => agent.enabled && agent.model === result.model).map((agent) => agent.id) : [],
      checkedAt: new Date().toISOString(),
    };
  };
  const validateField = (payload) => {
    const field = String(payload.field || '');
    if (field === 'providerId') {
      const provider = providers.assertSupportedProvider(payload.value);
      return { ok: true, value: provider.id, message: `${provider.name} is supported.` };
    }
    if (field === 'model') {
      const known = Array.isArray(payload.knownModels) ? payload.knownModels : null;
      const value = payload.value === 'auto' || !payload.value ? 'auto' : validators.cleanModel(payload.value, { knownModels: known });
      return { ok: true, value, message: value === 'auto' ? 'The router will choose a model.' : `${value} is a model this router can use.` };
    }
    if (field === 'api') {
      return { ok: true, value: validators.cleanApi(payload.value), message: 'The router speaks this API.' };
    }
    if (field === 'baseUrl') {
      const value = validators.cleanBaseUrl(payload.value, { allowOnlyLoopbackOrGateway: Boolean(payload.agentProfile) });
      return { ok: true, value, message: 'The endpoint is a valid local address.' };
    }
    if (field === 'agentId') {
      const agent = agents.getAgent(payload.value);
      if (!agent) throw validators.badRequest('unknown_agent', 'That agent profile does not exist.');
      return { ok: true, value: agent.id, message: `${agent.name} can be added to your profiles.` };
    }
    throw validators.badRequest('invalid_value', 'That field cannot be checked.');
  };

  const endSession = async (reason) => {
    if (typeof onSessionEnded === 'function') await onSessionEnded(reason);
  };

  handle(ipcMain, 'auth:bootstrap', () => {
    const active = accounts.session();
    return {
      signedIn: Boolean(active),
      account: active ? active.account : null,
      accountCount: accounts.count(),
      encryptionBackend: crypto.backend,
      providers: providers.catalog(),
      harnesses: harnesses.catalog(settings.get()),
      onboarding: accounts.onboarding(),
      storageModes: ['device', 'synced'],
    };
  });

  handle(ipcMain, 'auth:signup', async (payload) => {
    const sessionValue = accounts.signup(payload);
    return { ...sessionValue, accountCount: accounts.count(), onboarding: accounts.onboarding() };
  });

  handle(ipcMain, 'auth:login', (payload) => accounts.login(payload));

  handle(ipcMain, 'auth:logout', async () => {
    const result = accounts.logout();
    await endSession('signed out');
    return result;
  });

  handle(ipcMain, 'auth:session', () => accounts.session());

  handle(ipcMain, 'onboarding:saveSync', (payload) => {
    session();
    return accounts.completeSyncChoice(payload);
  });

  handle(ipcMain, 'onboarding:saveHarnesses', (payload) => {
    session();
    const applied = harnesses.applySelections(settings, payload.selections || {});
    return { ...applied, onboarding: accounts.completeHarnessChoice() };
  });

  handle(ipcMain, 'account:changePassword', (payload) => {
    session();
    return accounts.changePassword(payload);
  });

  handle(ipcMain, 'account:updateProfile', (payload) => {
    session();
    return accounts.updateProfile(payload);
  });

  handle(ipcMain, 'account:delete', async () => {
    const result = accounts.deleteAccount();
    await endSession('account deleted');
    return result;
  });

  handle(ipcMain, 'vault:list', () => {
    const active = session();
    return { credentials: vault.list(active.account.id) };
  });

  handle(ipcMain, 'vault:save', (payload) => {
    const active = session();
    if (typeof payload.secret !== 'string' || payload.secret.length === 0) {
      throw Object.assign(new Error('A credential value is required to store or replace it.'), { code: 'invalid_secret' });
    }
    const provider = providers.assertSupportedProvider(payload.providerId);
    const label = typeof payload.label === 'string' && payload.label.trim() ? payload.label.trim().slice(0, 60) : provider.name;
    const saved = vault.set(active.account.id, { providerId: provider.id, secret: payload.secret, label });
    if (sync && active.account.storageMode === 'synced' && active.account.syncEndpoint) {
      // Sealed with the account password, so the endpoint only ever holds ciphertext.
      sync.pushVault().catch(() => {});
    }
    return { ...saved, sharedWithDevices: Boolean(sync && active.account.storageMode === 'synced' && active.account.syncEndpoint) };
  });

  handle(ipcMain, 'vault:delete', (payload) => {
    const active = session();
    return vault.delete(active.account.id, providers.assertSupportedProvider(payload.providerId).id);
  });

  handle(ipcMain, 'providers:catalog', () => providers.catalog());

  handle(ipcMain, 'providers:probe', async (payload) => {
    const active = session();
    const provider = providers.assertSupportedProvider(payload.providerId);
    const secret = provider.requiresCredential ? vault.secret(active.account.id, provider.id) : null;
    const configured = settings.get().providers[provider.id] || {};
    return providers.probe(provider.id, { secret, baseUrl: payload.baseUrl || configured.baseUrl });
  });

  handle(ipcMain, 'providers:models', async (payload) => {
    const active = session();
    const provider = providers.assertSupportedProvider(payload.providerId);
    const secret = provider.requiresCredential ? vault.secret(active.account.id, provider.id) : null;
    const configured = settings.get().providers[provider.id] || {};
    if (provider.requiresCredential && !secret) {
      throw Object.assign(new Error(`Add your ${provider.credentialLabel} in Settings first.`), { code: 'missing_credential' });
    }
    const found = await providers.probe(provider.id, { secret, baseUrl: payload.baseUrl || configured.baseUrl });
    return found;
  });

  handle(ipcMain, 'settings:get', () => {
    session();
    return settings.get();
  });

  handle(ipcMain, 'settings:updateRouting', (payload) => {
    session();
    return settings.setRouting(payload);
  });

  handle(ipcMain, 'settings:updateProvider', (payload) => {
    session();
    return settings.setProvider(payload.providerId, payload.patch || {});
  });

  handle(ipcMain, 'settings:updateIntegration', (payload) => {
    session();
    return settings.setIntegration(payload.kind, payload.name, payload.patch || {});
  });

  handle(ipcMain, 'settings:updateGateway', (payload) => {
    session();
    const saved = settings.setGateway(payload.patch || {});
    if (sync) sync.schedulePush();
    return saved;
  });

  handle(ipcMain, 'validate:field', (payload) => {
    session();
    return validateField(payload);
  });

  handle(ipcMain, 'agents:list', async () => {
    session();
    const known = await knownModels();
    const detected = agents.detect();
    // Only ask an agent that is actually installed, and never wait long for it.
    const discovered = {};
    await Promise.all(
      detected
        .filter((entry) => entry.installed)
        .map(async (entry) => {
          discovered[entry.id] = await agents.discoverModels(entry.id, {
            timeoutMs: 12000,
            builtInModels: builtInFor(entry.id),
          });
        }),
    );
    return {
      agents: agents.listAgents(settings.get(), { knownModels: known, discovered, builtInModels: builtInCatalogue() }),
      detection: detected,
      models: known,
    };
  });

  handle(ipcMain, 'agents:add', async (payload) => {
    session();
    const known = await acceptableModels(payload.agentId);
    const profiles = agents.addProfile(settings.get(), payload.agentId, payload.patch || {}, { knownModels: known });
    const saved = settings.setAgentProfiles(profiles);
    if (sync) sync.schedulePush();
    return saved.agents;
  });

  handle(ipcMain, 'agents:update', async (payload) => {
    session();
    const known = await acceptableModels(payload.agentId);
    const profiles = agents.updateProfile(settings.get(), payload.agentId, payload.patch || {}, { knownModels: known });
    const saved = settings.setAgentProfiles(profiles);
    if (sync) sync.schedulePush();
    return saved.agents;
  });

  handle(ipcMain, 'agents:login', async (payload) => {
    session();
    const result = await agents.startLogin(payload.agentId);
    // Whatever the agent now reports is what gets kept, so a subscription's
    // models show up without anything being retyped.
    if (result.ok && result.models && result.models.length) {
      const known = await acceptableModels(payload.agentId);
      const profiles = agents.addProfile(settings.get(), payload.agentId, {}, { knownModels: [...known, ...result.models] });
      settings.setAgentProfiles(profiles);
      if (sync) sync.schedulePush();
    }
    return result;
  });

  handle(ipcMain, 'agents:remove', (payload) => {
    session();
    const profiles = agents.removeProfile(settings.get(), payload.agentId);
    const saved = settings.setAgentProfiles(profiles);
    if (sync) sync.schedulePush();
    return saved.agents;
  });

  handle(ipcMain, 'gateway:status', async () => {
    session();
    return gatewayStatus();
  });

  handle(ipcMain, 'gateway:models', async () => {
    session();
    const known = await knownModels();
    return { models: known, hidden: Object.keys(gateway.readBlocked()), endpoint: endpoint() };
  });

  handle(ipcMain, 'gateway:probe', async (payload) => {
    session();
    // Ask the gateway what it actually serves, so a model it will never accept
    // is refused here too. While the gateway is down the list is empty and only
    // the forbidden names are still turned away.
    const model = validators.cleanModel(payload.model, { knownModels: await knownModels() });
    if (!model) throw validators.badRequest('invalid_model', 'Pick a model to test.');
    return gateway.probeModel(model, { endpoint: endpoint() });
  });

  handle(ipcMain, 'gateway:repair', async (payload) => {
    session();
    return repairGateway(payload);
  });

  handle(ipcMain, 'gateway:hidden', (payload) => {
    session();
    if (payload.clear) gateway.clearBlocked();
    const current = settings.get();
    return { hidden: Object.keys(gateway.readBlocked()), remembered: current.gateway.hiddenModels || [] };
  });

  handle(ipcMain, 'updates:check', async (payload) => {
    session();
    if (!updateService) return { ok: false, state: 'unavailable', error: 'Updates are not available in this build.' };
    return updateService.check({ force: Boolean(payload.force) });
  });

  handle(ipcMain, 'updates:state', () => {
    session();
    return updateService ? updateService.snapshot() : { state: 'unavailable', currentVersion: appVersion };
  });

  handle(ipcMain, 'updates:install', async () => {
    session();
    if (!updateService) return { ok: false, state: 'unavailable', error: 'Updates are not available in this build.' };
    return updateService.install();
  });

  handle(ipcMain, 'sync:push', async () => {
    session();
    return sync ? sync.push() : { ok: false, error: 'No sync endpoint is set.' };
  });

  handle(ipcMain, 'sync:pull', async () => {
    session();
    return sync ? sync.pull() : { ok: false, error: 'No sync endpoint is set.' };
  });

  handle(ipcMain, 'sync:pushVault', async () => {
    session();
    return sync ? sync.pushVault() : { ok: false, error: 'No sync endpoint is set.' };
  });

  handle(ipcMain, 'sync:pullVault', async () => {
    session();
    return sync ? sync.pullVault() : { ok: false, error: 'No sync endpoint is set.' };
  });

  handle(ipcMain, 'sync:state', () => {
    session();
    return { endpoint: endpoint(), last: sync ? sync.last || null : null };
  });

  return { repairGateway, gatewayStatus };
}

module.exports = { registerIpc, result, failure };
