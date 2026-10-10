const test = require('node:test');
const assert = require('node:assert/strict');
const { generateOrderId } = require('../order-id');

test('keeps a provided order id unchanged', () => {
  assert.equal(generateOrderId('INV-001'), 'INV-001');
});

test('creates a generated order id when the value is blank', () => {
  const result = generateOrderId('');
  assert.match(result, /^OD\d+/);
  assert.ok(result.length <= 12, 'generated order ids should stay compact');
});

test('keeps generated order ids within the compact 12-character limit', () => {
  const result = generateOrderId('', 'OD', ['OD123456789']);
  assert.ok(result.length <= 12, 'generated order ids should not exceed 12 characters');
  assert.match(result, /^OD/);
});

test('avoids a duplicate order id by generating a unique fallback', () => {
  const result = generateOrderId('OD-123', 'OD', ['OD-123']);
  assert.notEqual(result, 'OD-123');
  assert.match(result, /^OD/);
  assert.ok(result.length <= 12, 'fallback order ids should also stay compact');
});
