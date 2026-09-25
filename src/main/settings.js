'use strict';

const {
  ALL_PROVIDERS,
  getProvider,
  isForbiddenModelId,
  isSupportedApi,
  SUPPORTED_APIS,
  FORBIDDEN_PROVIDER_IDS,
} = require('./providers');

const SETTINGS_FILE = 'settings.json';
const SCHEMA_VERSION = 1;

const PROVIDER_KEYS = new Set(['enabled', 'baseUrl', 'autoFetchModels', 'api']);
const INTEGRATION_KEYS = new Set(['enabled', 'model', 'baseUrl', 'configPath', 'api']);

function badRequest(code, message) {
  return Object.assign(new Error(message), { code });
}

function cleanBaseUrl(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw badRequest('invalid_base_url', 'An endpoint must be a full http or https URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw badRequest('invalid_base_url', 'An endpoint must use http or https.');
  }
  return text.replace(/\/+$/, '');
}

function cleanModel(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (text.length > 200) throw badRequest('invalid_model', 'That model name is too long.');
  if (isForbiddenModelId(text)) throw badRequest('forbidden_model', 'That model is not supported.');
  return text;
}

function cleanText(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (text.length > 512 || /[\r\n\0]/.test(text)) throw badRequest('invalid_value', `${label} looks invalid.`);
  return text;
}

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
      if (!isSupportedApi(value)) {
        throw badRequest('unsupported_api', `Unsupported API. Choose one of: ${SUPPORTED_APIS.join(', ')}.`);
      }
      out.api = String(value).trim();
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
      if (!isSupportedApi(value)) {
        throw badRequest('unsupported_api', `Unsupported API. Choose one of: ${SUPPORTED_APIS.join(', ')}.`);
      }
      out.api = String(value).trim();
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
      const models = {};
      for (const [key, value] of Object.entries(next.modelByProvider)) {
        if (!getProvider(key)) continue;
        models[key] = cleanModel(value);
      }
      next.modelByProvider = models;
    }
    return this.save({ ...current, routing: next });
  }

  setProvider(providerId, patch) {
    const provider = getProvider(providerId);
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
}

module.exports = {
  Settings,
  defaults,
  deepMerge,
  cleanProviderPatch,
  cleanIntegrationPatch,
  cleanBaseUrl,
  SETTINGS_FILE,
};
