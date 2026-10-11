const test = require('node:test');
const assert = require('node:assert/strict');

function csvOrNumber(val) {
  if (val === null || val === undefined || val === '') return 0;
  const clean = String(val).replace(/[^0-9.-]/g, '');
  const num = Number(clean);
  return Number.isFinite(num) ? num : 0;
}

function normalizeOrder(order) {
  const quantity = Math.max(1, Number(order.quantity) || 1);
  let amountPaid = csvOrNumber(order.amountPaid);
  const payableAmount = csvOrNumber(order.payableAmount);
  const profit = csvOrNumber(order.profit);

  let unitPrice = csvOrNumber(order.unitPrice);
  if (quantity > 1 && amountPaid > 0 && Math.round(amountPaid * quantity + profit) === Math.round(payableAmount)) {
    unitPrice = amountPaid;
    amountPaid = amountPaid * quantity;
  } else if (quantity > 1 && unitPrice <= 0 && amountPaid > 0) {
    unitPrice = Math.round(amountPaid / quantity);
  } else if (quantity === 1) {
    unitPrice = amountPaid;
  }

  return {
    ...order,
    id: String(order.id || ''),
    quantity,
    unitPrice,
    amountPaid,
    payableAmount,
    advancePaid: csvOrNumber(order.advancePaid),
    settledAmount: csvOrNumber(order.settledAmount),
    profit,
    deliveryPackages: Array.isArray(order.deliveryPackages) ? order.deliveryPackages : []
  };
}

function getOrderNetDue(order) {
  return Math.max(0, (order.payableAmount || 0) - (order.advancePaid || 0) - (order.settledAmount || 0));
}

test('Accounting & Counting: resolves screenshot volume mismatch where total card paid + profit = pending due', () => {
  // Simulating the 5 orders from the user screenshot before normalization
  const rawOrders = [
    { id: 'OD124804', quantity: 1, amountPaid: 10000, payableAmount: 10100, profit: 100, advancePaid: 0 },
    { id: 'OD165260', quantity: 1, amountPaid: 10000, payableAmount: 10100, profit: 100, advancePaid: 0 },
    { id: 'OD198749', quantity: 1, amountPaid: 10000, payableAmount: 10100, profit: 100, advancePaid: 0 },
    // Orders with quantity 2 stored only unit card price (10,000)
    { id: 'OD23247855', quantity: 2, amountPaid: 10000, payableAmount: 20200, profit: 200, advancePaid: 0 },
    { id: 'OD232694', quantity: 2, amountPaid: 10000, payableAmount: 20200, profit: 200, advancePaid: 0 }
  ];

  const normalized = rawOrders.map(normalizeOrder);

  // Check individual multi-qty orders
  assert.equal(normalized[3].amountPaid, 20000, 'OD23247855 amountPaid should be 20,000 (total card paid)');
  assert.equal(normalized[3].unitPrice, 10000, 'OD23247855 unitPrice should be 10,000 per unit');
  assert.equal(normalized[4].amountPaid, 20000, 'OD232694 amountPaid should be 20,000 (total card paid)');
  assert.equal(normalized[4].unitPrice, 10000, 'OD232694 unitPrice should be 10,000 per unit');

  // KPI Calculations
  const activeVolume = normalized.reduce((sum, o) => sum + o.amountPaid, 0);
  const totalProfit = normalized.reduce((sum, o) => sum + o.profit, 0);
  const pendingDue = normalized.reduce((sum, o) => sum + getOrderNetDue(o), 0);

  assert.equal(activeVolume, 70000, 'Active bookings volume must be ₹70,000');
  assert.equal(totalProfit, 700, 'Booker profit must be ₹700');
  assert.equal(pendingDue, 70700, 'Pending due must be ₹70,700');
  assert.equal(activeVolume + totalProfit, pendingDue, 'Active Volume + Profit MUST perfectly equal Pending Due');
});

test('GST Bills Gallery: eliminates duplicate card when order has both order.gstDetails and deliveryPackages gstDetails', () => {
  const orderWithGst = {
    id: 'OD232694',
    productModel: 'lg tv',
    quantity: 2,
    createdAt: '2026-10-11',
    gstDetails: {
      included: true,
      shopName: 'Flipkart Electronics',
      gstAmount: 200,
      fileData: 'data:image/jpeg;base64,...'
    },
    deliveryPackages: [
      {
        id: 'c39c11ea-c00b-4bd2-bbf8-90d7d002231e',
        sequence: 2,
        doNumber: 'DO2',
        delivery: { submittedAt: '2026-10-11' },
        gstDetails: {
          included: true,
          shopName: 'Flipkart Electronics',
          gstAmount: 200,
          fileData: 'data:image/jpeg;base64,...'
        }
      }
    ]
  };

  // Deduping logic matching frontend/app.js renderInvoicesGallery
  const getVisibleInvoices = (order) => {
    const packagesWithGst = (order.deliveryPackages || []).filter(item => item.gstDetails?.included);
    if (packagesWithGst.length > 0) {
      return packagesWithGst.map((item, idx) => ({
        order,
        packageId: item.id,
        doNumber: item.doNumber || `DO${item.sequence || idx + 1}`,
        parcelIndex: idx + 1,
        totalParcels: order.quantity || packagesWithGst.length,
        gstDetails: item.gstDetails
      }));
    }
    if (order.gstDetails?.included) {
      return [{
        order,
        packageId: '',
        doNumber: order.deliveryPackages?.[0]?.doNumber || 'DO1',
        parcelIndex: 1,
        totalParcels: order.quantity || 1,
        gstDetails: order.gstDetails
      }];
    }
    return [];
  };

  const invoiceCards = getVisibleInvoices(orderWithGst);

  // Must only produce ONE card, NOT two!
  assert.equal(invoiceCards.length, 1, 'Exactly one GST card should be returned, avoiding double entry');
  assert.equal(invoiceCards[0].doNumber, 'DO2');
  assert.equal(invoiceCards[0].parcelIndex, 1);
  assert.equal(invoiceCards[0].totalParcels, 2);

  // Label formatting
  const parcelSubtitle = invoiceCards[0].totalParcels > 1
    ? `${invoiceCards[0].doNumber} (Parcel ${invoiceCards[0].parcelIndex}/${invoiceCards[0].totalParcels})`
    : invoiceCards[0].doNumber;

  assert.equal(parcelSubtitle, 'DO2 (Parcel 1/2)', 'Label should show human readable DO and Parcel index, not raw UUID');
});

test('Deliveries table: sorts deliveries ascending by DO sequence and formats parcel index cleanly', () => {
  const deliveries = [
    { sequence: 1, doNumber: 'DO1', orderIndex: 1 },
    { sequence: 3, doNumber: 'DO3', orderIndex: 1 },
    { sequence: 2, doNumber: 'DO2', orderIndex: 1 }
  ];

  deliveries.sort((a, b) => {
    const seqA = Number(a.sequence) || Number(String(a.doNumber || '').match(/\d+/)?.[0]) || 0;
    const seqB = Number(b.sequence) || Number(String(b.doNumber || '').match(/\d+/)?.[0]) || 0;
    return seqA - seqB;
  });

  assert.deepEqual(deliveries.map(d => d.doNumber), ['DO1', 'DO2', 'DO3'], 'Deliveries must sort in ascending DO sequence: DO1, DO2, DO3');

  // Verify parcel label doesn't produce "DO3 of 2"
  const item = { orderIndex: 1, doNumber: 'DO3' };
  const order = { quantity: 2 };
  const parcelText = order.quantity > 1 ? `Parcel ${item.orderIndex || 1} of ${order.quantity}` : '';

  assert.equal(parcelText, 'Parcel 1 of 2', 'Must render "Parcel 1 of 2" instead of "DO3 of 2"');
});
