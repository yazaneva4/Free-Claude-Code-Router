'use strict';

const { isPlainObject } = require('./store');

const {
  hashPassword,
  verifyPassword,
  passwordProblem,
  emailProblem,
  normalizeEmail,
  randomToken,
} = require('./crypto');

const ACCOUNTS_FILE = 'accounts.json';
const SESSION_FILE = 'session.json';
const DEVICE_FILE = 'device.json';
const SCHEMA_VERSION = 1;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const STORAGE_MODES = ['device', 'synced'];
const SYNC_STEPS = ['sync', 'harnesses'];

function deviceDefaults() {
  return { version: SCHEMA_VERSION, syncChoiceAskedAt: null, harnessChoiceAskedAt: null };
}

function publicAccount(account) {
  if (!account) return null;
  return {
    id: account.id,
    email: account.email,
    displayName: account.displayName,
    createdAt: account.createdAt,
    lastLoginAt: account.lastLoginAt || null,
    storageMode: account.storageMode,
    syncEnabled: Boolean(account.sync && account.sync.endpoint),
    syncEndpoint: (account.sync && account.sync.endpoint) || null,
    lastSyncedAt: (account.sync && account.sync.lastSyncedAt) || null,
  };
}

class AuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

class AccountService {
  constructor({ store, crypto, now = () => Date.now(), purge = null }) {
    this.store = store;
    this.crypto = crypto;
    this.now = now;
    this.purge = purge;
  }

  load() {
    const data = this.store.read(ACCOUNTS_FILE, { version: SCHEMA_VERSION, accounts: [] });
    if (!Array.isArray(data.accounts)) data.accounts = [];
    return data;
  }

  save(data) {
    data.version = SCHEMA_VERSION;
    this.store.write(ACCOUNTS_FILE, data);
  }

  list() {
    return this.load().accounts.map(publicAccount);
  }

  findByEmail(email) {
    const wanted = normalizeEmail(email);
    return this.load().accounts.find((a) => a.email === wanted) || null;
  }

  findById(id) {
    return this.load().accounts.find((a) => a.id === id) || null;
  }

  count() {
    return this.load().accounts.length;
  }

  signup({ email, password, displayName, storageMode = 'device' }) {
    const mailProblem = emailProblem(email);
    if (mailProblem) throw new AuthError('invalid_email', mailProblem);
    const passProblem = passwordProblem(password);
    if (passProblem) throw new AuthError('invalid_password', passProblem);
    if (!STORAGE_MODES.includes(storageMode)) {
      throw new AuthError('invalid_storage_mode', 'Storage mode must be device or synced.');
    }
    const name = String(displayName || '').trim();
    if (name.length < 1 || name.length > 80) {
      throw new AuthError('invalid_display_name', 'Display name must be 1 to 80 characters.');
    }

    const data = this.load();
    const normalized = normalizeEmail(email);
    if (data.accounts.some((a) => a.email === normalized)) {
      throw new AuthError('email_taken', 'An account with that email already exists.');
    }

    const account = {
      id: randomToken(12),
      email: normalized,
      displayName: name,
      password: hashPassword(password),
      storageMode,
      sync: { endpoint: null, lastSyncedAt: null },
      createdAt: this.now(),
      updatedAt: this.now(),
      lastLoginAt: null,
    };
    data.accounts.push(account);
    this.save(data);
    return this.startSession(account);
  }

  login({ email, password }) {
    const account = this.findByEmail(email);
    if (!account) throw new AuthError('invalid_credentials', 'Email or password is incorrect.');
    if (!verifyPassword(String(password || ''), account.password)) {
      throw new AuthError('invalid_credentials', 'Email or password is incorrect.');
    }
    const data = this.load();
    const stored = data.accounts.find((a) => a.id === account.id);
    stored.lastLoginAt = this.now();
    this.save(data);
    return this.startSession(stored);
  }

  startSession(account) {
    const token = randomToken(32);
    const issuedAt = this.now();
    this.store.write(SESSION_FILE, {
      version: SCHEMA_VERSION,
      accountId: account.id,
      token: this.crypto.encrypt(token),
      createdAt: issuedAt,
      expiresAt: issuedAt + SESSION_TTL_MS,
    });
    return { account: publicAccount(account), expiresAt: issuedAt + SESSION_TTL_MS };
  }

  session() {
    const raw = this.store.read(SESSION_FILE, null);
    if (!isPlainObject(raw) || !raw.accountId || !raw.token) return null;
    if (!raw.expiresAt || raw.expiresAt <= this.now()) {
      this.store.remove(SESSION_FILE);
      return null;
    }
    let token = null;
    try {
      token = this.crypto.decrypt(raw.token);
    } catch {
      this.store.remove(SESSION_FILE);
      return null;
    }
    if (!token) {
      this.store.remove(SESSION_FILE);
      return null;
    }
    const account = this.findById(raw.accountId);
    if (!account) {
      this.store.remove(SESSION_FILE);
      return null;
    }
    return { account: publicAccount(account), expiresAt: raw.expiresAt };
  }

  requireSession() {
    const session = this.session();
    if (!session) throw new AuthError('signed_out', 'You must be signed in.');
    return session;
  }

  logout() {
    this.store.remove(SESSION_FILE);
    return { signedOut: true };
  }

  changePassword({ currentPassword, newPassword }) {
    const session = this.requireSession();
    const account = this.findById(session.account.id);
    if (!verifyPassword(String(currentPassword || ''), account.password)) {
      throw new AuthError('invalid_credentials', 'Current password is incorrect.');
    }
    const problem = passwordProblem(newPassword);
    if (problem) throw new AuthError('invalid_password', problem);
    if (verifyPassword(String(newPassword), account.password)) {
      throw new AuthError('password_reused', 'New password must be different.');
    }
    const data = this.load();
    const stored = data.accounts.find((a) => a.id === account.id);
    stored.password = hashPassword(newPassword);
    stored.updatedAt = this.now();
    this.save(data);
    return { changed: true };
  }

  updateProfile({ displayName, storageMode, syncEndpoint }) {
    const session = this.requireSession();
    const data = this.load();
    const stored = data.accounts.find((a) => a.id === session.account.id);
    if (!stored) throw new AuthError('signed_out', 'You must be signed in.');

    if (displayName !== undefined) {
      const name = String(displayName || '').trim();
      if (name.length < 1 || name.length > 80) {
        throw new AuthError('invalid_display_name', 'Display name must be 1 to 80 characters.');
      }
      stored.displayName = name;
    }
    if (storageMode !== undefined) {
      if (!STORAGE_MODES.includes(storageMode)) {
        throw new AuthError('invalid_storage_mode', 'Storage mode must be device or synced.');
      }
      stored.storageMode = storageMode;
    }
    if (syncEndpoint !== undefined) {
      const endpoint = String(syncEndpoint || '').trim();
      if (endpoint && !/^https:\/\/[^\s]+$/i.test(endpoint)) {
        throw new AuthError('invalid_sync_endpoint', 'Sync endpoint must be an https:// URL.');
      }
      stored.sync = { ...(stored.sync || {}), endpoint: endpoint || null, lastSyncedAt: null };
    }
    stored.updatedAt = this.now();
    this.save(data);
    return { account: publicAccount(stored) };
  }

  deleteAccount() {
    const session = this.requireSession();
    const id = session.account.id;
    if (typeof this.purge !== 'function') {
      throw new AuthError('purge_unavailable', 'Refusing to delete an account while its stored data cannot be erased.');
    }
    this.purge(id);
    const data = this.load();
    const next = data.accounts.filter((a) => a.id !== id);
    if (next.length === data.accounts.length) throw new AuthError('not_found', 'Account not found.');
    this.save({ ...data, accounts: next });
    this.logout();
    return { deleted: true, accountId: id };
  }

  device() {
    const raw = this.store.read(DEVICE_FILE, deviceDefaults());
    return {
      version: SCHEMA_VERSION,
      syncChoiceAskedAt: raw.syncChoiceAskedAt || null,
      harnessChoiceAskedAt: raw.harnessChoiceAskedAt || null,
    };
  }

  saveDevice(patch) {
    const next = { ...this.device(), ...patch, version: SCHEMA_VERSION };
    this.store.write(DEVICE_FILE, next);
    return next;
  }

  onboarding() {
    const device = this.device();
    const nextStep = SYNC_STEPS.find((step) => {
      if (step === 'sync') return !device.syncChoiceAskedAt;
      return !device.harnessChoiceAskedAt;
    }) || null;
    return { ...device, nextStep, complete: nextStep === null };
  }

  requireOnboardingComplete() {
    const state = this.onboarding();
    if (!state.complete) {
      throw new AuthError('onboarding_incomplete', 'Finish setup before opening the router.');
    }
    return state;
  }

  completeSyncChoice({ storageMode, syncEndpoint }) {
    this.requireSession();
    const mode = String(storageMode || 'device');
    if (!STORAGE_MODES.includes(mode)) {
      throw new AuthError('invalid_storage_mode', 'Storage mode must be device or synced.');
    }
    const endpoint = String(syncEndpoint || '').trim();
    if (mode === 'synced' && !/^https:\/\/[^\s]+$/i.test(endpoint)) {
      throw new AuthError('invalid_sync_endpoint', 'Synced storage needs an https:// endpoint.');
    }
    this.updateProfile({ storageMode: mode, syncEndpoint: mode === 'synced' ? endpoint : '' });
    this.saveDevice({ syncChoiceAskedAt: this.now() });
    return { account: publicAccount(this.findById(this.requireSession().account.id)), onboarding: this.onboarding() };
  }

  completeHarnessChoice() {
    this.requireSession();
    this.saveDevice({ harnessChoiceAskedAt: this.now() });
    return this.onboarding();
  }
}

module.exports = {
  AccountService,
  AuthError,
  publicAccount,
  STORAGE_MODES,
  SESSION_TTL_MS,
  DEVICE_FILE,
  SYNC_STEPS,
};
