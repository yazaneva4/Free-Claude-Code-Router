'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, saltlen: 16 };
const SAFE_PREFIX = 'safe:';
const FILE_PREFIX = 'file:';

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(SCRYPT.saltlen);
  const hash = crypto.scryptSync(password.normalize('NFKC'), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 256 * 1024 * 1024,
  });
  return {
    algo: 'scrypt',
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    keylen: SCRYPT.keylen,
  };
}

function verifyPassword(password, record) {
  if (!record || record.algo !== 'scrypt') return false;
  const salt = Buffer.from(record.salt, 'base64');
  const expected = Buffer.from(record.hash, 'base64');
  let actual;
  try {
    actual = crypto.scryptSync(password.normalize('NFKC'), salt, expected.length, {
      N: record.N,
      r: record.r,
      p: record.p,
      maxmem: 256 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < 10) return 'Password must be at least 10 characters.';
  if (password.length > 512) return 'Password must be at most 512 characters.';
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) return 'Password must mix letters and numbers.';
  return null;
}

function emailProblem(email) {
  if (typeof email !== 'string') return 'Email is required.';
  const value = email.trim();
  if (value.length < 3 || value.length > 254) return 'Email looks invalid.';
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value)) return 'Email looks invalid.';
  return null;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function loadDeviceKey(keyFile) {
  try {
    const raw = fs.readFileSync(keyFile);
    const key = Buffer.from(raw.toString('base64'), 'base64');
    if (key.length === 32) return key;
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, key.toString('base64'), { mode: 0o600 });
  try {
    fs.chmodSync(keyFile, 0o600);
  } catch {}
  return key;
}

function createCrypto(options = {}) {
  const safeStorage = options.safeStorage || null;
  const keyFile = options.keyFile || null;
  const safeReady = Boolean(
    safeStorage &&
      typeof safeStorage.isEncryptionAvailable === 'function' &&
      safeStorage.isEncryptionAvailable() &&
      typeof safeStorage.encryptString === 'function',
  );

  let deviceKey = null;
  const getDeviceKey = () => {
    if (!keyFile) throw new Error('No key file configured for local encryption.');
    if (!deviceKey) deviceKey = loadDeviceKey(keyFile);
    return deviceKey;
  };

  const backend = safeReady ? 'os-keychain' : 'device-key';

  function encrypt(plaintext) {
    const value = String(plaintext);
    if (safeReady) return SAFE_PREFIX + safeStorage.encryptString(value).toString('base64');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getDeviceKey(), iv);
    const enc = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return FILE_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
  }

  function decrypt(payload) {
    const value = String(payload);
    if (value.startsWith(SAFE_PREFIX)) {
      if (!safeReady) throw new Error('This secret was encrypted by the OS keychain and cannot be read on this device.');
      return safeStorage.decryptString(Buffer.from(value.slice(SAFE_PREFIX.length), 'base64'));
    }
    if (value.startsWith(FILE_PREFIX)) {
      const raw = Buffer.from(value.slice(FILE_PREFIX.length), 'base64');
      if (raw.length < 29) throw new Error('Corrupt encrypted payload.');
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const data = raw.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', getDeviceKey(), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    }
    throw new Error('Unrecognized encrypted payload.');
  }

  function blindIndex(value) {
    const digest = crypto.createHash('sha256').update(String(value).normalize('NFKC').trim().toLowerCase()).digest();
    return digest.toString('base64url');
  }

  return { encrypt, decrypt, backend, blindIndex, randomToken };
}

/**
 * Cross-device credentials.
 *
 * The local vault is sealed with a key that never leaves the device. When the
 * account is set to sync, the same secrets are sealed a second time with a key
 * derived from the account password, so another device signed in with that same
 * password can open them and nothing else can. Only the ciphertext is ever sent.
 */
const PORTABLE_PREFIX = 'pv1:';

function newVaultSalt() {
  return crypto.randomBytes(SCRYPT.saltlen).toString('base64');
}

/**
 * The salt is fixed per account rather than per device, so two devices signed in
 * as the same person derive the same key from the same password and can open
 * each other's sealed credentials. The salt is not a secret; the password is.
 */
function deriveVaultSalt(email) {
  return crypto
    .createHash('sha256')
    .update(`ccr-vault-salt:v1:${String(email || '').trim().toLowerCase()}`)
    .digest('base64')
    .slice(0, 24);
}

function deriveVaultKey(password, salt) {
  const saltBytes = Buffer.from(String(salt || ''), 'base64');
  if (saltBytes.length < 8) throw new Error('A vault salt is missing or malformed.');
  return crypto.scryptSync(String(password).normalize('NFKC'), saltBytes, 32, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 256 * 1024 * 1024,
  });
}

function encryptPortable(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PORTABLE_PREFIX}${[iv, tag, body].map((part) => part.toString('base64url')).join('.')}`;
}

function decryptPortable(key, payload) {
  const text = String(payload || '');
  if (!text.startsWith(PORTABLE_PREFIX)) throw new Error('That is not a synced credential.');
  const parts = text.slice(PORTABLE_PREFIX.length).split('.');
  if (parts.length !== 3) throw new Error('That synced credential is damaged.');
  const [iv, tag, body] = parts.map((part) => Buffer.from(part, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

/** A stable, non-reversible handle so the endpoint never sees an address. */
function accountHandle(email) {
  return crypto.createHash('sha256').update(String(email || '').trim().toLowerCase()).digest('base64url').slice(0, 32);
}

module.exports = {
  createCrypto,
  hashPassword,
  verifyPassword,
  newVaultSalt,
  deriveVaultSalt,
  deriveVaultKey,
  encryptPortable,
  decryptPortable,
  accountHandle,
  PORTABLE_PREFIX,
  passwordProblem,
  emailProblem,
  normalizeEmail,
  randomToken,
  SCRYPT,
};
