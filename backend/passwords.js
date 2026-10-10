const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const HASH_PREFIX = 'scrypt$';
const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

async function hashPassword(password) {
  const value = String(password || '');
  if (!value) throw new Error('Password cannot be empty.');
  const salt = crypto.randomBytes(16);
  const derivedKey = await scrypt(value, salt, KEY_LENGTH, SCRYPT_OPTIONS);
  return `${HASH_PREFIX}${salt.toString('hex')}$${derivedKey.toString('hex')}`;
}

async function verifyPassword(password, account = {}) {
  const value = String(password || '');
  const encodedHash = String(account.passwordHash || '');
  if (encodedHash.startsWith(HASH_PREFIX)) {
    const [saltHex, keyHex] = encodedHash.slice(HASH_PREFIX.length).split('$');
    if (!/^[a-f0-9]{32}$/i.test(saltHex || '') || !/^[a-f0-9]{128}$/i.test(keyHex || '')) {
      return { valid: false, needsUpgrade: false };
    }
    const expected = Buffer.from(keyHex, 'hex');
    const actual = await scrypt(value, Buffer.from(saltHex, 'hex'), expected.length, SCRYPT_OPTIONS);
    return {
      valid: actual.length === expected.length && crypto.timingSafeEqual(actual, expected),
      needsUpgrade: false
    };
  }

  const legacyPassword = account.password;
  const expected = Buffer.from(String(legacyPassword ?? ''), 'utf8');
  const actual = Buffer.from(value, 'utf8');
  const valid = expected.length > 0 && expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  return { valid, needsUpgrade: valid };
}

module.exports = { hashPassword, verifyPassword };