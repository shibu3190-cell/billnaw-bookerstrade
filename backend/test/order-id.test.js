const test = require('node:test');
const assert = require('node:assert/strict');
const { generateOrderId } = require('../order-id');

test('keeps a provided order id unchanged', () => {
  assert.equal(generateOrderId('INV-001'), 'INV-001');
});

test('creates a generated order id when the value is blank', () => {
  const result = generateOrderId('');
  assert.match(result, /^OD\d+/);
});

test('avoids a duplicate order id by generating a unique fallback', () => {
  const result = generateOrderId('OD-123', 'OD', ['OD-123']);
  assert.notEqual(result, 'OD-123');
  assert.match(result, /^OD/);
});
