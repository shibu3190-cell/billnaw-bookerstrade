const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const crypto = require('crypto');
const admin = require('firebase-admin');
const { google } = require('googleapis');

// Absolute path to .env file so it loads regardless of execution directory
dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();

// Explicit CORS headers
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key', 'X-API-KEY', 'x-session-token', 'Authorization']
}));

app.use(express.json({ limit: '20mb' }));

function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } catch (error) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON must contain valid service account JSON.');
    }
  }

  try {
    return require('./serviceAccountKey.json');
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') {
      throw new Error('Firebase credentials are missing. Set FIREBASE_SERVICE_ACCOUNT_JSON or provide serviceAccountKey.json.');
    }
    throw error;
  }
}

const serviceAccount = loadServiceAccount();

// Initialize Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: `${serviceAccount.project_id}.appspot.com`
  });
}
const db = admin.firestore();
const storageBucket = admin.storage().bucket(process.env.FIREBASE_STORAGE_BUCKET || `${serviceAccount.project_id}.appspot.com`);

// Initialize Google Sheets API v4
const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: serviceAccount.client_email,
    private_key: serviceAccount.private_key
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const sheets = google.sheets({ version: 'v4', auth });
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || "1RZNZEuxiO81zaew3mG40iySFi_ixX0EY0lIkTEslr18";
const EXPECTED_TOKEN = process.env.API_SECRET_TOKEN || "AVI_TRADE_SECURE_KEY_2026";
const MASTER_ADMIN_ID = process.env.MASTER_ADMIN_ID || '';
const MASTER_ADMIN_USERNAME = process.env.MASTER_ADMIN_USERNAME || '';
const MASTER_ADMIN_PASSWORD = process.env.MASTER_ADMIN_PASSWORD || '';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const sessions = new Map();

async function tryFirestore(operation, context) {
  try {
    await operation();
  } catch (err) {
    console.error(`Firestore ${context} failed; continuing with Sheets sync:`, err.message);
  }
}

async function deleteOldInvoiceFiles() {
  const snapshot = await db.collection('invoiceFiles').orderBy('createdAt', 'asc').get();
  const filesToDelete = snapshot.docs.slice(0, Math.max(0, snapshot.size - 100));
  const deletedFileIds = [];

  for (const doc of filesToDelete) {
    const record = doc.data();
    if (record.storagePath) await storageBucket.file(record.storagePath).delete({ ignoreNotFound: true });
    await doc.ref.delete();
    deletedFileIds.push(record.fileId || doc.id);
  }

  return deletedFileIds;
}

async function uploadInvoiceFile(gstDetails, orderId) {
  if (!gstDetails?.fileData) return { gstDetails, deletedFileIds: [] };

  const match = /^data:([^;]+);base64,(.+)$/.exec(gstDetails.fileData);
  if (!match) throw new Error('Invoice attachment must be a base64 data URL.');

  const contentType = match[1];
  if (!['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
    throw new Error('Unsupported invoice attachment type.');
  }

  const fileId = /^[a-zA-Z0-9_-]{8,120}$/.test(gstDetails.fileId || '') ? gstDetails.fileId : `invoice_${crypto.randomUUID()}`;
  const existing = await db.collection('invoiceFiles').doc(fileId).get();
  if (existing.exists) {
    const record = existing.data();
    return {
      gstDetails: { ...gstDetails, fileData: '', fileId, fileUrl: record.fileUrl, storagePath: record.storagePath },
      deletedFileIds: []
    };
  }

  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 8 * 1024 * 1024) throw new Error('Invoice attachment must be under 8MB after compression.');

  const extension = contentType === 'application/pdf' ? 'pdf' : contentType.split('/')[1];
  const storagePath = `invoices/${fileId}.${extension}`;
  const file = storageBucket.file(storagePath);
  await file.save(buffer, { resumable: false, metadata: { contentType, cacheControl: 'private, max-age=3600' } });
  const [fileUrl] = await file.getSignedUrl({ action: 'read', expires: '2500-01-01' });

  await db.collection('invoiceFiles').doc(fileId).set({
    fileId,
    orderId,
    storagePath,
    fileUrl,
    fileName: gstDetails.fileName || `${fileId}.${extension}`,
    contentType,
    createdAt: Date.now()
  });

  const deletedFileIds = await deleteOldInvoiceFiles();
  return {
    gstDetails: { ...gstDetails, fileData: '', fileId, fileUrl, storagePath, attachmentDeleted: false },
    deletedFileIds
  };
}

// Helper: Ensure Sheet Tab with Headers
async function ensureSheetTab(tabName, headers) {
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const exists = meta.data.sheets.some(s => s.properties.title === tabName);

    if (!exists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: { requests: [{ addSheet: { properties: { title: tabName } } }] }
      });
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${tabName}!A1`,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [headers] }
      });
    }
  } catch (err) {
    console.error(`Sheet init error for ${tabName}:`, err.message);
  }
}

async function deleteSheetRecords(tabName, columnIndex, ownerId) {
  const [metadata, values] = await Promise.all([
    sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID }),
    sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${tabName}!A:Z` })
  ]);
  const sheet = metadata.data.sheets.find(item => item.properties.title === tabName);
  if (!sheet) return 0;
  const rows = values.data.values || [];
  const rowIndexes = rows.map((row, index) => ({ row, index })).filter(item => item.index > 0 && sameOwner(item.row[columnIndex], ownerId)).map(item => item.index).reverse();
  if (rowIndexes.length === 0) return 0;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    resource: { requests: rowIndexes.map(index => ({ deleteDimension: { range: { sheetId: sheet.properties.sheetId, dimension: 'ROWS', startIndex: index, endIndex: index + 1 } } })) }
  });
  return rowIndexes.length;
}

// Resilient Auth Middleware (Checks headers + body + fallback default)
function authenticate(req, res, next) {
  const token = req.headers['x-api-key'] || req.headers['X-API-KEY'] || req.body?.secretToken;
  if (!token || token !== EXPECTED_TOKEN) {
    console.warn(`[401 Blocked] Received: "${token}" | Expected: "${EXPECTED_TOKEN}"`);
    return res.status(401).json({ success: false, message: 'Unauthorized API Token' });
  }
  next();
}

function issueSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { user, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

function getSession(req) {
  const session = sessions.get(req.headers['x-session-token']);
  if (!session || session.expiresAt < Date.now()) return null;
  return session;
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'active', spreadsheet: SPREADSHEET_ID, timestamp: new Date().toISOString() });
});

app.post('/api/auth/login', authenticate, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: 'Username and password are required.' });
    if (username === MASTER_ADMIN_USERNAME && password === MASTER_ADMIN_PASSWORD && MASTER_ADMIN_ID) {
      const user = { name: 'Master Admin', username, role: 'admin', adminId: MASTER_ADMIN_ID, customerId: null, isMaster: true };
      return res.json({ success: true, user, sessionToken: issueSession(user) });
    }

    const adminSnapshot = await db.collection('admins').where('username', '==', username).limit(1).get();
    if (!adminSnapshot.empty) {
      const adminData = adminSnapshot.docs[0].data();
      if (adminData.password !== password) return res.status(401).json({ success: false, message: 'Invalid credentials.' });
      if (adminData.active === false) return res.status(403).json({ success: false, message: 'This admin account is revoked.' });
      const user = { name: adminData.name, username: adminData.username, role: 'admin', adminId: adminData.adminId || adminSnapshot.docs[0].id, customerId: null, isMaster: false };
      return res.json({ success: true, user, sessionToken: issueSession(user) });
    }

    const customerSnapshot = await db.collection('customers').where('username', '==', username).limit(1).get();
    if (!customerSnapshot.empty) {
      const customerData = customerSnapshot.docs[0].data();
      if (customerData.password !== password) return res.status(401).json({ success: false, message: 'Invalid credentials.' });
      if (customerData.active === false) return res.status(403).json({ success: false, message: 'This booker account is revoked.' });
      const user = { name: customerData.name, role: 'customer', adminId: customerData.adminId, customerId: customerData.id || customerSnapshot.docs[0].id, isMaster: false };
      return res.json({ success: true, user, sessionToken: issueSession(user) });
    }
    res.status(401).json({ success: false, message: 'Invalid credentials.' });
  } catch (err) {
    if (err.code === 5 || err.message?.includes('NOT_FOUND')) {
      try {
        const sheetUser = await findUserInSheets(req.body.username, req.body.password);
        if (sheetUser) return res.json({ success: true, user: sheetUser, sessionToken: issueSession(sheetUser) });
        return res.status(401).json({ success: false, message: 'Invalid credentials or account not found in Admins/Customers.' });
      } catch (sheetError) {
        return res.status(503).json({ success: false, message: 'Firestore database is unavailable and Google Sheets fallback failed. Use the Master Admin credentials or configure Firestore.' });
      }
    }
    res.status(502).json({ success: false, message: `Login service failed: ${err.message}` });
  }
});

async function findUserInSheets(username, password) {
  for (const tab of ['Admins', 'Customers']) {
    const result = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${tab}!A:Z` });
    const rows = sheetRowsToObjects(result.data.values || []);
    const record = rows.find(row => {
      const recordUsername = sheetField(row, ['Username', 'Admin Username', 'Booker ID', 'Customer ID', 'id']);
      const recordPassword = sheetField(row, ['Password', 'Admin Password', 'Booker Password', 'password']);
      const activeValue = sheetField(row, ['Active', 'Status']);
      const active = !activeValue || activeValue.toLowerCase() !== 'false' && activeValue.toLowerCase() !== 'revoked' && activeValue.toLowerCase() !== 'inactive';
      return recordUsername === String(username).trim() && recordPassword === String(password).trim() && active;
    });
    if (record) {
      if (tab === 'Admins') return { name: sheetField(record, ['Admin Name', 'Full Name', 'Name', 'name']), username: sheetField(record, ['Username', 'Admin Username']), role: 'admin', adminId: sheetField(record, ['Admin ID', 'adminId', 'id']), customerId: null, isMaster: false };
      return { name: sheetField(record, ['Full Name', 'Customer Name', 'Name', 'name']), role: 'customer', adminId: sheetField(record, ['Admin ID', 'adminId']), customerId: sheetField(record, ['Customer ID', 'Booker ID', 'id']), isMaster: false };
    }
  }
  return null;
}

function sheetField(record, names) {
  const fields = Object.keys(record);
  const field = fields.find(key => names.some(name => key.trim().toLowerCase() === name.toLowerCase()));
  return field ? String(record[field] ?? '').trim() : '';
}

function requireMaster(req, res) {
  const session = getSession(req);
  if (!session || session.user.role !== 'admin' || session.user.adminId !== MASTER_ADMIN_ID) {
    res.status(403).json({ success: false, message: 'Master Admin authorization is required.' });
    return false;
  }
  return true;
}

function requireAdminSession(req, res) {
  const session = getSession(req);
  if (!session || session.user.role !== 'admin') {
    res.status(403).json({ success: false, message: 'An active admin session is required.' });
    return null;
  }
  return session.user;
}

function requireSession(req, res, next) {
  if (!getSession(req)) return res.status(401).json({ success: false, message: 'An active login session is required.' });
  next();
}

// 1. Order Creation
app.post('/api/orders/create', authenticate, requireSession, async (req, res) => {
  try {
    const { order } = req.body;
    const actor = getSession(req)?.user;
    if (!order || typeof order !== 'object' || !order.id) {
      return res.status(400).json({ success: false, message: 'A valid order with an id is required.' });
    }
    if (!actor || (actor.role === 'admin' && !actor.isMaster && !sameOwner(order.adminId, actor.adminId)) || (actor.role === 'customer' && String(order.customerId || '').trim() !== String(actor.customerId || '').trim())) {
      return res.status(403).json({ success: false, message: 'You can only create bookings for your own account.' });
    }
    await tryFirestore(
      () => db.collection('orders').doc(order.id).set(order),
      `save order ${order.id}`
    );

    await ensureSheetTab('Orders', [
      'Order ID', 'Platform', 'Product Model', 'Customer Name', 'Customer ID',
      'Card Last 4', 'Amount Paid', 'Payable Due', 'Advance Paid', 'Status', 'Date', 'Admin ID'
    ]);

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Orders!A:L',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[
          order.id, order.platform, order.productModel, order.customerName,
          order.customerId, order.cardLast4, order.amountPaid, order.payableAmount,
          order.advancePaid || 0, order.status, order.createdAt, order.adminId || 'ADM-001'
        ]]
      }
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Delivery & GST Submission
app.post('/api/orders/delivery', authenticate, requireSession, async (req, res) => {
  try {
    const { orderId, platform, model, delivery, gstDetails } = req.body;
    if (!orderId || !delivery || typeof delivery !== 'object') {
      return res.status(400).json({ success: false, message: 'orderId and delivery details are required.' });
    }

    const uploadedInvoice = await uploadInvoiceFile(gstDetails, orderId);
    const persistedGstDetails = uploadedInvoice.gstDetails?.fileData === ''
      ? uploadedInvoice.gstDetails
      : (uploadedInvoice.gstDetails || null);

    await tryFirestore(
      () => db.collection('orders').doc(orderId).update({
        delivery,
        gstDetails: persistedGstDetails,
        status: 'Out for Delivery',
        isToday: true
      }),
      `update delivery ${orderId}`
    );

    await ensureSheetTab('Deliveries_OTP', [
      'Order ID', 'Platform', 'Model', 'Recipient Name', 'Mobile',
      'Tracking AWB', 'OTP', 'Pincode', 'GSTIN', 'Shop Name', 'Base Amount', 'GST Tax Amount', 'Gross Total', 'Timestamp'
    ]);

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Deliveries_OTP!A:N',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[
          orderId, platform, model, delivery.recipientName,
          delivery.mobile, delivery.tracking, delivery.otp, delivery.pincode,
          persistedGstDetails?.gstNumber || 'N/A', persistedGstDetails?.shopName || 'N/A',
          persistedGstDetails?.baseAmount || 0, persistedGstDetails?.gstAmount || 0,
          persistedGstDetails?.totalAmount || 0, new Date().toISOString()
        ]]
      }
    });

    res.json({ success: true, file: persistedGstDetails?.fileId ? persistedGstDetails : null, deletedFileIds: uploadedInvoice.deletedFileIds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Stage Updates
app.post('/api/orders/status', authenticate, requireSession, async (req, res) => {
  try {
    const { orderId, status, settledAt } = req.body;
    const actor = requireAdminSession(req, res);
    if (!actor) return;
    if (!orderId || !status) {
      return res.status(400).json({ success: false, message: 'orderId and status are required.' });
    }
    const updateObj = { status };
    if (settledAt) updateObj.settledAt = settledAt;

    await tryFirestore(
      () => db.collection('orders').doc(orderId).update(updateObj),
      `update status ${orderId}`
    );

    const sheetData = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Orders!A:A' });
    const rows = sheetData.data.values || [];
    const rowIndex = rows.findIndex(r => r[0] === orderId);

    if (rowIndex !== -1) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `Orders!J${rowIndex + 1}`,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [[status]] }
      });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/orders/approve', authenticate, requireSession, async (req, res) => {
  try {
    const { orderId } = req.body;
    const actor = requireAdminSession(req, res);
    if (!actor || !orderId) return res.status(400).json({ success: false, message: 'An orderId and admin session are required.' });
    const orderRef = db.collection('orders').doc(orderId);
    let order;
    try {
      const orderSnapshot = await orderRef.get();
      if (orderSnapshot.exists) order = orderSnapshot.data();
    } catch (firestoreError) {
      console.error('Firestore approval lookup failed; checking Sheets:', firestoreError.message);
    }
    const sheetData = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Orders!A:L' });
    const rows = sheetData.data.values || [];
    const rowIndex = rows.findIndex(row => row[0] === orderId);
    if (!order && rowIndex > 0) order = { adminId: rows[rowIndex][11], status: rows[rowIndex][9] };
    if (!order) return res.status(404).json({ success: false, message: 'Booking not found.' });
    if (!actor.isMaster && order.adminId !== actor.adminId) return res.status(403).json({ success: false, message: 'Only the owning admin can approve this booking.' });
    await tryFirestore(() => orderRef.update({ status: 'Booked', approvedBy: actor.adminId, approvedAt: new Date().toISOString() }), `approve order ${orderId}`);
    if (rowIndex > 0) {
      await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `Orders!J${rowIndex + 1}`, valueInputOption: 'USER_ENTERED', resource: { values: [['Booked']] } });
    }
    res.json({ success: true, orderId, status: 'Booked' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 4. Financial Settlement
app.post('/api/orders/settle', authenticate, requireSession, async (req, res) => {
  try {
    const { orderId, customerId, customerName, amount, notes } = req.body;
    if (!orderId || !customerId || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ success: false, message: 'A positive settlement amount, orderId, and customerId are required.' });
    }

    await tryFirestore(async () => {
      const custRef = db.collection('customers').doc(customerId);
      const doc = await custRef.get();
      if (doc.exists) {
        await custRef.update({ totalSettled: (doc.data().totalSettled || 0) + amount });
      }
    }, `settle customer ${customerId}`);

    await ensureSheetTab('Settlements', ['Order ID', 'Customer ID', 'Customer Name', 'Settled Amount', 'Payment Note', 'Timestamp']);
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Settlements!A:F',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[orderId, customerId, customerName, amount, notes, new Date().toISOString()]] }
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Register Booker Account
app.post('/api/customers/create', authenticate, requireSession, async (req, res) => {
  try {
    const { customer } = req.body;
    const actor = requireAdminSession(req, res);
    if (!actor) return;
    if (actor.adminId !== MASTER_ADMIN_ID && customer?.adminId !== actor.adminId) return res.status(403).json({ success: false, message: 'Booker must belong to the active admin.' });
    if (!customer || typeof customer !== 'object' || !customer.id) {
      return res.status(400).json({ success: false, message: 'A valid customer with an id is required.' });
    }
    const customerId = String(customer.id).trim();
    const existingCustomer = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Customers!A:A' }).catch(() => ({ data: { values: [] } }));
    const duplicateInSheets = (existingCustomer.data.values || []).some(row => String(row[0] || '').trim().toLowerCase() === customerId.toLowerCase());
    if (duplicateInSheets) return res.status(409).json({ success: false, message: `Booker ID ${customerId} already exists.` });
    customer.id = customerId;
    customer.username = customerId;
    await tryFirestore(
      () => db.collection('customers').doc(customerId).set(customer),
      `save customer ${customerId}`
    );

    await ensureSheetTab('Customers', ['Customer ID', 'Full Name', 'Mobile', 'Password', 'Created By Admin', 'Admin ID', 'Active', 'Timestamp']);
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Customers!A:H',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[customer.id, customer.name, customer.mobile, customer.password, customer.createdByAdmin, customer.adminId || MASTER_ADMIN_ID, customer.active !== false, new Date().toISOString()]] }
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/products/sync', authenticate, requireSession, async (req, res) => {
  try {
    const { product } = req.body;
    const actor = requireAdminSession(req, res);
    if (!actor) return;
    if (!product || typeof product !== 'object' || !product.id || !product.name) {
      return res.status(400).json({ success: false, message: 'A valid product with an id and name is required.' });
    }
    const productData = { ...product, adminId: actor.isMaster ? (product.adminId || '') : actor.adminId };
    await tryFirestore(
      () => db.collection('products').doc(productData.id).set(productData),
      `save product ${productData.id}`
    );
    await ensureSheetTab('Products', ['Product ID', 'Product Name', 'Target Price', 'Commission', 'Admin ID', 'Active', 'Last Synced']);
    const sheetData = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Products!A:A' });
    const rowIndex = (sheetData.data.values || []).findIndex(row => row[0] === productData.id);
    const values = [[productData.id, productData.name, productData.targetPrice || 0, productData.commission || 0, productData.adminId || '', productData.active !== false, new Date().toISOString()]];
    if (rowIndex > 0) {
      await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `Products!A${rowIndex + 1}:G${rowIndex + 1}`, valueInputOption: 'USER_ENTERED', resource: { values } });
    } else {
      await sheets.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: 'Products!A:G', valueInputOption: 'USER_ENTERED', resource: { values } });
    }
    res.json({ success: true, product: productData });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 6. Sync Admin Profile
app.post('/api/admin/sync', authenticate, requireSession, async (req, res) => {
  try {
    const { admin: adminData } = req.body;
    if (!requireMaster(req, res)) return;
    if (!adminData || typeof adminData !== 'object' || !adminData.adminId) {
      return res.status(400).json({ success: false, message: 'A valid admin profile with an adminId is required.' });
    }
    await tryFirestore(
      () => db.collection('admins').doc(adminData.adminId).set(adminData),
      `save admin ${adminData.adminId}`
    );

    await ensureSheetTab('Admins', ['Admin ID', 'Admin Name', 'Username', 'Password', 'Active', 'Last Synced']);
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Admins!A:F',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[adminData.adminId, adminData.name, adminData.username, adminData.password, adminData.active !== false, new Date().toISOString()]] }
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/profile', authenticate, requireSession, async (req, res) => {
  try {
    const { profile } = req.body;
    const actor = requireAdminSession(req, res);
    if (!actor) return;
    if (!profile || profile.adminId !== actor.adminId || !profile.username || !profile.password) {
      return res.status(400).json({ success: false, message: 'Only the signed-in admin can update their own profile.' });
    }
    const profileData = { adminId: actor.adminId, name: profile.name || actor.name, username: profile.username.trim(), password: profile.password, active: true };
    await tryFirestore(() => db.collection('admins').doc(actor.adminId).set(profileData, { merge: true }), `update admin profile ${actor.adminId}`);
    await ensureSheetTab('Admins', ['Admin ID', 'Admin Name', 'Username', 'Password', 'Active', 'Last Synced']);
    const sheetData = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Admins!A:A' });
    const rowIndex = (sheetData.data.values || []).findIndex(row => row[0] === actor.adminId);
    const values = [[profileData.adminId, profileData.name, profileData.username, profileData.password, true, new Date().toISOString()]];
    if (rowIndex > 0) {
      await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `Admins!A${rowIndex + 1}:F${rowIndex + 1}`, valueInputOption: 'USER_ENTERED', resource: { values } });
    } else {
      await sheets.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: 'Admins!A:F', valueInputOption: 'USER_ENTERED', resource: { values } });
    }
    res.json({ success: true, profile: profileData });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/create', authenticate, requireSession, async (req, res) => {
  try {
    const { admin: adminData } = req.body;
    if (!requireMaster(req, res)) return;
    if (!adminData || !adminData.adminId || !adminData.name || !adminData.username || !adminData.password) {
      return res.status(400).json({ success: false, message: 'adminId, name, username, and password are required.' });
    }

    let firestoreSaved = false;
    try {
      await db.collection('admins').doc(adminData.adminId).set(adminData);
      firestoreSaved = true;
    } catch (firestoreError) {
      console.error('Firestore admin create failed; continuing with Sheets:', firestoreError.message);
    }

    await ensureSheetTab('Admins', ['Admin ID', 'Admin Name', 'Username', 'Password', 'Active', 'Last Synced']);
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Admins!A:F',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[adminData.adminId, adminData.name, adminData.username, adminData.password, adminData.active !== false, new Date().toISOString()]] }
    });
    res.json({ success: true, admin: adminData, firestoreSaved, sheetsSaved: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/status', authenticate, requireSession, async (req, res) => {
  try {
    if (!requireMaster(req, res)) return;
    const { adminId, active } = req.body;
    if (!adminId || adminId === MASTER_ADMIN_ID) return res.status(400).json({ success: false, message: 'A subordinate adminId is required.' });
    await db.collection('admins').doc(adminId).update({ active: active === true });
    res.json({ success: true, adminId, active: active === true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/delete', authenticate, requireSession, async (req, res) => {
  try {
    if (!requireMaster(req, res)) return;
    const adminId = String(req.body.adminId || '').trim();
    if (!adminId || sameOwner(adminId, MASTER_ADMIN_ID)) return res.status(400).json({ success: false, message: 'A subordinate adminId is required.' });
    const collections = ['admins', 'customers', 'products', 'orders'];
    let deletedFirestore = 0;
    for (const collection of collections) {
      const snapshot = await db.collection(collection).where('adminId', '==', adminId).get().catch(() => ({ empty: true, docs: [] }));
      const refs = snapshot.docs.map(doc => doc.ref);
      if (collection === 'admins') refs.push(db.collection('admins').doc(adminId));
      for (let index = 0; index < refs.length; index += 400) {
        const batch = db.batch();
        refs.slice(index, index + 400).forEach(ref => batch.delete(ref));
        await batch.commit().catch(() => {});
        deletedFirestore += refs.slice(index, index + 400).length;
      }
    }
    const deletedSheets = (await Promise.all([
      deleteSheetRecords('Admins', 0, adminId),
      deleteSheetRecords('Customers', 5, adminId),
      deleteSheetRecords('Products', 4, adminId),
      deleteSheetRecords('Orders', 11, adminId)
    ])).reduce((total, count) => total + count, 0);
    res.json({ success: true, adminId, deletedFirestore, deletedSheets });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/customers/status', authenticate, requireSession, async (req, res) => {
  try {
    const { customerId, active } = req.body;
    const actor = requireAdminSession(req, res);
    if (!actor || !customerId) return res.status(400).json({ success: false, message: 'customerId is required.' });
    const customerRef = db.collection('customers').doc(customerId);
    const customerSnapshot = await customerRef.get();
    if (!customerSnapshot.exists) return res.status(404).json({ success: false, message: 'Booker not found.' });
    const customer = customerSnapshot.data();
    if (!sameOwner(actor.adminId, MASTER_ADMIN_ID) && !sameOwner(customer.adminId, actor.adminId)) {
      return res.status(403).json({ success: false, message: 'Only the owning admin or Master Admin can change this booker.' });
    }
    await customerRef.update({ active: active === true });
    res.json({ success: true, customerId, active: active === true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

function sheetRowsToObjects(values = []) {
  if (values.length < 2) return [];
  const headers = values[0].map(header => String(header).trim());
  return values.slice(1).filter(row => row.some(value => String(value ?? '').trim() !== '')).map(row =>
    Object.fromEntries(headers.map((header, index) => [header, row[index] ?? '']))
  );
}

function sameOwner(left, right) {
  const normalize = value => String(value || '').replace(/[-_\s]/g, '').toLowerCase();
  return normalize(left) === normalize(right);
}

function ownedBy(record, adminId) {
  return sameOwner(record.adminId || record['Admin ID'], adminId);
}

function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

app.get('/api/admin/sheets/data', authenticate, requireSession, async (req, res) => {
  try {
    const actor = getSession(req).user;
    const tabs = ['Admins', 'Customers', 'Products', 'Orders'];
    const response = {};
    for (const tab of tabs) {
      try {
        const result = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${tab}!A:Z` });
        const records = sheetRowsToObjects(result.data.values || []);
        response[tab.toLowerCase()] = actor.isMaster ? records : tab === 'Admins'
          ? records.filter(record => ownedBy(record, actor.adminId))
          : records.filter(record => actor.role === 'customer'
            ? String(record['Customer ID'] || record.customerId || record.id || '').trim() === actor.customerId
            : ownedBy(record, actor.adminId));
      } catch (error) {
        if (error.code === 400 || error.code === 404) {
          response[tab.toLowerCase()] = [];
          continue;
        }
        throw error;
      }
    }
    res.json({ success: true, spreadsheetId: SPREADSHEET_ID, data: response });
  } catch (err) {
    res.status(502).json({ success: false, message: `Google Sheets import failed: ${err.message}` });
  }
});

app.get('/api/admin/data/export', authenticate, requireSession, async (req, res) => {
  try {
    const actor = getSession(req).user;
    const [admins, customers, products, orders] = await Promise.all(
      ['admins', 'customers', 'products', 'orders'].map(collection => db.collection(collection).get())
    );
    const collectionData = snapshot => snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const scope = records => actor.isMaster ? records : records.filter(record => actor.role === 'customer'
      ? String(record.customerId || '').trim() === String(actor.customerId || '').trim()
      : sameOwner(record.adminId, actor.adminId));
    res.json({
      success: true,
      exportedAt: new Date().toISOString(),
      data: {
        admins: actor.isMaster ? collectionData(admins) : collectionData(admins).filter(record => sameOwner(record.adminId, actor.adminId)),
        customers: scope(collectionData(customers)),
        products: scope(collectionData(products)),
        orders: scope(collectionData(orders))
      }
    });
  } catch (err) {
    res.status(502).json({ success: false, message: `Cloud data export failed: ${err.message}` });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => console.log(`DeviceTrade Backend running on port ${PORT}`));