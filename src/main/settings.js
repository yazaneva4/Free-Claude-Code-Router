'use strict';

const { ALL_PROVIDERS, getProvider, FORBIDDEN_PROVIDER_IDS } = require('./providers');

const SETTINGS_FILE = 'settings.json';
const SCHEMA_VERSION = 1;

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

class Settings {
  constructor({ store }) {
    this.store = store;
  }

  get() {
    return deepMerge(defaults(), this.store.read(SETTINGS_FILE, {}));
  }

  save(value) {
    const merged = deepMerge(defaults(), value);
    merged.version = SCHEMA_VERSION;
    this.store.write(SETTINGS_FILE, merged);
    return merged;
  }

  update(patch) {
    return this.save(deepMerge(this.get(), patch || {}));
  }

  setRouting(patch) {
    const current = this.get();
    const next = { ...current.routing, ...(patch || {}) };
    if (next.preferredProvider) {
      const provider = getProvider(next.preferredProvider);
      if (!provider) throw new Error('Unknown preferred provider.');
      if (FORBIDDEN_PROVIDER_IDS.has(String(next.preferredProvider).toLowerCase())) {
        throw new Error('That provider is not supported.');
      }
    }
    if (Array.isArray(next.fallbackOrder)) {
      next.fallbackOrder = next.fallbackOrder.filter((id) => Boolean(getProvider(id)));
    }
    if (next.modelByProvider && typeof next.modelByProvider === 'object') {
      for (const key of Object.keys(next.modelByProvider)) {
        if (!getProvider(key)) delete next.modelByProvider[key];
      }
    }
    return this.save({ ...current, routing: next });
  }

  setProvider(providerId, patch) {
    const provider = getProvider(providerId);
    if (!provider) throw new Error('Unknown provider.');
    const current = this.get();
    const existing = current.providers[provider.id] || {};
    return this.save({
      ...current,
      providers: { ...current.providers, [provider.id]: { ...existing, ...(patch || {}) } },
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
        [kind]: { ...current.integrations[kind], [name]: { ...group[name], ...(patch || {}) } },
      },
    });
  }
}

module.exports = { Settings, defaults, deepMerge, SETTINGS_FILE };
