const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv } = require('../../frontend/csv');

test('parses quoted commas, escaped quotes, and multiline fields', () => {
  const rows = parseCsv('Product ID,Product Name,Active\r\np-1,"Phone, Pro","true"\r\np-2,"Phone ""Max""\n256GB",false');
  assert.deepEqual(rows, [
    ['Product ID', 'Product Name', 'Active'],
    ['p-1', 'Phone, Pro', 'true'],
    ['p-2', 'Phone "Max"\n256GB', 'false']
  ]);
});

test('ignores blank rows and rejects unterminated quoted fields', () => {
  assert.deepEqual(parseCsv('id,name\n\n1,Device\n'), [['id', 'name'], ['1', 'Device']]);
  assert.deepEqual(parseCsv('\uFEFFid,name\n1,Device'), [['id', 'name'], ['1', 'Device']]);
  assert.throws(() => parseCsv('id,name\n1,"Device'), /unterminated quoted field/i);
});