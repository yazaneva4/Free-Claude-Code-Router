'use strict';

const { isForbiddenModelId, isSupportedApi, SUPPORTED_APIS } = require('./providers');

function badRequest(code, message) {
  return Object.assign(new Error(message), { code });
}

function isLoopback(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

function cleanBaseUrl(value, options = {}) {
  if (value === null || value === undefined || value === '') return options.fallback === undefined ? null : options.fallback;
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
  if (options.allowOnlyLoopbackOrGateway) {
    const gateway = options.gatewayUrl || 'http://127.0.0.1:3456';
    let gatewayHost = null;
    try {
      gatewayHost = new URL(gateway).hostname;
    } catch {}
    if (!isLoopback(parsed.hostname) && parsed.hostname !== gatewayHost) {
      throw badRequest('invalid_base_url', 'An agent profile may only point at the local gateway or another local address.');
    }
  }
  return text.replace(/\/+$/, '');
}

function cleanModel(value, options = {}) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (text.length > 200) throw badRequest('invalid_model', 'That model name is too long.');
  if (isForbiddenModelId(text)) throw badRequest('forbidden_model', 'That model is not supported.');
  if (Array.isArray(options.knownModels) && options.knownModels.length && !options.knownModels.includes(text)) {
    throw badRequest('unknown_model', `${text} is not a model the gateway offers.`);
  }
  return text;
}

function cleanText(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (text.length > 512 || /[\r\n\0]/.test(text)) throw badRequest('invalid_value', `${label || 'That value'} looks invalid.`);
  return text;
}

function cleanApi(value) {
  if (!isSupportedApi(value)) {
    throw badRequest('unsupported_api', `Unsupported API. Choose one of: ${SUPPORTED_APIS.join(', ')}.`);
  }
  return String(value).trim();
}

module.exports = { badRequest, isLoopback, cleanBaseUrl, cleanModel, cleanText, cleanApi };
