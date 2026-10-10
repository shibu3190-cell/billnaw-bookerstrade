const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_TEST_MODE = 'isolated';
process.env.PORT = '0';

const app = require('../server');
const { credentials, db, sheets } = require('../testing/isolated-environment');

let server;
let baseUrl;

test('isolated account and product API workflows use fake persistence only', async t => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

  async function call(path, { body = {}, method = 'POST', sessionToken = '', status = 200 } = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': credentials.apiToken,
        ...(sessionToken ? { 'x-session-token': sessionToken } : {})
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) })
    });
    const responseText = await response.text();
    let result;
    try {
      result = JSON.parse(responseText);
    } catch {
      throw new Error(`${path} returned non-JSON (${response.status}): ${responseText.slice(0, 120)}`);
    }
    assert.equal(response.status, status, `${path}: ${JSON.stringify(result)}`);
    return result;
  }

  async function login(username, password, status = 200) {
    const result = await call('/auth/login', { body: { username, password }, status });
    return result.sessionToken;
  }

  const masterSession = await login(credentials.master.username, credentials.master.password);
  const adminSession = await login(credentials.admin.username, credentials.admin.password);
  const bookerSession = await login(credentials.booker.username, credentials.booker.password);

  const migratedAdmin = (await db.collection('admins').doc(credentials.admin.id).get()).data();
  const migratedBooker = (await db.collection('customers').doc(credentials.booker.id).get()).data();
  assert.equal(migratedAdmin.password, '');
  assert.match(migratedAdmin.passwordHash, /^scrypt\$/);
  assert.equal(migratedBooker.password, '');
  assert.match(migratedBooker.passwordHash, /^scrypt\$/);
  const adminSheetRows = (await sheets.spreadsheets.values.get({ spreadsheetId: 'isolated-test-spreadsheet', range: 'Admins!A:Z' })).data.values;
  const bookerSheetRows = (await sheets.spreadsheets.values.get({ spreadsheetId: 'isolated-test-spreadsheet', range: 'Customers!A:Z' })).data.values;
  assert.equal(adminSheetRows[1][3], '');
  assert.match(adminSheetRows[1][7], /^scrypt\$/);
  assert.equal(bookerSheetRows[1][3], '');
  assert.match(bookerSheetRows[1][9], /^scrypt\$/);

  await call('/admin/status', {
    body: { adminId: credentials.admin.id, active: false },
    sessionToken: adminSession,
    status: 403
  });

  await call('/customers/create', {
    body: {
      customer: {
        id: 'test-booker-duplicate',
        username: credentials.booker.username.toUpperCase(),
        name: 'Duplicate Booker',
        password: 'unused-test-password',
        adminId: credentials.admin.id
      }
    },
    sessionToken: adminSession,
    status: 409
  });

  const createdAdmin = await call('/admin/create', {
    body: { admin: { adminId: 'test-created-admin', name: 'Created Admin', username: 'created-admin', password: 'created-admin-password', active: true } },
    sessionToken: masterSession
  });
  assert.equal(createdAdmin.admin.password, undefined);
  assert.equal(createdAdmin.admin.passwordHash, undefined);
  const createdAdminRecord = (await db.collection('admins').doc('test-created-admin').get()).data();
  assert.equal(createdAdminRecord.password, '');
  assert.match(createdAdminRecord.passwordHash, /^scrypt\$/);

  await call('/customers/create', {
    body: { customer: { id: 'test-created-booker', username: 'created-booker', name: 'Created Booker', password: 'created-booker-password', adminId: credentials.admin.id } },
    sessionToken: adminSession
  });
  const createdBookerRecord = (await db.collection('customers').doc('test-created-booker').get()).data();
  assert.equal(createdBookerRecord.password, '');
  assert.match(createdBookerRecord.passwordHash, /^scrypt\$/);

  const cloudExport = await call('/admin/data/export?page=1&pageSize=50', { method: 'GET', sessionToken: masterSession });
  for (const account of [...cloudExport.data.admins, ...cloudExport.data.customers]) {
    assert.equal(account.password, undefined);
    assert.equal(account.passwordHash, undefined);
  }
  const sheetExport = await call('/admin/sheets/data?page=1&pageSize=50', { method: 'GET', sessionToken: masterSession });
  for (const account of [...sheetExport.data.admins, ...sheetExport.data.customers]) {
    assert.equal(account.Password, undefined);
    assert.equal(account['Password Hash'], undefined);
  }

  await call('/products/sync', {
    body: { product: { id: 'test-product-02', name: 'Test Admin Two Product', targetPrice: 100, commission: 10, adminId: credentials.secondAdmin.id, active: true } },
    sessionToken: masterSession
  });
  await call('/products/sync', {
    body: { product: { id: 'test-product-02', name: 'Unauthorized Edit', targetPrice: 100, commission: 10, adminId: credentials.admin.id, active: true } },
    sessionToken: adminSession,
    status: 403
  });

  await call('/products/sync', {
    body: { product: { id: 'test-product-inactive', name: 'Inactive Test Product', targetPrice: 100, commission: 10, adminId: credentials.admin.id, active: false } },
    sessionToken: masterSession
  });
  await call('/orders/create', {
    body: { order: { id: 'test-order-inactive-product', productId: 'test-product-inactive', customerId: credentials.booker.id, adminId: credentials.admin.id, productModel: 'Inactive Test Product', amountPaid: 100, quantity: 1 } },
    sessionToken: adminSession,
    status: 409
  });
  await call('/orders/create', {
    body: { order: { id: 'test-order-custom-name-matched', customerId: credentials.booker.id, adminId: credentials.admin.id, productModel: 'Test Phone Pro', amountPaid: 1000, quantity: 1 } },
    sessionToken: adminSession,
    status: 400
  });
  await call('/orders/create', {
    body: { order: { id: 'test-order-active-product', productId: 'test-product-01', customerId: credentials.booker.id, adminId: credentials.admin.id, productModel: 'Test Phone Pro', amountPaid: 1000, quantity: 1 } },
    sessionToken: adminSession
  });

  await call('/customers/status', {
    body: { customerId: credentials.booker.id, active: false },
    sessionToken: masterSession
  });
  await call('/admin/data/export?page=1&pageSize=50', { method: 'GET', sessionToken: bookerSession, status: 401 });
  await call('/customers/status', {
    body: { customerId: credentials.booker.id, active: true },
    sessionToken: masterSession
  });
  await call('/admin/data/export?page=1&pageSize=50', { method: 'GET', sessionToken: bookerSession, status: 401 });
  const reactivatedBookerSession = await login(credentials.booker.username, credentials.booker.password);
  const exportResponse = await fetch(`${baseUrl}/admin/data/export?page=1&pageSize=50`, {
    headers: { 'x-api-key': credentials.apiToken, 'x-session-token': reactivatedBookerSession }
  });
  assert.equal(exportResponse.status, 200);

  for (let attempt = 0; attempt < 16; attempt += 1) {
    await call('/auth/login', { body: { username: `unknown-${attempt}`, password: 'wrong' }, status: 401 });
  }
  await call('/auth/login', { body: { username: 'another-unknown', password: 'wrong' }, status: 429 });
});