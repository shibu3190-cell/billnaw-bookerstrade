const test = require('node:test');
const assert = require('node:assert/strict');
const { allocateDeliveryPackageIdentity } = require('../delivery-packages');

test('numbers parcels within each parent order', () => {
  const firstOrder = [];
  const secondOrder = [];
  for (let index = 1; index <= 5; index++) {
    const identity = allocateDeliveryPackageIdentity(firstOrder, `pkg-${index}`, 5);
    firstOrder.push({ id: `pkg-${index}`, ...identity });
  }
  secondOrder.push({ id: 'other-order-package', ...allocateDeliveryPackageIdentity(secondOrder, 'other-order-package', 1) });

  assert.deepEqual(firstOrder.map(item => item.doNumber), ['DO1', 'DO2', 'DO3', 'DO4', 'DO5']);
  assert.equal(secondOrder[0].doNumber, 'DO1');
});

test('preserves a package tag when the same package is retried', () => {
  const packages = [{ id: 'pkg-a', sequence: 3, doNumber: 'DO3' }];
  assert.deepEqual(allocateDeliveryPackageIdentity(packages, 'pkg-a', 3), {
    sequence: 3,
    doNumber: 'DO3',
    existingIndex: 0
  });
});

test('backfills a missing legacy tag without colliding with existing tags', () => {
  const packages = [{ id: 'pkg-a', sequence: 1, doNumber: 'DO1' }, { id: 'pkg-b' }];
  assert.deepEqual(allocateDeliveryPackageIdentity(packages, 'pkg-b', 3), {
    sequence: 2,
    doNumber: 'DO2',
    existingIndex: 1
  });
});

test('rejects a new parcel once the order quantity is reached', () => {
  const packages = [{ id: 'pkg-a', sequence: 1, doNumber: 'DO1' }];
  assert.throws(() => allocateDeliveryPackageIdentity(packages, 'pkg-b', 1), {
    status: 409,
    message: 'All packages for this order already have delivery details.'
  });
});