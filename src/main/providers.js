'use strict';

const LOCAL_PROVIDERS = [
  {
    id: 'lmstudio',
    name: 'LM Studio',
    kind: 'local',
    baseUrl: 'http://127.0.0.1:1234/v1',
    api: 'openai_chat_completions',
    requiresCredential: false,
    credentialLabel: 'LM Studio API token',
    docs: 'http://127.0.0.1:1234',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    kind: 'local',
    baseUrl: 'http://127.0.0.1:11434/v1',
    api: 'openai_chat_completions',
    requiresCredential: false,
    credentialLabel: 'Ollama API key',
    docs: 'http://127.0.0.1:11434',
  },
  {
    id: 'llamacpp',
    name: 'llama.cpp',
    kind: 'local',
    baseUrl: 'http://127.0.0.1:8080/v1',
    api: 'openai_chat_completions',
    requiresCredential: false,
    credentialLabel: 'llama.cpp API key',
    docs: 'http://127.0.0.1:8080',
  },
];

const CLOUD_PROVIDERS = [
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', api: 'openai_chat_completions', requiresCredential: true, credentialLabel: 'OpenAI API key' },
  { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', api: 'anthropic_messages', requiresCredential: true, credentialLabel: 'Anthropic API key' },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', api: 'openai_chat_completions', requiresCredential: true, credentialLabel: 'OpenRouter API key' },
  { id: 'google', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', api: 'openai_chat_completions', requiresCredential: true, credentialLabel: 'Google API key' },
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', api: 'openai_chat_completions', requiresCredential: true, credentialLabel: 'Groq API key' },
  { id: 'mistral', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', api: 'openai_chat_completions', requiresCredential: true, credentialLabel: 'Mistral API key' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', api: 'openai_chat_completions', requiresCredential: true, credentialLabel: 'DeepSeek API key' },
  { id: 'xai', name: 'xAI', baseUrl: 'https://api.x.ai/v1', api: 'openai_chat_completions', requiresCredential: true, credentialLabel: 'xAI API key' },
  { id: 'together', name: 'Together AI', baseUrl: 'https://api.together.xyz/v1', api: 'openai_chat_completions', requiresCredential: true, credentialLabel: 'Together API key' },
];

const ALL_PROVIDERS = [...LOCAL_PROVIDERS, ...CLOUD_PROVIDERS];
const BY_ID = new Map(ALL_PROVIDERS.map((p) => [p.id, p]));

const FORBIDDEN_PROVIDER_IDS = new Set(['huggingface', 'hf', 'hugging-face']);
const FORBIDDEN_PROVIDER_PATTERN = /^(?:hugging[\s_.-]?face|hf)(?:[^a-z]|$)/;

function providerNamespace(providerId) {
  const id = String(providerId || '').trim().toLowerCase();
  return id.includes('/') ? id.slice(0, id.indexOf('/')) : id;
}

function isForbiddenProviderId(providerId) {
  return FORBIDDEN_PROVIDER_PATTERN.test(providerNamespace(providerId));
}

const SUPPORTED_APIS = ['openai_chat_completions', 'openai_responses', 'anthropic_messages'];
const SUPPORTED_API_SET = new Set(SUPPORTED_APIS);

function isSupportedApi(api) {
  return SUPPORTED_API_SET.has(String(api || '').trim());
}

function parseUrl(value) {
  try {
    return new URL(String(value));
  } catch {
    return null;
  }
}

function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

function usableBaseUrl(provider, baseUrl) {
  const wanted = parseUrl(baseUrl || provider.baseUrl);
  if (!wanted || (wanted.protocol !== 'http:' && wanted.protocol !== 'https:')) {
    throw new Error('Provider endpoints must be http or https URLs.');
  }
  const home = parseUrl(provider.baseUrl);
  if (!(home && home.origin === wanted.origin) && !isLoopbackHost(wanted.hostname)) {
    throw new Error('A stored credential is only sent to the provider endpoint or to a local address.');
  }
  return wanted.toString().replace(/\/+$/, '');
}

function getProvider(providerId) {
  const id = String(providerId || '').trim().toLowerCase();
  if (isForbiddenProviderId(id)) return null;
  return BY_ID.get(id) || null;
}

function assertSupportedProvider(providerId) {
  const id = String(providerId || '').trim().toLowerCase();
  if (isForbiddenProviderId(id)) {
    throw Object.assign(new Error(`${providerNamespace(id) || id} is not a supported provider. This router does not use Hugging Face.`), { code: 'unsupported_provider' });
  }
  const provider = BY_ID.get(id) || null;
  if (!provider) {
    throw Object.assign(new Error(`Unknown provider. Supported providers: ${ALL_PROVIDERS.map((p) => p.id).join(', ')}.`), { code: 'unknown_provider' });
  }
  return provider;
}

function isForbiddenModelId(modelId) {
  return isForbiddenProviderId(modelId);
}

function publicProvider(provider) {
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind || 'cloud',
    baseUrl: provider.baseUrl,
    api: provider.api,
    supportedApis: SUPPORTED_APIS.slice(),
    requiresCredential: Boolean(provider.requiresCredential),
    credentialLabel: provider.credentialLabel || 'API key',
    docs: provider.docs || null,
  };
}

function catalog() {
  return {
    apis: SUPPORTED_APIS.slice(),
    local: LOCAL_PROVIDERS.map(publicProvider),
    cloud: CLOUD_PROVIDERS.map(publicProvider),
  };
}

async function fetchJson(url, { headers = {}, timeoutMs = 6000, method = 'GET' } = {}) {
  const response = await fetch(url, {
    method,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { ok: response.ok, status: response.status, body, text };
}

function normalizeModels(body) {
  const raw = Array.isArray(body && body.data)
    ? body.data
    : Array.isArray(body && body.models)
      ? body.models
      : [];
  return raw
    .map((item) => {
      if (typeof item === 'string') return { id: item };
      if (!item || typeof item !== 'object') return null;
      const id = item.id || item.name || item.model || item.slug;
      if (!id) return null;
      return {
        id: String(id),
        ownedBy: item.owned_by || item.ownedBy || item.provider || null,
        contextWindow: item.context_length || item.contextWindow || item.max_context_length || null,
      };
    })
    .filter(Boolean)
    .filter((m) => !isForbiddenModelId(m.id));
}

async function listModels(providerId, { secret = null, baseUrl = null, timeoutMs = 6000 } = {}) {
  const provider = assertSupportedProvider(providerId);
  const base = usableBaseUrl(provider, baseUrl);
  const headers = { accept: 'application/json' };
  if (secret) headers.authorization = `Bearer ${secret}`;

  const primary = await fetchJson(`${base}/models`, { headers, timeoutMs });
  if (primary.ok) {
    const models = normalizeModels(primary.body);
    return { providerId: provider.id, reachable: true, models, via: 'openai' };
  }

  if (provider.id === 'ollama') {
    const root = base.replace(/\/v1$/, '');
    const tags = await fetchJson(`${root}/api/tags`, { timeoutMs });
    if (tags.ok) {
      const models = normalizeModels(tags.body);
      return { providerId: provider.id, reachable: true, models, via: 'ollama' };
    }
  }

  return {
    providerId: provider.id,
    reachable: false,
    models: [],
    status: primary.status,
    error: primary.text ? String(primary.text).slice(0, 200) : `HTTP ${primary.status}`,
  };
}

async function probe(providerId, options = {}) {
  try {
    const result = await listModels(providerId, options);
    return { ...result, error: result.reachable ? null : result.error || 'unreachable' };
  } catch (err) {
    return { providerId, reachable: false, models: [], error: String(err && err.message ? err.message : err) };
  }
}

module.exports = {
  LOCAL_PROVIDERS,
  CLOUD_PROVIDERS,
  ALL_PROVIDERS,
  FORBIDDEN_PROVIDER_IDS,
  SUPPORTED_APIS,
  isSupportedApi,
  getProvider,
  assertSupportedProvider,
  isForbiddenProviderId,
  providerNamespace,
  isForbiddenModelId,
  isLoopbackHost,
  usableBaseUrl,
  publicProvider,
  catalog,
  listModels,
  probe,
  normalizeModels,
};
