const test = require('node:test');
const assert = require('node:assert/strict');
const { paginateRecords, normalizePageNumber, normalizePageSize } = require('../data-pagination');

test('normalizes invalid paging input', () => {
  assert.equal(normalizePageNumber('0'), 1);
  assert.equal(normalizePageNumber('abc'), 1);
  assert.equal(normalizePageSize('0', 50, 200), 50);
  assert.equal(normalizePageSize('1000', 50, 200), 200);
});

test('returns a bounded page of records', () => {
  const records = Array.from({ length: 25 }, (_, index) => ({ id: index + 1 }));
  const page = paginateRecords(records, 2, 10, { defaultPageSize: 10, maxPageSize: 20 });

  assert.equal(page.page, 2);
  assert.equal(page.pageSize, 10);
  assert.equal(page.totalCount, 25);
  assert.equal(page.totalPages, 3);
  assert.deepEqual(page.items.map(item => item.id), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  assert.equal(page.hasPreviousPage, true);
  assert.equal(page.hasNextPage, true);
});

test('keeps an empty result set stable', () => {
  const page = paginateRecords([], 3, 10);

  assert.equal(page.totalCount, 0);
  assert.equal(page.totalPages, 1);
  assert.deepEqual(page.items, []);
});
