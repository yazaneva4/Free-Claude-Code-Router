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

module.exports = {
  createCrypto,
  hashPassword,
  verifyPassword,
  passwordProblem,
  emailProblem,
  normalizeEmail,
  randomToken,
  SCRYPT,
};
