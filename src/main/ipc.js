'use strict';

const providers = require('./providers');
const harnesses = require('./harnesses');

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

function registerIpc({ ipcMain, accounts, vault, settings, crypto, onSessionEnded = null }) {
  const session = () => accounts.requireSession();
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
    return vault.set(active.account.id, { providerId: provider.id, secret: payload.secret, label });
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
}

module.exports = { registerIpc, result, failure };
