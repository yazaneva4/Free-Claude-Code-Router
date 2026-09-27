'use strict';

const { badRequest, cleanBaseUrl } = require('./validators');
const { accountHandle } = require('./crypto');

const DEBOUNCE_MS = 1500;
const TIMEOUT_MS = 10000;

function stateKey(endpoint) {
  return `sync:${endpoint}`;
}

class SyncWorker {
  constructor({ settings, vault = null, accounts = null, fetchImpl = fetch, now = () => Date.now(), debounceMs = DEBOUNCE_MS, resolveEndpoint = null } = {}) {
    this.settings = settings;
    this.vault = vault;
    this.accounts = accounts;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.debounceMs = debounceMs;
    this.resolveEndpoint = resolveEndpoint;
    this.timers = new Map();
    this.last = null;
  }

  endpoint() {
    if (typeof this.resolveEndpoint === 'function') return this.resolveEndpoint() || null;
    const stored = this.settings && this.settings.get ? this.settings.get() : null;
    return stored && stored.ui && stored.ui.syncEndpoint ? stored.ui.syncEndpoint : null;
  }

  payload() {
    const current = this.settings.get();
    return {
      version: 1,
      sentAt: new Date(this.now()).toISOString(),
      agents: current.agents || { profiles: {} },
      gateway: current.gateway || {},
      routing: current.routing || {},
      providers: current.providers || {},
      integrations: current.integrations || {},
    };
  }

  async push({ endpoint = this.endpoint() } = {}) {
    if (!endpoint) return { ok: false, skipped: true, reason: 'no_endpoint' };
    const target = cleanBaseUrl(endpoint);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(`${target}/ccr/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(this.payload()),
        signal: controller.signal,
      });
      const text = await response.text();
      this.last = { pushedAt: new Date(this.now()).toISOString(), ok: response.ok };
      if (!response.ok) {
        return { ok: false, endpoint: target, httpStatus: response.status, error: `The sync endpoint answered HTTP ${response.status}.`, at: new Date(this.now()).toISOString() };
      }
      let applied = null;
      try {
        applied = text ? JSON.parse(text) : null;
      } catch {}
      return { ok: true, endpoint: target, httpStatus: response.status, applied, at: new Date(this.now()).toISOString() };
    } catch (err) {
      return { ok: false, endpoint: target, error: `Could not reach the sync endpoint: ${err && err.message ? err.message : err}`, at: new Date(this.now()).toISOString() };
    } finally {
      clearTimeout(timer);
    }
  }

  async pull({ endpoint = this.endpoint() } = {}) {
    if (!endpoint) return { ok: false, skipped: true, reason: 'no_endpoint' };
    const target = cleanBaseUrl(endpoint);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(`${target}/ccr/settings`, { headers: { accept: 'application/json' }, signal: controller.signal });
      if (!response.ok) {
        return { ok: false, endpoint: target, httpStatus: response.status, error: `The sync endpoint answered HTTP ${response.status}.`, at: new Date(this.now()).toISOString() };
      }
      const body = await response.json();
      if (!body || typeof body !== 'object') throw badRequest('invalid_sync_payload', 'The sync endpoint did not return settings.');
      const current = this.settings.get();
      const next = {
        ...current,
        agents: body.agents && typeof body.agents === 'object' ? body.agents : current.agents,
        gateway: body.gateway && typeof body.gateway === 'object' ? { ...current.gateway, ...body.gateway } : current.gateway,
        routing: body.routing && typeof body.routing === 'object' ? { ...current.routing, ...body.routing } : current.routing,
        providers: body.providers && typeof body.providers === 'object' ? { ...current.providers, ...body.providers } : current.providers,
        integrations: body.integrations && typeof body.integrations === 'object' ? { ...current.integrations, ...body.integrations } : current.integrations,
      };
      this.settings.save(next);
      this.last = { pulledAt: new Date(this.now()).toISOString(), ok: true };
      return { ok: true, endpoint: target, appliedAt: body.sentAt || null, at: new Date(this.now()).toISOString() };
    } catch (err) {
      return { ok: false, endpoint: target, error: err && err.message ? err.message : String(err), at: new Date(this.now()).toISOString() };
    } finally {
      clearTimeout(timer);
    }
  }

/**
   * Credentials are only ever put on the wire sealed with the account password,
   * under a handle the endpoint cannot turn back into an address.
   */
  async pushVault({ endpoint = this.endpoint(), key = null, email = null, accountId = null } = {}) {
    if (!endpoint) return { ok: false, skipped: true, reason: 'no_endpoint' };
    const active = this.accounts && this.accounts.session();
    if (!active) return { ok: false, skipped: true, reason: 'signed_out' };
    const sealed = key || this.accounts.vaultKey();
    if (!sealed) return { ok: false, reason: 'no_key', error: 'Sign in again on this device to share API keys.' };
    const id = accountId || active.account.id;
    const mail = email || active.account.email;
    const envelope = this.vault.exportEnvelope(id, sealed, { email: mail, sentAt: new Date(this.now()).toISOString() });

    const target = `${cleanBaseUrl(endpoint)}/ccr/vault/${accountHandle(mail)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(envelope),
        signal: controller.signal,
      });
      this.last = { vaultPushedAt: new Date(this.now()).toISOString(), vaultCount: envelope.count, ok: response.ok };
      if (!response.ok) {
        return { ok: false, endpoint: target, httpStatus: response.status, error: `The sync endpoint answered HTTP ${response.status}.`, at: new Date(this.now()).toISOString() };
      }
      return { ok: true, endpoint: target, shared: envelope.count, at: new Date(this.now()).toISOString() };
    } catch (err) {
      return { ok: false, endpoint: target, error: `Could not reach the sync endpoint: ${err && err.message ? err.message : err}`, at: new Date(this.now()).toISOString() };
    } finally {
      clearTimeout(timer);
    }
  }

  async pullVault({ endpoint = this.endpoint(), key = null, email = null, accountId = null } = {}) {
    if (!endpoint) return { ok: false, skipped: true, reason: 'no_endpoint' };
    const active = this.accounts && this.accounts.session();
    if (!active) return { ok: false, skipped: true, reason: 'signed_out' };
    const sealed = key || this.accounts.vaultKey();
    if (!sealed) return { ok: false, reason: 'no_key', error: 'Sign in again on this device to pick up your API keys.' };
    const id = accountId || active.account.id;
    const mail = email || active.account.email;

    const target = `${cleanBaseUrl(endpoint)}/ccr/vault/${accountHandle(mail)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(target, { headers: { accept: 'application/json' }, signal: controller.signal });
      if (response.status === 404) {
        return { ok: true, imported: 0, nothingSaved: true, at: new Date(this.now()).toISOString() };
      }
      if (!response.ok) {
        return { ok: false, endpoint: target, httpStatus: response.status, error: `The sync endpoint answered HTTP ${response.status}.`, at: new Date(this.now()).toISOString() };
      }
      const envelope = await response.json();
      const result = this.vault.importEnvelope(id, sealed, envelope);
      this.last = { vaultPulledAt: new Date(this.now()).toISOString(), vaultImported: result.imported, ok: true };
      return { ok: true, endpoint: target, ...result };
    } catch (err) {
      // A sealed copy this device cannot open is a wrong account password, not
      // a network fault, and the reason is worth passing back to the UI.
      return {
        ok: false,
        endpoint: target,
        code: (err && err.code) || 'pull_failed',
        error: err && err.message ? err.message : String(err),
        at: new Date(this.now()).toISOString(),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  schedulePush(endpoint) {
    const key = stateKey(endpoint || this.endpoint() || 'none');
    if (this.timers.has(key)) clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.push({ endpoint }).catch(() => {});
      }, this.debounceMs),
    );
    if (typeof this.timers.get(key).unref === 'function') this.timers.get(key).unref();
    return { scheduled: true, key };
  }

  stop() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

module.exports = { SyncWorker, DEBOUNCE_MS, TIMEOUT_MS, stateKey };
