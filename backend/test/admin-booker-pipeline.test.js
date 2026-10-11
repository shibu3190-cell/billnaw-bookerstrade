const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_TEST_MODE = 'isolated';
process.env.PORT = '0';

const app = require('../server');
const { credentials, db, sheets } = require('../testing/isolated-environment');

let server;
let baseUrl;

test('Complete Admin and Booker multi-role pipeline and isolation', async t => {
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
    return result;
  }

  // 1. Multi-role Authentication & Session Verification
  const masterAuth = await login(credentials.master.username, credentials.master.password);
  assert.equal(masterAuth.user.role, 'admin');
  assert.equal(masterAuth.user.isMaster, true);
  const masterSession = masterAuth.sessionToken;

  const admin1Auth = await login(credentials.admin.username, credentials.admin.password);
  assert.equal(admin1Auth.user.role, 'admin');
  assert.equal(admin1Auth.user.isMaster, false);
  assert.equal(admin1Auth.user.adminId, credentials.admin.id);
  const admin1Session = admin1Auth.sessionToken;

  const admin2Auth = await login(credentials.secondAdmin.username, credentials.secondAdmin.password);
  assert.equal(admin2Auth.user.role, 'admin');
  assert.equal(admin2Auth.user.isMaster, false);
  assert.equal(admin2Auth.user.adminId, credentials.secondAdmin.id);
  const admin2Session = admin2Auth.sessionToken;

  const bookerAuth = await login(credentials.booker.username, credentials.booker.password);
  assert.equal(bookerAuth.user.role, 'customer');
  assert.equal(bookerAuth.user.isMaster, false);
  assert.equal(bookerAuth.user.customerId, credentials.booker.id);
  assert.equal(bookerAuth.user.username, credentials.booker.username);
  assert.equal(bookerAuth.user.adminId, credentials.admin.id);
  const bookerSession = bookerAuth.sessionToken;

  // 2. Product Catalog Scoping
  await call('/products/sync', {
    body: {
      product: {
        id: 'test-admin1-prod',
        name: 'Admin 1 Exclusive Product',
        targetPrice: 1500,
        commission: 150,
        adminId: credentials.admin.id,
        active: true
      }
    },
    sessionToken: admin1Session
  });

  // Admin 2 cannot tamper with Admin 1 product
  await call('/products/sync', {
    body: {
      product: {
        id: 'test-admin1-prod',
        name: 'Hijacked Product',
        targetPrice: 999,
        commission: 0,
        adminId: credentials.secondAdmin.id,
        active: true
      }
    },
    sessionToken: admin2Session,
    status: 403
  });

  // 3. Booker Creation Scoping
  await call('/customers/create', {
    body: {
      customer: {
        id: 'test-sub-booker-2',
        username: 'sub-booker-2',
        name: 'Sub Booker Two',
        password: 'sub-booker-2-password',
        adminId: credentials.secondAdmin.id
      }
    },
    sessionToken: admin2Session
  });

  // Admin 1 cannot change status of Admin 2's booker
  await call('/customers/status', {
    body: { customerId: 'test-sub-booker-2', active: false },
    sessionToken: admin1Session,
    status: 403
  });

  // 4. Booking Creation Pipeline (Booker -> Admin Approval)
  const orderId = 'pipeline-order-01';
  // Booker creates booking for active product test-product-01
  await call('/orders/create', {
    body: {
      order: {
        id: orderId,
        productId: 'test-product-01',
        productModel: 'Test Phone Pro',
        customerId: credentials.booker.id,
        adminId: credentials.admin.id,
        amountPaid: 1000,
        payableAmount: 1100,
        quantity: 2,
        status: 'Pending Approval'
      }
    },
    sessionToken: bookerSession
  });

  // Booker cannot book an uncatalogued or wrong admin's product
  await call('/orders/create', {
    body: {
      order: {
        id: 'pipeline-order-invalid',
        productId: 'test-admin1-prod',
        productModel: 'Admin 1 Exclusive Product',
        customerId: 'test-sub-booker-2',
        adminId: credentials.secondAdmin.id,
        amountPaid: 1500,
        quantity: 1
      }
    },
    sessionToken: admin1Session,
    status: 403
  });

  // Admin 2 cannot approve or change Booker 1's order
  await call('/orders/approve', {
    body: { orderId },
    sessionToken: admin2Session,
    status: 403
  });

  // Admin 1 approves Booker 1's order
  const approveRes = await call('/orders/approve', {
    body: { orderId },
    sessionToken: admin1Session
  });
  assert.equal(approveRes.status, 'Booked');

  // 5. Multi-Package Delivery & DO Allocation
  // 1x1 transparent PNG in base64 data URL format
  const dummyInvoiceData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAAElFTkSuQmCC';

  const deliveryData1 = {
    platform: 'Amazon',
    recipientName: 'Recipient One',
    mobile: '9876543210',
    tracking: 'TRK-001',
    otp: '1234',
    pincode: '560001',
    submitted: true,
    deliveryDate: '2026-10-11'
  };

  const gstDetails1 = {
    included: true,
    shopName: 'Test Electronics',
    gstNumber: '29ABCDE1234F1Z5',
    baseAmount: 1000,
    gstRate: 18,
    gstAmount: 180,
    totalAmount: 1180,
    fileName: 'test-invoice-1.png',
    contentType: 'image/png',
    fileData: dummyInvoiceData
  };

  const pkg1Res = await call('/orders/delivery', {
    body: {
      orderId,
      delivery: deliveryData1,
      packageEntry: {
        id: 'pkg-pipeline-1',
        delivery: deliveryData1,
        gstDetails: gstDetails1,
        submittedAt: '2026-10-11T12:00:00.000Z'
      }
    },
    sessionToken: bookerSession
  });

  assert.equal(pkg1Res.doNumber, 'DO1');
  const fileId1 = pkg1Res.file?.fileId;
  assert.ok(fileId1, 'Expected a generated fileId for package 1 GST invoice');

  // Submit Parcel 2
  const deliveryData2 = {
    platform: 'Amazon',
    recipientName: 'Recipient Two',
    mobile: '9876543211',
    tracking: 'TRK-002',
    otp: '5678',
    pincode: '560002',
    submitted: true,
    deliveryDate: '2026-10-11'
  };

  const pkg2Res = await call('/orders/delivery', {
    body: {
      orderId,
      delivery: deliveryData2,
      packageEntry: {
        id: 'pkg-pipeline-2',
        delivery: deliveryData2,
        submittedAt: '2026-10-11T13:00:00.000Z'
      }
    },
    sessionToken: bookerSession
  });

  assert.equal(pkg2Res.doNumber, 'DO2');

  // Submit Parcel 3 (exceeds order quantity of 2) -> must fail 409
  await call('/orders/delivery', {
    body: {
      orderId,
      delivery: deliveryData2,
      packageEntry: {
        id: 'pkg-pipeline-3',
        delivery: deliveryData2,
        submittedAt: '2026-10-11T14:00:00.000Z'
      }
    },
    sessionToken: bookerSession,
    status: 409
  });

  // 6. GST Invoice Access Isolation
  // Booker 1 can access invoice
  const bookerInvoiceRes = await fetch(`${baseUrl}/invoices/${encodeURIComponent(fileId1)}`, {
    headers: { 'x-api-key': credentials.apiToken, 'x-session-token': bookerSession }
  });
  assert.equal(bookerInvoiceRes.status, 200);

  // Admin 1 (owning admin) can access invoice
  const admin1InvoiceRes = await fetch(`${baseUrl}/invoices/${encodeURIComponent(fileId1)}`, {
    headers: { 'x-api-key': credentials.apiToken, 'x-session-token': admin1Session }
  });
  assert.equal(admin1InvoiceRes.status, 200);

  // Master Admin can access invoice
  const masterInvoiceRes = await fetch(`${baseUrl}/invoices/${encodeURIComponent(fileId1)}`, {
    headers: { 'x-api-key': credentials.apiToken, 'x-session-token': masterSession }
  });
  assert.equal(masterInvoiceRes.status, 200);

  // Admin 2 CANNOT access Booker 1's invoice (returns 403)
  const admin2InvoiceRes = await fetch(`${baseUrl}/invoices/${encodeURIComponent(fileId1)}`, {
    headers: { 'x-api-key': credentials.apiToken, 'x-session-token': admin2Session }
  });
  assert.equal(admin2InvoiceRes.status, 403);

  // 7. Settlement Pipeline
  // Booker cannot trigger settlement
  await call('/orders/settle', {
    body: { orderId, customerId: credentials.booker.id, amount: 500, adminId: credentials.admin.id },
    sessionToken: bookerSession,
    status: 403
  });

  // Admin 2 cannot settle Admin 1's booker / order
  await call('/orders/settle', {
    body: { orderId, customerId: credentials.booker.id, amount: 500, adminId: credentials.admin.id },
    sessionToken: admin2Session,
    status: 403
  });

  // Admin 1 executes partial settlement (500)
  const partialSettle = await call('/orders/settle', {
    body: {
      orderId,
      customerId: credentials.booker.id,
      customerName: 'Test Booker',
      amount: 500,
      notes: 'Partial payment'
    },
    sessionToken: admin1Session
  });
  assert.equal(partialSettle.success, true);

  // Verify order in Firestore has settledAmount = 500, and is not yet fully Settled
  let orderDoc = (await db.collection('orders').doc(orderId).get()).data();
  assert.equal(orderDoc.settledAmount, 500);

  // Admin 1 completes full settlement for the remaining payableAmount (600)
  const fullSettle = await call('/orders/settle', {
    body: {
      orderId,
      customerId: credentials.booker.id,
      customerName: 'Test Booker',
      amount: 600,
      notes: 'Final balance'
    },
    sessionToken: admin1Session
  });
  assert.equal(fullSettle.success, true);

  // Verify order in Firestore now has status = 'Settled', settledAmount = 1100, and settledAt populated
  orderDoc = (await db.collection('orders').doc(orderId).get()).data();
  assert.equal(orderDoc.settledAmount, 1100);
  assert.equal(orderDoc.status, 'Settled');
  assert.ok(orderDoc.settledAt, 'Expected settledAt to be populated');

  // 8. Admin Self-Order Pipeline
  const selfOrderId = 'pipeline-self-order-01';
  await call('/orders/create', {
    body: {
      order: {
        id: selfOrderId,
        productId: 'test-admin1-prod',
        productModel: 'Admin 1 Exclusive Product',
        customerId: `ADMIN-SELF-${credentials.admin.id}`,
        customerName: 'Test Admin (Self Order)',
        adminId: credentials.admin.id,
        amountPaid: 1500,
        payableAmount: 1650,
        quantity: 1,
        status: 'Booked'
      }
    },
    sessionToken: admin1Session
  });

  // Admin 1 marks self-order Delivered
  await call('/orders/status', {
    body: { orderId: selfOrderId, status: 'Delivered' },
    sessionToken: admin1Session
  });

  // Admin 1 settles self-order
  await call('/orders/settle', {
    body: {
      orderId: selfOrderId,
      customerId: `ADMIN-SELF-${credentials.admin.id}`,
      customerName: 'Test Admin (Self Order)',
      amount: 1650,
      notes: 'Self order settled'
    },
    sessionToken: admin1Session
  });

  const selfOrderDoc = (await db.collection('orders').doc(selfOrderId).get()).data();
  assert.equal(selfOrderDoc.status, 'Settled');
  assert.equal(selfOrderDoc.settledAmount, 1650);

  // 9. Distinct Merchant Order ID vs System Order ID
  const orderWithMerchantId = 'pipeline-sys-order-02';
  const externalMerchantId = 'FK-OD4029102931';
  await call('/orders/create', {
    body: {
      order: {
        id: orderWithMerchantId,
        merchantOrderId: externalMerchantId,
        productId: 'test-admin1-prod',
        productModel: 'Admin 1 Exclusive Product',
        customerId: credentials.booker.id,
        customerName: 'Test Booker',
        adminId: credentials.admin.id,
        amountPaid: 2000,
        payableAmount: 2150,
        quantity: 1,
        status: 'Booked'
      }
    },
    sessionToken: admin1Session
  });

  const order2Doc = (await db.collection('orders').doc(orderWithMerchantId).get()).data();
  assert.equal(order2Doc.id, orderWithMerchantId);
  assert.equal(order2Doc.merchantOrderId, externalMerchantId);

  // 10. Multi-Order Continuous Day-Wise DO Number
  // Booker 1 already submitted DO1 and DO2 on their first order today (2026-10-11).
  // Now submit delivery for Booker 1's second order today:
  const order2Delivery = {
    platform: 'Flipkart',
    recipientName: 'Recipient Three',
    mobile: '9876543212',
    tracking: 'TRK-003',
    otp: '9999',
    pincode: '560003',
    submitted: true,
    deliveryDate: '2026-10-11'
  };

  const pkg3Res = await call('/orders/delivery', {
    body: {
      orderId: orderWithMerchantId,
      delivery: order2Delivery,
      packageEntry: {
        id: 'pkg-pipeline-order2-1',
        delivery: order2Delivery,
        submittedAt: '2026-10-11T15:00:00.000Z'
      }
    },
    sessionToken: bookerSession
  });

  assert.equal(pkg3Res.doNumber, 'DO3', 'Expected DO3 for Booker 1 on their second order of the same day');

  // 11. Freeform Custom Device ("Other") Booking & Delivery
  const customDeviceOrderId = 'pipeline-custom-device-01';
  await call('/orders/create', {
    body: {
      order: {
        id: customDeviceOrderId,
        productId: '',
        productModel: 'Custom Handset Pro 5G',
        customerId: credentials.booker.id,
        customerName: 'Test Booker',
        adminId: credentials.admin.id,
        amountPaid: 3000,
        payableAmount: 4000,
        profit: 1000,
        quantity: 1,
        status: 'Booked'
      }
    },
    sessionToken: admin1Session
  });

  const customOrderDoc = (await db.collection('orders').doc(customDeviceOrderId).get()).data();
  assert.equal(customOrderDoc.productModel, 'Custom Handset Pro 5G');
  assert.equal(customOrderDoc.productId, '');
});
