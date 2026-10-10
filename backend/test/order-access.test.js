const test = require('node:test');
const assert = require('node:assert/strict');
const { canAccessOrder, canUseProduct } = require('../order-access');

test('allows the owning Admin and Master Admin to access an order', () => {
  const order = { adminId: 'adm-001', customerId: 'booker-1' };
  assert.equal(canAccessOrder({ role: 'admin', adminId: 'ADM001' }, order), true);
  assert.equal(canAccessOrder({ role: 'admin', isMaster: true }, order), true);
});

test('allows a Booker only to access its own order within its Admin scope', () => {
  const order = { adminId: 'adm-001', customerId: 'booker-1' };
  assert.equal(canAccessOrder({ role: 'customer', adminId: 'adm001', customerId: 'booker-1' }, order), true);
  assert.equal(canAccessOrder({ role: 'customer', adminId: 'adm-002', customerId: 'booker-1' }, order), false);
  assert.equal(canAccessOrder({ role: 'customer', adminId: 'adm-001', customerId: 'booker-2' }, order), false);
});

test('denies missing actors, missing orders, and unrelated roles', () => {
  assert.equal(canAccessOrder(null, { adminId: 'adm-001' }), false);
  assert.equal(canAccessOrder({ role: 'admin', adminId: 'adm-001' }, null), false);
  assert.equal(canAccessOrder({ role: 'unknown' }, { adminId: 'adm-001' }), false);
});

test('allows active Admin-owned products only inside the owning Admin scope', () => {
  const product = { adminId: 'adm-001', active: true };
  assert.equal(canUseProduct({ role: 'customer', adminId: 'ADM001' }, product, 'adm-001'), true);
  assert.equal(canUseProduct({ role: 'admin', adminId: 'adm-002' }, product, 'adm-002'), false);
  assert.equal(canUseProduct({ role: 'admin', isMaster: true }, product, 'adm-001'), true);
  assert.equal(canUseProduct({ role: 'customer', adminId: 'adm-001' }, { ...product, active: false }, 'adm-001'), false);
});