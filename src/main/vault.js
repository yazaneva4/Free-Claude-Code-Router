'use strict';

const { randomToken, encryptPortable, decryptPortable } = require('./crypto');

const VAULT_FILE = 'vault.json';
const WIRE_VERSION = 1;
const SCHEMA_VERSION = 1;

class VaultError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}

function publicEntry(entry) {
  if (!entry) return null;
  return {
    id: entry.id,
    providerId: entry.providerId,
    label: entry.label,
    baseUrl: entry.baseUrl || null,
    accountRef: entry.accountRef || null,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    hasSecret: Boolean(entry.secret),
  };
}

class Vault {
  constructor({ store, crypto, now = () => Date.now() }) {
    this.store = store;
    this.crypto = crypto;
    this.now = now;
  }

  load() {
    const data = this.store.read(VAULT_FILE, { version: SCHEMA_VERSION, credentials: [] });
    if (!Array.isArray(data.credentials)) data.credentials = [];
    return data;
  }

  save(data) {
    data.version = SCHEMA_VERSION;
    this.store.write(VAULT_FILE, data);
  }

  list(accountId) {
    return this.load()
      .credentials.filter((c) => c.accountId === accountId)
      .map(publicEntry);
  }

  find(accountId, providerId) {
    return this.load().credentials.find((c) => c.accountId === accountId && c.providerId === providerId) || null;
  }

  has(accountId, providerId) {
    return Boolean(this.find(accountId, providerId));
  }

  set(accountId, { providerId, secret, label, baseUrl, accountRef }) {
    if (!providerId) throw new VaultError('invalid_provider', 'Provider id is required.');
    const data = this.load();
    const index = data.credentials.findIndex((c) => c.accountId === accountId && c.providerId === providerId);
    const stamp = this.now();

    if (index >= 0) {
      const current = data.credentials[index];
      data.credentials[index] = {
        ...current,
        label: label !== undefined ? String(label || current.label || providerId) : current.label,
        baseUrl: baseUrl !== undefined ? String(baseUrl || '') || null : current.baseUrl,
        accountRef: accountRef !== undefined ? String(accountRef || '') || null : current.accountRef,
        secret: this.crypto.encrypt(String(secret)),
        updatedAt: stamp,
      };
      this.save(data);
      return { entry: publicEntry(data.credentials[index]), replaced: true };
    }

    const entry = {
      id: randomToken(12),
      accountId,
      providerId: String(providerId),
      label: String(label || providerId),
      baseUrl: baseUrl ? String(baseUrl) : null,
      accountRef: accountRef ? String(accountRef) : null,
      secret: this.crypto.encrypt(String(secret)),
      createdAt: stamp,
      updatedAt: stamp,
    };
    data.credentials.push(entry);
    this.save(data);
    return { entry: publicEntry(entry), replaced: false };
  }

  secret(accountId, providerId) {
    const entry = this.find(accountId, providerId);
    if (!entry || !entry.secret) return null;
    return this.crypto.decrypt(entry.secret);
  }

  delete(accountId, providerId) {
    const data = this.load();
    const next = data.credentials.filter((c) => !(c.accountId === accountId && c.providerId === providerId));
    if (next.length === data.credentials.length) {
      throw new VaultError('not_found', 'No stored credential for that provider.');
    }
    this.save({ ...data, credentials: next });
    return { deleted: true, providerId };
  }

  /**
   * The whole credential set for one account, as plaintext. Only ever held in
   * memory, and only ever encrypted before it leaves the device.
   */
    exportPlaintext(accountId) {
    return this.load()
      .credentials.filter((c) => c.accountId === accountId)
      .map((c) => ({
        providerId: c.providerId,
        label: c.label,
        baseUrl: c.baseUrl || null,
        accountRef: c.accountRef || null,
        secret: c.secret ? this.crypto.decrypt(c.secret) : null,
        updatedAt: c.updatedAt,
      }))
      .filter((entry) => entry.secret);
  }

  /** Seals the credential set with the password-derived key, ready to be sent. */
    exportEnvelope(accountId, key, { email, sentAt = null } = {}) {
    const entries = this.exportPlaintext(accountId);
    return {
      version: WIRE_VERSION,
      handle: require('./crypto').accountHandle(email),
      updatedAt: sentAt || new Date(this.now()).toISOString(),
      credentials: encryptPortable(key, JSON.stringify(entries)),
      count: entries.length,
    };
  }

  /** Opens an envelope from another device and stores what is inside locally. */
    importEnvelope(accountId, key, envelope) {
    if (!envelope || typeof envelope !== 'object') {
      throw new VaultError('invalid_envelope', 'The synced credentials could not be read.');
    }
    if (envelope.version !== WIRE_VERSION || typeof envelope.credentials !== 'string') {
      throw new VaultError('invalid_envelope', 'Those synced credentials were written by a different version of this app.');
    }
    let entries;
    try {
      entries = JSON.parse(decryptPortable(key, envelope.credentials));
    } catch {
      throw new VaultError(
        'wrong_password',
        'Those synced credentials could not be opened. They are sealed with the password of the account that saved them.',
      );
    }
    if (!Array.isArray(entries)) throw new VaultError('invalid_envelope', 'Those synced credentials are not a list.');

    const stamp = this.now();
    let imported = 0;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      if (!entry.providerId || typeof entry.secret !== 'string' || !entry.secret) continue;
      // A refused provider is never imported, whatever the envelope claims.
      let providerId;
      try {
        providerId = require('./providers').assertSupportedProvider(entry.providerId).id;
      } catch {
        continue;
      }
      this.set(accountId, {
        providerId,
        secret: entry.secret,
        label: typeof entry.label === 'string' ? entry.label.slice(0, 60) : providerId,
        baseUrl: typeof entry.baseUrl === 'string' ? entry.baseUrl : null,
        accountRef: typeof entry.accountRef === 'string' ? entry.accountRef : null,
      });
      imported += 1;
    }
    return { imported, offered: entries.length, at: new Date(stamp).toISOString() };
  }

  deleteAllForAccount(accountId) {
    const data = this.load();
    const next = data.credentials.filter((c) => c.accountId !== accountId);
    const removed = data.credentials.length - next.length;
    this.save({ ...data, credentials: next });
    return { removed };
  }
}

module.exports = { Vault, VaultError, publicEntry };
