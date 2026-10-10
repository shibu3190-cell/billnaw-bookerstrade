const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword } = require('../passwords');

test('hashes passwords with unique salts and verifies only the matching value', async () => {
  const firstHash = await hashPassword('isolated-password');
  const secondHash = await hashPassword('isolated-password');
  assert.notEqual(firstHash, secondHash);
  assert.deepEqual(await verifyPassword('isolated-password', { passwordHash: firstHash }), { valid: true, needsUpgrade: false });
  assert.deepEqual(await verifyPassword('incorrect', { passwordHash: firstHash }), { valid: false, needsUpgrade: false });
});

test('accepts legacy plaintext only as a migration candidate', async () => {
  assert.deepEqual(await verifyPassword('legacy-password', { password: 'legacy-password' }), { valid: true, needsUpgrade: true });
  assert.deepEqual(await verifyPassword('wrong-password', { password: 'legacy-password' }), { valid: false, needsUpgrade: false });
});

test('rejects empty passwords and malformed hashes', async () => {
  await assert.rejects(hashPassword(''), /cannot be empty/i);
  assert.deepEqual(await verifyPassword('x', { passwordHash: 'scrypt$bad$hash' }), { valid: false, needsUpgrade: false });
});