const test = require('node:test');
const assert = require('node:assert/strict');
const { allocateDeliveryPackageIdentity, buildDeliveryPackageTag, dedupeDeliveryPackages } = require('../delivery-packages');

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

test('keeps day-wise and booker-wise sequence tags unique across orders and parcel retries', () => {
  const sameCustomer = 'cust-014';
  const sameDay = '2026-10-11';
  const first = buildDeliveryPackageTag({ customerId: sameCustomer, deliveryDate: sameDay, orderId: 'OD-101', sequence: 1, doNumber: 'DO1' });
  const second = buildDeliveryPackageTag({ customerId: sameCustomer, deliveryDate: sameDay, orderId: 'OD-202', sequence: 1, doNumber: 'DO1' });
  assert.notEqual(first, second, 'The identity tag must reflect both the booker and the day, not just the sequence number.');
});

test('deduplicates repeated parcel rows before export or display', () => {
  const rows = [
    { id: 'pkg-a', customerId: 'cust-014', sequence: 1, doNumber: 'DO1', delivery: { deliveryDate: '2026-10-11' } },
    { id: 'pkg-a', customerId: 'cust-014', sequence: 1, doNumber: 'DO1', delivery: { deliveryDate: '2026-10-11' } },
    { id: 'pkg-b', customerId: 'cust-014', sequence: 2, doNumber: 'DO2', delivery: { deliveryDate: '2026-10-11' } }
  ];
  const deduped = dedupeDeliveryPackages(rows);
  assert.equal(deduped.length, 2, 'Duplicate parcel rows must be collapsed to a single row per unique delivery identity.');
  assert.deepEqual(deduped.map(item => item.doNumber), ['DO1', 'DO2']);
});

test('does not collapse distinct unnumbered legacy packages', () => {
  const rows = [
    { id: 'pkg-a', orderId: 'OD-101', customerId: 'cust-014', delivery: { deliveryDate: '2026-10-11' } },
    { id: 'pkg-b', orderId: 'OD-101', customerId: 'cust-014', delivery: { deliveryDate: '2026-10-11' } }
  ];
  assert.equal(dedupeDeliveryPackages(rows).length, 2);
});

test('deduplicates a repeated DO from different source rows using order context', () => {
  const rows = [
    { id: 'sheet-copy-1', sequence: 1, doNumber: 'DO1', delivery: { deliveryDate: '2026-10-11' } },
    { id: 'sheet-copy-2', sequence: 1, doNumber: 'DO1', delivery: { deliveryDate: '2026-10-11' } },
    { id: 'second-package', sequence: 2, doNumber: 'DO2', delivery: { deliveryDate: '2026-10-11' } }
  ];
  assert.equal(dedupeDeliveryPackages(rows, { orderId: 'OD-101', customerId: 'cust-014' }).length, 2);
});

test('keeps day and booker tag in stable unique package identity', () => {
  const tag = buildDeliveryPackageTag({
    customerId: 'cust-014',
    deliveryDate: '2026-10-11T10:30:00.000Z',
    orderId: 'OD-101',
    sequence: 2
  });
  assert.equal(tag, 'day-2026-10-11|booker-cust-014|order-OD-101|do-2');
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

test('allocates continuous daily DO sequence per booker across multiple orders on the same day', () => {
  const existingBookerDayPackages = [
    { id: 'pkg-1', sequence: 1, doNumber: 'DO1', customerId: 'cust-1' },
    { id: 'pkg-2', sequence: 2, doNumber: 'DO2', customerId: 'cust-1' }
  ];
  // Booker 1 creates a parcel on their second order today:
  const newOrderPackages = [];
  const identity = allocateDeliveryPackageIdentity(newOrderPackages, 'pkg-3', 1, {
    orderId: 'OD-NEW',
    customerId: 'cust-1',
    existingBookerDayPackages
  });
  assert.equal(identity.sequence, 3);
  assert.equal(identity.doNumber, 'DO3');

  // Meanwhile Booker 2 starting today gets DO1:
  const booker2Packages = [];
  const identity2 = allocateDeliveryPackageIdentity(booker2Packages, 'pkg-b2-1', 1, {
    orderId: 'OD-B2',
    customerId: 'cust-2',
    existingBookerDayPackages: []
  });
  assert.equal(identity2.sequence, 1);
  assert.equal(identity2.doNumber, 'DO1');
});