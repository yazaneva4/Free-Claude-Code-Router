'use strict';

const { ALL_PROVIDERS, assertSupportedProvider, isSupportedApi, SUPPORTED_APIS, isForbiddenModelId } = require('./providers');
const { badRequest, cleanBaseUrl, cleanModel, cleanText, cleanApi } = require('./validators');
const { getAgent, validateBaseUrl, validateModel } = require('./agents');

const SETTINGS_FILE = 'settings.json';
const SCHEMA_VERSION = 1;

const PROVIDER_KEYS = new Set(['enabled', 'baseUrl', 'autoFetchModels', 'api']);
const INTEGRATION_KEYS = new Set(['enabled', 'model', 'baseUrl', 'configPath', 'api']);
const INTEGRATION_GROUPS = { app: ['claude', 'codex'], cli: ['claudeCode', 'codex', 'gemini'] };

function cleanProviderPatch(patch) {
  const out = {};
  for (const [key, value] of Object.entries(patch && typeof patch === 'object' ? patch : {})) {
    if (!PROVIDER_KEYS.has(key)) continue;
    if (key === 'enabled' || key === 'autoFetchModels') {
      if (typeof value !== 'boolean') throw badRequest('invalid_value', `${key} must be true or false.`);
      out[key] = value;
    } else if (key === 'baseUrl') {
      out.baseUrl = cleanBaseUrl(value);
    } else {
      out.api = cleanApi(value);
    }
  }
  return out;
}

function cleanIntegrationPatch(patch) {
  const out = {};
  for (const [key, value] of Object.entries(patch && typeof patch === 'object' ? patch : {})) {
    if (!INTEGRATION_KEYS.has(key)) continue;
    if (key === 'enabled') {
      if (typeof value !== 'boolean') throw badRequest('invalid_value', 'enabled must be true or false.');
      out.enabled = value;
    } else if (key === 'baseUrl') {
      out.baseUrl = cleanBaseUrl(value);
    } else if (key === 'model') {
      out.model = cleanModel(value);
    } else if (key === 'api') {
      out.api = cleanApi(value);
    } else {
      out.configPath = cleanText(value, 'A config path');
    }
  }
  return out;
}

function defaults() {
  const providers = {};
  for (const provider of ALL_PROVIDERS) {
    providers[provider.id] = {
      enabled: provider.kind === 'local',
      baseUrl: provider.baseUrl,
      autoFetchModels: true,
    };
  }
  return {
    version: SCHEMA_VERSION,
    routing: {
      preferredProvider: 'ollama',
      modelByProvider: {},
      fallbackOrder: ALL_PROVIDERS.filter((p) => p.kind === 'local').map((p) => p.id),
    },
    providers,
    integrations: {
      app: {
        claude: { enabled: false, model: null, baseUrl: null },
        codex: { enabled: false, model: null, baseUrl: null },
      },
      cli: {
        claudeCode: { enabled: false, model: null, baseUrl: null, configPath: '~/.claude-code-router' },
        codex: { enabled: false, model: null, baseUrl: null, configPath: '~/.codex/config.toml' },
        gemini: { enabled: false, model: null, baseUrl: null, configPath: '~/.gemini' },
      },
    },
    ui: { theme: 'system', reduceMotion: false },
    agents: { profiles: {} },
    gateway: { endpoint: 'http://127.0.0.1:3456', autoRepair: true, hiddenModels: [] },
  };
}

function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch.slice();
  if (patch && typeof patch === 'object') {
    const out = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      out[key] = key in base ? deepMerge(base[key], value) : value;
    }
    return out;
  }
  return patch === undefined ? base : patch;
}

function sanitizeProviders(value) {
  const input = value && typeof value === 'object' ? value : {};
  const out = {};
  for (const [providerId, patch] of Object.entries(input)) {
    const provider = assertSupportedProvider(providerId);
    out[provider.id] = { ...(out[provider.id] || {}), ...cleanProviderPatch(patch) };
  }
  return out;
}

function sanitizeIntegrations(value) {
  const input = value && typeof value === 'object' ? value : {};
  const out = {};
  for (const kind of Object.keys(INTEGRATION_GROUPS)) {
    const group = input[kind] && typeof input[kind] === 'object' ? input[kind] : {};
    out[kind] = {};
    for (const name of INTEGRATION_GROUPS[kind]) {
      const raw = group[name];
      if (raw === undefined) continue;
      const entry = raw && typeof raw === 'object' ? raw : {};
      out[kind][name] = cleanIntegrationPatch(entry);
    }
  }
  return out;
}

function sanitizeAgents(value) {
  const input = value && typeof value === 'object' && value.profiles && typeof value.profiles === 'object' ? value.profiles : {};
  const profiles = {};
  for (const [agentId, patch] of Object.entries(input)) {
    const agent = getAgent(agentId);
    if (!agent) throw badRequest('unknown_agent', `${agentId} is not an agent this router supports.`);
    const raw = patch && typeof patch === 'object' ? patch : {};
    const profile = {};
    if (raw.enabled !== undefined) {
      if (typeof raw.enabled !== 'boolean') throw badRequest('invalid_value', 'enabled must be true or false.');
      profile.enabled = raw.enabled;
    }
    if (raw.model !== undefined) profile.model = validateModel(raw.model);
    if (raw.baseUrl !== undefined) profile.baseUrl = validateBaseUrl(raw.baseUrl);
    // Written when the profile is added, and kept so a later save does not
    // quietly reset when the agent was first connected.
    if (typeof raw.addedAt === 'string' && raw.addedAt) profile.addedAt = raw.addedAt;
    if (typeof raw.label === 'string' && raw.label) profile.label = raw.label.slice(0, 60);
    profiles[agent.id] = profile;
  }
  return { profiles };
}

function sanitizeGateway(value) {
  const current = defaults().gateway;
  const input = value && typeof value === 'object' ? value : {};
  const next = { ...current };
  if (input.endpoint !== undefined) next.endpoint = cleanBaseUrl(input.endpoint, { fallback: current.endpoint });
  if (input.autoRepair !== undefined) {
    if (typeof input.autoRepair !== 'boolean') throw badRequest('invalid_value', 'autoRepair must be true or false.');
    next.autoRepair = input.autoRepair;
  }
  if (input.hiddenModels !== undefined) {
    if (!Array.isArray(input.hiddenModels)) throw badRequest('invalid_value', 'hiddenModels must be a list of model names.');
    next.hiddenModels = input.hiddenModels.map((model) => cleanModel(model)).filter(Boolean);
  }
  if (input.activeModel !== undefined) {
    next.activeModel = input.activeModel === null || input.activeModel === '' ? null : cleanModel(input.activeModel);
  }
  return next;
}

function sanitizeRouting(value) {
  const current = defaults().routing;
  const input = value && typeof value === 'object' ? value : {};
  const next = { ...current };
  if (input.preferredProvider !== undefined && input.preferredProvider !== null) {
    next.preferredProvider = assertSupportedProvider(input.preferredProvider).id;
  }
  if (input.fallbackOrder !== undefined) {
    if (!Array.isArray(input.fallbackOrder)) throw badRequest('invalid_value', 'fallbackOrder must be a list of providers.');
    next.fallbackOrder = input.fallbackOrder.map((id) => assertSupportedProvider(id).id);
  }
  if (input.modelByProvider !== undefined) {
    const source = input.modelByProvider && typeof input.modelByProvider === 'object' ? input.modelByProvider : {};
    const models = {};
    for (const [key, model] of Object.entries(source)) {
      models[assertSupportedProvider(key).id] = cleanModel(model);
    }
    next.modelByProvider = models;
  }
  return next;
}

/**
 * Every write goes through here, so a synced or hand-edited file cannot carry
 * in a provider or model the router refuses everywhere else.
 */
function sanitizeDocument(value) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    version: SCHEMA_VERSION,
    routing: sanitizeRouting(input.routing),
    providers: sanitizeProviders(input.providers),
    integrations: sanitizeIntegrations(input.integrations),
    ui: input.ui && typeof input.ui === 'object' ? input.ui : defaults().ui,
    agents: sanitizeAgents(input.agents),
    gateway: sanitizeGateway(input.gateway),
  };
}

class Settings {
  constructor({ store }) {
    this.store = store;
  }

  get() {
    return deepMerge(defaults(), this.store.read(SETTINGS_FILE, {}));
  }

  save(value) {
    const merged = sanitizeDocument(deepMerge(defaults(), value));
    this.store.write(SETTINGS_FILE, merged);
    return merged;
  }

  update(patch) {
    return this.save(deepMerge(this.get(), patch || {}));
  }

  setRouting(patch) {
    const current = this.get();
    const next = { ...current.routing, ...(patch || {}) };
    if (next.preferredProvider) assertSupportedProvider(next.preferredProvider);
    if (Array.isArray(next.fallbackOrder)) {
      for (const id of next.fallbackOrder) assertSupportedProvider(id);
    }
    if (next.modelByProvider && typeof next.modelByProvider === 'object') {
      const models = {};
      for (const [key, value] of Object.entries(next.modelByProvider)) {
        models[assertSupportedProvider(key).id] = cleanModel(value);
      }
      next.modelByProvider = models;
    }
    return this.save({ ...current, routing: next });
  }

  setProvider(providerId, patch) {
    const provider = assertSupportedProvider(providerId);
    if (!provider) throw new Error('Unknown provider.');
    const current = this.get();
    const existing = current.providers[provider.id] || {};
    const clean = cleanProviderPatch(patch);
    return this.save({
      ...current,
      providers: { ...current.providers, [provider.id]: { ...existing, ...clean } },
    });
  }

  setIntegration(kind, name, patch) {
    const current = this.get();
    const group = current.integrations && current.integrations[kind];
    if (!group || !Object.prototype.hasOwnProperty.call(group, name)) {
      throw new Error('Unknown integration.');
    }
    return this.save({
      ...current,
      integrations: {
        ...current.integrations,
        [kind]: { ...current.integrations[kind], [name]: { ...group[name], ...cleanIntegrationPatch(patch) } },
      },
    });
  }

  setAgentProfiles(profiles) {
    const current = this.get();
    return this.save({ ...current, agents: { ...current.agents, profiles } });
  }

  setGateway(patch) {
    const current = this.get();
    const next = { ...current.gateway };
    for (const [key, value] of Object.entries(patch && typeof patch === 'object' ? patch : {})) {
      if (key === 'endpoint') {
        next.endpoint = cleanBaseUrl(value, { fallback: next.endpoint });
      } else if (key === 'autoRepair') {
        if (typeof value !== 'boolean') throw badRequest('invalid_value', 'autoRepair must be true or false.');
        next.autoRepair = value;
      } else if (key === 'hiddenModels') {
        if (!Array.isArray(value)) throw badRequest('invalid_value', 'hiddenModels must be a list of model names.');
        next.hiddenModels = value.map((model) => cleanModel(model)).filter(Boolean);
      } else if (key === 'activeModel') {
        next.activeModel = value === null || value === '' ? null : cleanModel(value);
      }
    }
    return this.save({ ...current, gateway: next });
  }
}

module.exports = {
  Settings,
  defaults,
  deepMerge,
  cleanProviderPatch,
  cleanIntegrationPatch,
  sanitizeDocument,
  badRequest,
  cleanBaseUrl,
  cleanModel,
  cleanText,
  cleanApi,
  SETTINGS_FILE,
};
