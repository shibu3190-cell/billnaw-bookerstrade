const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const crypto = require('crypto');
const admin = require('firebase-admin');
const { google } = require('googleapis');
const { allocateDeliveryPackageIdentity } = require('./delivery-packages');
const { paginateRecords, normalizePageNumber, normalizePageSize } = require('./data-pagination');
const { createRequireSession, isMasterAdminSession } = require('./account-access');
const { canAccessOrder, canUseProduct } = require('./order-access');
const { findAccountConflict } = require('./account-validation');
const { hashPassword, verifyPassword } = require('./passwords');
const ISOLATED_TEST_MODE = process.env.APP_TEST_MODE === 'isolated';

// Absolute path to .env file so it loads regardless of execution directory
dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
app.set('trust proxy', 1);

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

const isolatedEnvironment = ISOLATED_TEST_MODE ? require('./testing/isolated-environment') : null;
const serviceAccount = ISOLATED_TEST_MODE ? isolatedEnvironment.serviceAccount : loadServiceAccount();
const SESSION_SIGNING_SECRET = ISOLATED_TEST_MODE
  ? isolatedEnvironment.sessionSecret
  : process.env.SESSION_SIGNING_SECRET || serviceAccount.private_key;
if (!SESSION_SIGNING_SECRET) throw new Error('Firebase credentials must include private_key for session signing.');
const STORAGE_BUCKET_NAME = ISOLATED_TEST_MODE
  ? 'isolated-test-bucket'
  : process.env.FIREBASE_STORAGE_BUCKET || `${serviceAccount.project_id}.firebasestorage.app`;

// Initialize Firebase Admin
if (!ISOLATED_TEST_MODE && !admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: STORAGE_BUCKET_NAME
  });
}
const db = ISOLATED_TEST_MODE ? isolatedEnvironment.db : admin.firestore();
const storageBucket = ISOLATED_TEST_MODE ? isolatedEnvironment.storageBucket : admin.storage().bucket(STORAGE_BUCKET_NAME);

// Initialize Google Sheets API v4
const auth = ISOLATED_TEST_MODE ? null : new google.auth.GoogleAuth({
  credentials: {
    client_email: serviceAccount.client_email,
    private_key: serviceAccount.private_key
  },
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const sheets = ISOLATED_TEST_MODE ? isolatedEnvironment.sheets : google.sheets({ version: 'v4', auth });
const SPREADSHEET_ID = ISOLATED_TEST_MODE
  ? 'isolated-test-spreadsheet'
  : process.env.SPREADSHEET_ID || "1RZNZEuxiO81zaew3mG40iySFi_ixX0EY0lIkTEslr18";
const EXPECTED_TOKEN = ISOLATED_TEST_MODE ? isolatedEnvironment.credentials.apiToken : process.env.API_SECRET_TOKEN || '';
const MASTER_ADMIN_ID = ISOLATED_TEST_MODE ? isolatedEnvironment.credentials.master.id : process.env.MASTER_ADMIN_ID || '';
const MASTER_ADMIN_USERNAME = ISOLATED_TEST_MODE ? isolatedEnvironment.credentials.master.username : process.env.MASTER_ADMIN_USERNAME || '';
const MASTER_ADMIN_PASSWORD = ISOLATED_TEST_MODE ? isolatedEnvironment.credentials.master.password : process.env.MASTER_ADMIN_PASSWORD || '';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const sessions = new Map();
const loginRequestWindows = new Map();

async function tryFirestore(operation, context) {
  try {
    await operation();
  } catch (err) {
    console.error(`Firestore ${context} failed; continuing with Sheets sync:`, err.message);
  }
}

async function deleteOldInvoiceFiles() {
  const snapshot = await db.collection('invoiceFiles').orderBy('createdAt', 'asc').get();
  const activeFiles = snapshot.docs.filter(doc => doc.data().storagePath && !doc.data().deletedAt);
  const filesToDelete = activeFiles.slice(0, Math.max(0, activeFiles.length - 100));
  const deletedFileIds = [];

  for (const doc of filesToDelete) {
    const record = doc.data();
    if (record.storagePath) await storageBucket.file(record.storagePath).delete({ ignoreNotFound: true });
    await doc.ref.update({ storagePath: '', fileUrl: '', deletedAt: new Date().toISOString() });
    if (record.orderId) {
      const orderRef = db.collection('orders').doc(record.orderId);
      const orderSnapshot = await orderRef.get();
      if (orderSnapshot.exists && orderSnapshot.data().gstDetails?.fileId === (record.fileId || doc.id)) {
        await orderRef.update({ gstDetails: { ...orderSnapshot.data().gstDetails, fileData: '', fileUrl: '', storagePath: '', attachmentDeleted: true } });
      }
    }
    deletedFileIds.push(record.fileId || doc.id);
  }

  return deletedFileIds;
}

async function uploadInvoiceFile(gstDetails, orderId, stableFileId = false) {
  if (!gstDetails?.fileData) return { gstDetails, deletedFileIds: [] };

  const match = /^data:([^;]+);base64,(.+)$/.exec(gstDetails.fileData);
  if (!match) throw new Error('Invoice attachment must be a base64 data URL.');

  const contentType = match[1];
  if (!['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
    throw new Error('Unsupported invoice attachment type.');
  }

  const fileId = stableFileId && /^[a-zA-Z0-9_-]{8,120}$/.test(gstDetails.fileId || '')
    ? gstDetails.fileId
    : `invoice_${crypto.randomUUID()}`;
  const existing = await db.collection('invoiceFiles').doc(fileId).get();
  if (existing.exists) {
    const record = existing.data();
    return {
      gstDetails: { ...gstDetails, fileData: '', fileId, fileUrl: '', storagePath: record.storagePath, contentType: record.contentType || contentType, attachmentDeleted: Boolean(record.deletedAt) },
      deletedFileIds: []
    };
  }

  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 8 * 1024 * 1024) throw new Error('Invoice attachment must be under 8MB after compression.');

  const extension = contentType === 'application/pdf' ? 'pdf' : contentType.split('/')[1];
  const storagePath = `invoices/${fileId}.${extension}`;
  const file = storageBucket.file(storagePath);
  await file.save(buffer, {
    resumable: false,
    metadata: {
      contentType,
      cacheControl: 'private, max-age=3600',
      contentDisposition: 'inline'
    }
  });
  await db.collection('invoiceFiles').doc(fileId).set({
    fileId,
    orderId,
    adminId: gstDetails.adminId || '',
    customerId: gstDetails.customerId || '',
    storagePath,
    fileUrl: '',
    fileName: gstDetails.fileName || `${fileId}.${extension}`,
    contentType,
    createdAt: Date.now()
  });

  const deletedFileIds = await deleteOldInvoiceFiles();
  return {
    gstDetails: { ...gstDetails, fileData: '', fileId, fileUrl: '', storagePath, contentType, attachmentDeleted: false },
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

function sheetColumnName(index) {
  let value = index + 1;
  let letters = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

async function ensurePasswordHashColumn(tabName, hashColumn, headers) {
  await ensureSheetTab(tabName, headers);
  const result = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${tabName}!A:Z` });
  const rows = result.data.values || [];
  if (!rows.length) return;
  if (String(rows[0][hashColumn] || '').trim().toLowerCase() !== 'password hash') {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${tabName}!${sheetColumnName(hashColumn)}1`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [['Password Hash']] }
    });
  }
}

async function syncPasswordHashToSheet(tabName, accountId, passwordHash) {
  const rowsResult = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${tabName}!A:Z` });
  const rows = rowsResult.data.values || [];
  if (!rows.length) return false;
  const headers = rows[0].map(value => String(value || '').trim());
  const passwordColumn = headers.findIndex(value => ['password', 'admin password', 'booker password'].includes(value.toLowerCase()));
  let hashColumn = headers.findIndex(value => value.toLowerCase() === 'password hash');
  if (hashColumn < 0) {
    hashColumn = tabName === 'Admins' ? 7 : 9;
    await ensurePasswordHashColumn(tabName, hashColumn, []);
  }
  const rowIndex = rows.findIndex((row, index) => index > 0 && sameOwner(row[0], accountId));
  if (rowIndex < 1) return false;
  const rowNumber = rowIndex + 1;
  if (passwordColumn >= 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${tabName}!${sheetColumnName(passwordColumn)}${rowNumber}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [['']] }
    });
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${tabName}!${sheetColumnName(hashColumn)}${rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [[passwordHash]] }
  });
  return true;
}

async function migrateLegacyPassword(collection, tabName, accountId, password) {
  const passwordHash = await hashPassword(password);
  const accountRef = db.collection(collection).doc(accountId);
  const snapshot = await accountRef.get().catch(error => {
    if (error.code === 5 || error.message?.includes('NOT_FOUND')) return null;
    throw error;
  });
  if (snapshot?.exists) await accountRef.update({ password: '', passwordHash });
  await syncPasswordHashToSheet(tabName, accountId, passwordHash);
  return passwordHash;
}

function withoutCredentials(record) {
  return Object.fromEntries(Object.entries(record || {}).filter(([key]) => {
    const normalized = key.trim().toLowerCase().replace(/[ _-]/g, '');
    return normalized !== 'password' && normalized !== 'passwordhash' && normalized !== 'adminpassword' && normalized !== 'bookerpassword';
  }));
}

async function syncAccountStatusToSheet(tabName, accountId, active, sessionVersion, idColumn, activeColumn, versionColumn, headers) {
  await ensureSheetTab(tabName, headers);
  const range = `${tabName}!A:Z`;
  const result = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  const rows = result.data.values || [];
  if (!rows.length) return false;

  const header = rows[0].map(value => String(value || '').trim());
  if (!header[versionColumn]) {
    const column = String.fromCharCode(65 + versionColumn);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${tabName}!${column}1`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [['Session Version']] }
    });
  }

  const rowIndex = rows.findIndex((row, index) => index > 0 && sameOwner(row[idColumn], accountId));
  if (rowIndex < 1) return false;
  const row = [...rows[rowIndex]];
  row[activeColumn] = active;
  row[versionColumn] = sessionVersion;
  const endColumn = String.fromCharCode(65 + versionColumn);
  const values = [Array.from({ length: versionColumn + 1 }, (_, index) => row[index] ?? '')];
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${tabName}!A${rowIndex + 1}:${endColumn}${rowIndex + 1}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values }
  });
  return true;
}

async function deleteSheetRecords(tabName, columnIndex, ownerId) {
  const metadata = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheet = metadata.data.sheets.find(item => item.properties.title === tabName);
  if (!sheet) return 0;
  const values = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${tabName}!A:Z` });
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
  if (EXPECTED_TOKEN && token === EXPECTED_TOKEN) return next();
  if (req.path === '/api/auth/login' && (!EXPECTED_TOKEN || !token)) return next();
  if (getSession(req) && (!EXPECTED_TOKEN || !token)) return next();
  if (!EXPECTED_TOKEN && token && getSession(req)) return next();
  return res.status(401).json({ success: false, message: 'Unauthorized request.' });
}

function rateLimitLogin(req, res, next) {
  const now = Date.now();
  const key = String(req.ip || req.socket.remoteAddress || 'unknown');
  const windowMs = 15 * 60 * 1000;
  const limit = 20;
  let bucket = loginRequestWindows.get(key);
  if (!bucket || bucket.startedAt + windowMs <= now) {
    bucket = { startedAt: now, count: 0 };
  }
  if (bucket.count >= limit) {
    const retryAfter = Math.max(1, Math.ceil((bucket.startedAt + windowMs - now) / 1000));
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ success: false, message: 'Too many login attempts. Try again later.' });
  }
  bucket.count += 1;
  loginRequestWindows.set(key, bucket);
  if (loginRequestWindows.size > 2000) {
    for (const [ip, entry] of loginRequestWindows) {
      if (entry.startedAt + windowMs <= now) loginRequestWindows.delete(ip);
    }
  }
  next();
}

function issueSession(user) {
  const payload = Buffer.from(JSON.stringify({ user, expiresAt: Date.now() + SESSION_TTL_MS })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SIGNING_SECRET).update(payload).digest('base64url');
  const token = `${payload}.${signature}`;
  sessions.set(token, { user, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

function getSession(req) {
  const token = req.headers['x-session-token'];
  if (!token) return null;
  const cached = sessions.get(token);
  if (cached && cached.expiresAt >= Date.now()) return cached;

  const separator = token.lastIndexOf('.');
  if (separator < 1) return null;
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const expectedSignature = crypto.createHmac('sha256', SESSION_SIGNING_SECRET).update(payload).digest('base64url');
  const receivedSignature = Buffer.from(signature);
  const validSignature = Buffer.from(expectedSignature);
  const signaturesMatch = receivedSignature.length === validSignature.length
    && crypto.timingSafeEqual(receivedSignature, validSignature);
  if (!signaturesMatch) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!session.user || session.expiresAt < Date.now()) return null;
    sessions.set(token, session);
    return session;
  } catch (error) {
    return null;
  }
}

const requireSession = createRequireSession({ getSession, getAccountState: loadAccountState, masterAdminId: MASTER_ADMIN_ID });

app.get('/api/health', (req, res) => {
  res.json({ status: 'active', spreadsheet: SPREADSHEET_ID, timestamp: new Date().toISOString() });
});

app.get('/api/health/firebase', authenticate, async (req, res) => {
  const [firestore, storage] = await Promise.allSettled([
    db.listCollections(),
    storageBucket.getMetadata()
  ]);
  const result = {
    firestore: firestore.status === 'fulfilled' ? 'connected' : `unavailable:${firestore.reason.code || firestore.reason.name}`,
    storage: storage.status === 'fulfilled' ? 'connected' : `unavailable:${storage.reason.code || storage.reason.name}`
  };
  const ready = firestore.status === 'fulfilled' && storage.status === 'fulfilled';
  res.status(ready ? 200 : 503).json({ status: ready ? 'connected' : 'degraded', services: result, timestamp: new Date().toISOString() });
});

app.get('/api/invoices/:fileId', authenticate, requireSession, async (req, res) => {
  try {
    const recordSnapshot = await db.collection('invoiceFiles').doc(req.params.fileId).get();
    if (!recordSnapshot.exists) return res.status(404).json({ success: false, message: 'Invoice file not found.' });

    const record = recordSnapshot.data();
    const actor = getSession(req).user;
    if (record.deletedAt || !record.storagePath) return res.status(410).json({ success: false, message: 'This invoice file has been deleted.' });
    let ownerRecord = record;
    if (!record.adminId && !record.customerId && record.orderId) {
      const orderSnapshot = await db.collection('orders').doc(record.orderId).get();
      if (orderSnapshot.exists) ownerRecord = orderSnapshot.data();
    }
    const ownsInvoice = actor.isMaster || (actor.role === 'admin'
      ? sameOwner(ownerRecord.adminId, actor.adminId)
      : String(ownerRecord.customerId || '').trim() === String(actor.customerId || '').trim());
    if (!ownsInvoice) return res.status(403).json({ success: false, message: 'You cannot access this invoice.' });

    res.set({
      'Content-Type': record.contentType || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${String(record.fileName || 'invoice').replace(/["\r\n]/g, '')}"`,
      'Cache-Control': 'private, max-age=300'
    });
    storageBucket.file(record.storagePath).createReadStream()
      .on('error', error => {
        if (!res.headersSent) res.status(502).json({ success: false, message: `Invoice file could not be read: ${error.message}` });
        else res.destroy(error);
      })
      .pipe(res);
  } catch (err) {
    res.status(502).json({ success: false, message: `Invoice access failed: ${err.message}` });
  }
});

app.delete('/api/invoices/:fileId', authenticate, requireSession, async (req, res) => {
  try {
    const invoiceRef = db.collection('invoiceFiles').doc(req.params.fileId);
    const invoiceSnapshot = await invoiceRef.get();
    if (!invoiceSnapshot.exists) return res.status(404).json({ success: false, message: 'Invoice file not found.' });

    const record = invoiceSnapshot.data();
    const actor = getSession(req).user;
    let ownerRecord = record;
    let orderRef = null;
    if (record.orderId) {
      orderRef = db.collection('orders').doc(record.orderId);
      if (!record.adminId && !record.customerId) {
        const orderSnapshot = await orderRef.get();
        if (orderSnapshot.exists) ownerRecord = orderSnapshot.data();
      }
    }
    const ownsInvoice = actor.isMaster || (actor.role === 'admin'
      ? sameOwner(ownerRecord.adminId, actor.adminId)
      : String(ownerRecord.customerId || '').trim() === String(actor.customerId || '').trim());
    if (!ownsInvoice) return res.status(403).json({ success: false, message: 'You cannot delete this invoice.' });
    if (record.storagePath) await storageBucket.file(record.storagePath).delete({ ignoreNotFound: true });
    await invoiceRef.update({ storagePath: '', fileUrl: '', deletedAt: new Date().toISOString() });
    if (orderRef) {
      const orderSnapshot = await orderRef.get();
      if (orderSnapshot.exists) {
        const orderData = orderSnapshot.data();
        const fileId = record.fileId || req.params.fileId;
        const patch = {};
        if (orderData.gstDetails?.fileId === fileId) {
          patch.gstDetails = { ...orderData.gstDetails, fileData: '', fileUrl: '', storagePath: '', attachmentDeleted: true };
        }
        if (Array.isArray(orderData.deliveryPackages)) {
          patch.deliveryPackages = orderData.deliveryPackages.map(packageEntry => packageEntry.gstDetails?.fileId === fileId
            ? { ...packageEntry, gstDetails: { ...packageEntry.gstDetails, fileData: '', fileUrl: '', storagePath: '', attachmentDeleted: true } }
            : packageEntry);
        }
        if (Object.keys(patch).length) await orderRef.update(patch);
      }
    }
    res.json({ success: true, fileId: record.fileId || req.params.fileId });
  } catch (err) {
    res.status(500).json({ success: false, message: `Invoice deletion failed: ${err.message}` });
  }
});

app.post('/api/auth/login', authenticate, rateLimitLogin, async (req, res) => {
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
      const passwordCheck = await verifyPassword(password, adminData);
      if (!passwordCheck.valid) return res.status(401).json({ success: false, message: 'Invalid credentials.' });
      if (adminData.active === false) return res.status(403).json({ success: false, message: 'This admin account is revoked.' });
      const adminId = adminData.adminId || adminSnapshot.docs[0].id;
      if (sameOwner(adminId, MASTER_ADMIN_ID)) return res.status(403).json({ success: false, message: 'This Admin ID is reserved for the Master Admin.' });
      if (passwordCheck.needsUpgrade) await migrateLegacyPassword('admins', 'Admins', adminId, password);
      const user = { name: adminData.name, username: adminData.username, role: 'admin', adminId, customerId: null, isMaster: false, sessionVersion: Number(adminData.sessionVersion) || 0 };
      return res.json({ success: true, user, sessionToken: issueSession(user) });
    }

    const customerSnapshot = await db.collection('customers').where('username', '==', username).limit(1).get();
    if (!customerSnapshot.empty) {
      const customerData = customerSnapshot.docs[0].data();
      const passwordCheck = await verifyPassword(password, customerData);
      if (!passwordCheck.valid) return res.status(401).json({ success: false, message: 'Invalid credentials.' });
      if (customerData.active === false) return res.status(403).json({ success: false, message: 'This booker account is revoked.' });
      const customerId = customerData.id || customerSnapshot.docs[0].id;
      if (passwordCheck.needsUpgrade) await migrateLegacyPassword('customers', 'Customers', customerId, password);
      const user = { name: customerData.name, role: 'customer', adminId: customerData.adminId, customerId, isMaster: false, sessionVersion: Number(customerData.sessionVersion) || 0 };
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
      const activeValue = sheetField(row, ['Active', 'Status']);
      const active = !activeValue || activeValue.toLowerCase() !== 'false' && activeValue.toLowerCase() !== 'revoked' && activeValue.toLowerCase() !== 'inactive';
      return recordUsername === String(username).trim() && active;
    });
    if (record) {
      const passwordCheck = await verifyPassword(password, {
        passwordHash: sheetField(record, ['Password Hash', 'passwordHash']),
        password: sheetField(record, ['Password', 'Admin Password', 'Booker Password', 'password'])
      });
      if (!passwordCheck.valid) return null;
      if (tab === 'Admins') {
        const adminId = sheetField(record, ['Admin ID', 'adminId', 'id']);
        if (sameOwner(adminId, MASTER_ADMIN_ID)) return null;
        if (passwordCheck.needsUpgrade) await migrateLegacyPassword('admins', 'Admins', adminId, password);
        return { name: sheetField(record, ['Admin Name', 'Full Name', 'Name', 'name']), username: sheetField(record, ['Username', 'Admin Username']), role: 'admin', adminId, customerId: null, isMaster: false, sessionVersion: Number(sheetField(record, ['Session Version', 'sessionVersion'])) || 0 };
      }
      const customerId = sheetField(record, ['Customer ID', 'Booker ID', 'id']);
      if (passwordCheck.needsUpgrade) await migrateLegacyPassword('customers', 'Customers', customerId, password);
      return { name: sheetField(record, ['Full Name', 'Customer Name', 'Name', 'name']), role: 'customer', adminId: sheetField(record, ['Admin ID', 'adminId']), customerId, isMaster: false, sessionVersion: Number(sheetField(record, ['Session Version', 'sessionVersion'])) || 0 };
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
  if (!session || !isMasterAdminSession(session.user, MASTER_ADMIN_ID)) {
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

async function loadAccountState(user) {
  const isAdmin = user.role === 'admin';
  const collection = isAdmin ? 'admins' : 'customers';
  const accountId = String(isAdmin ? user.adminId : user.customerId || '').trim();
  if (!accountId) return { exists: false, active: false, sessionVersion: 0 };

  try {
    const snapshot = await db.collection(collection).doc(accountId).get();
    if (snapshot.exists) {
      const account = snapshot.data();
      return { exists: true, active: account.active !== false, sessionVersion: Number(account.sessionVersion) || 0 };
    }
  } catch (firestoreError) {
    console.warn(`Firestore account check failed for ${accountId}; checking Sheets:`, firestoreError.message);
  }

  const tabName = isAdmin ? 'Admins' : 'Customers';
  const idNames = isAdmin ? ['Admin ID', 'adminId', 'id'] : ['Customer ID', 'Booker ID', 'customerId', 'id'];
  const account = await findAccountInSheets(tabName, accountId, idNames);
  if (!account) return { exists: false, active: false, sessionVersion: 0 };

  const activeValue = sheetField(account, ['Active', 'Status']).toLowerCase();
  return {
    exists: true,
    active: !['false', 'revoked', 'inactive'].includes(activeValue),
    sessionVersion: Number(sheetField(account, ['Session Version', 'sessionVersion'])) || 0
  };
}

async function findAccountInSheets(tabName, accountId, idNames) {
  const sheet = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${tabName}!A:Z` });
  return sheetRowsToObjects(sheet.data.values || []).find(record => sameOwner(sheetField(record, idNames), accountId)) || null;
}

async function listLoginAccounts() {
  const accounts = [];
  for (const [collection, tabName, idNames, usernameNames, role] of [
    ['admins', 'Admins', ['adminId', 'Admin ID'], ['username', 'Username', 'Admin Username'], 'admin'],
    ['customers', 'Customers', ['id', 'Customer ID', 'Booker ID'], ['username', 'Username', 'Customer ID', 'Booker ID'], 'customer']
  ]) {
    try {
      const snapshot = await db.collection(collection).get();
      snapshot.docs.forEach(doc => {
        const record = doc.data();
        accounts.push({
          id: idNames.map(name => record[name]).find(Boolean) || doc.id,
          username: usernameNames.map(name => record[name]).find(Boolean) || '',
          role
        });
      });
    } catch (error) {
      console.warn(`Firestore ${collection} uniqueness check unavailable:`, error.message);
    }
    try {
      const sheet = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${tabName}!A:Z` });
      sheetRowsToObjects(sheet.data.values || []).forEach(record => {
        accounts.push({ id: sheetField(record, idNames), username: sheetField(record, usernameNames), role });
      });
    } catch (error) {
      console.warn(`Sheets ${tabName} uniqueness check unavailable:`, error.message);
    }
  }
  return accounts;
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
    if (actor.role === 'customer') {
      const customerId = String(actor.customerId || '').trim();
      let customerRecord = null;
      const customerSnapshot = await db.collection('customers').doc(customerId).get();
      if (customerSnapshot.exists) customerRecord = customerSnapshot.data();
      if (!customerRecord) {
        const customerSheet = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Customers!A:Z' });
        customerRecord = sheetRowsToObjects(customerSheet.data.values || []).find(record =>
          String(record['Customer ID'] || record.customerId || record.id || '').trim() === customerId);
      }
      const customerAdminId = String(customerRecord?.adminId || customerRecord?.['Admin ID'] || '').trim();
      if (!customerAdminId || !sameOwner(customerAdminId, actor.adminId)) {
        return res.status(403).json({ success: false, message: 'Your account ownership could not be verified. Contact your admin.' });
      }
      order.customerId = customerId;
      order.customerName = customerRecord.name || customerRecord['Full Name'] || actor.name;
      order.adminId = customerAdminId;
    }
    if (actor.role === 'admin') {
      const selfCustomerId = `ADMIN-SELF-${actor.adminId}`;
      if (String(order.customerId || '').trim() === selfCustomerId) {
        if (!sameOwner(order.adminId, actor.adminId)) return res.status(403).json({ success: false, message: 'Admin self-orders must belong to the signed-in admin.' });
      } else {
        const customerId = String(order.customerId || '').trim();
        const customerSnapshot = await db.collection('customers').doc(customerId).get();
        let customerOwner = customerSnapshot.exists ? customerSnapshot.data().adminId : '';
        if (!customerSnapshot.exists) {
          const sheetResult = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Customers!A:Z' });
          const sheetCustomer = sheetRowsToObjects(sheetResult.data.values || []).find(record =>
            String(record['Customer ID'] || record.customerId || record.id || '').trim() === customerId);
          customerOwner = sheetCustomer?.['Admin ID'] || sheetCustomer?.adminId || '';
        }
        if (!customerOwner || !sameOwner(customerOwner, order.adminId)
          || (!actor.isMaster && !sameOwner(customerOwner, actor.adminId))) {
          return res.status(403).json({ success: false, message: 'Choose a valid booker managed by this admin.' });
        }
      }
    }
    if (order.productId) {
      const productSnapshot = await db.collection('products').doc(String(order.productId)).get();
      if (!productSnapshot.exists) return res.status(400).json({ success: false, message: 'The selected catalog product no longer exists.' });
      const product = productSnapshot.data();
      if (!canUseProduct(actor, product, order.adminId)) {
        return res.status(product.active === false ? 409 : 403).json({ success: false, message: product.active === false ? 'The selected product is inactive.' : 'The selected product is not assigned to this Admin.' });
      }
      order.productModel = product.name;
    } else if (order.productModel) {
      const namedProducts = await db.collection('products').where('name', '==', order.productModel).get();
      const scopedProduct = namedProducts.docs.find(doc => {
        const product = doc.data();
        return !product.adminId || sameOwner(product.adminId, order.adminId);
      });
      if (scopedProduct?.data().active === false) return res.status(409).json({ success: false, message: 'The selected product is inactive.' });
      if (scopedProduct) return res.status(400).json({ success: false, message: 'Select the mapped catalog product instead of submitting its name as a custom product.' });
    }
    const orderRef = db.collection('orders').doc(String(order.id));
    const existingOrder = await orderRef.get();
    if (existingOrder.exists) {
      const saved = existingOrder.data();
      const sameRequest = String(saved.customerId || '').trim() === String(order.customerId || '').trim()
        && sameOwner(saved.adminId, order.adminId)
        && saved.productModel === order.productModel
        && Number(saved.amountPaid) === Number(order.amountPaid)
        && Number(saved.quantity) === Number(order.quantity);
      if (!sameRequest) return res.status(409).json({ success: false, message: 'That order ID already exists with different order data.' });
      await upsertOrderSheetRow(order);
      return res.json({ success: true, duplicate: true });
    }
    await orderRef.create(order);
    await upsertOrderSheetRow(order);

    res.json({ success: true });
  } catch (err) {
    const status = err.message?.includes('Unsupported invoice') || err.message?.includes('base64 data URL')
      ? 400
      : err.message?.includes('specified bucket does not exist') || err.code === 404 ? 503
      : err.code === 5 || err.message?.includes('NOT_FOUND') ? 404 : 502;
    const message = status === 503
      ? `Firebase Storage bucket is unavailable. Set FIREBASE_STORAGE_BUCKET to the active bucket or create ${STORAGE_BUCKET_NAME}.`
      : `Delivery/GST processing failed: ${err.message}`;
    res.status(status).json({ success: false, message });
  }
});

async function upsertOrderSheetRow(order) {
  await ensureSheetTab('Orders', [
    'Order ID', 'Platform', 'Product Model', 'Quantity', 'Customer Name', 'Customer ID',
    'Card Last 4', 'Amount Paid', 'Payable Due', 'Advance Paid', 'Status', 'Date', 'Admin ID', 'Product ID'
  ]);
  const sheetData = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Orders!A:N' });
  if (sheetData.data.values?.[0]?.length < 14) {
    await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: 'Orders!N1', valueInputOption: 'USER_ENTERED', resource: { values: [['Product ID']] } });
  }
  const rowIndex = (sheetData.data.values || []).findIndex(row => row[0] === order.id);
  const values = [[
    order.id, order.platform, order.productModel, order.quantity || 1, order.customerName,
    order.customerId, order.cardLast4, order.amountPaid, order.payableAmount,
    order.advancePaid || 0, order.status, order.createdAt, order.adminId || '', order.productId || ''
  ]];
  if (rowIndex > 0) {
    await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `Orders!A${rowIndex + 1}:N${rowIndex + 1}`, valueInputOption: 'USER_ENTERED', resource: { values } });
  } else {
    await sheets.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: 'Orders!A:N', valueInputOption: 'USER_ENTERED', resource: { values } });
  }
}

// 2. Delivery & GST Submission
app.post('/api/orders/delivery', authenticate, requireSession, async (req, res) => {
  try {
    const { orderId, platform, model, delivery, gstDetails, packageEntry } = req.body;
    if (!orderId || !delivery || typeof delivery !== 'object') {
      return res.status(400).json({ success: false, message: 'orderId and delivery details are required.' });
    }

    const actor = getSession(req).user;
    const orderRef = db.collection('orders').doc(orderId);
    const orderSnapshot = await orderRef.get();
    if (!orderSnapshot.exists) return res.status(404).json({ success: false, message: 'Booking not found.' });
    const existingOrder = orderSnapshot.data();
    const ownsOrder = actor.isMaster || (actor.role === 'admin'
      ? sameOwner(existingOrder.adminId, actor.adminId)
      : String(existingOrder.customerId || '').trim() === String(actor.customerId || '').trim());
    if (!ownsOrder) return res.status(403).json({ success: false, message: 'You can only edit your own booking.' });

    if (packageEntry) {
      const packageId = String(packageEntry.id || '').trim();
      if (!packageId || !packageEntry.delivery || typeof packageEntry.delivery !== 'object') {
        return res.status(400).json({ success: false, message: 'A package id and delivery details are required.' });
      }
      const uploaded = await uploadInvoiceFile(packageEntry.gstDetails, orderId, true);
      let persistedPackage = {
        id: packageId,
        delivery: packageEntry.delivery,
        gstDetails: uploaded.gstDetails ? {
          ...uploaded.gstDetails,
          adminId: existingOrder.adminId || '',
          customerId: existingOrder.customerId || '',
          orderId,
          packageId
        } : null,
        status: existingOrder.status === 'Pending Approval' ? 'Pending Approval' : 'Out for Delivery',
        submittedAt: packageEntry.submittedAt || new Date().toISOString()
      };

      await db.runTransaction(async transaction => {
        const freshSnapshot = await transaction.get(orderRef);
        if (!freshSnapshot.exists) throw new Error('Booking not found.');
        const current = freshSnapshot.data();
        const packages = Array.isArray(current.deliveryPackages) ? current.deliveryPackages : [];
        const identity = allocateDeliveryPackageIdentity(packages, packageId, current.quantity);
        persistedPackage.sequence = identity.sequence;
        persistedPackage.doNumber = identity.doNumber;
        if (identity.existingIndex >= 0) packages[identity.existingIndex] = persistedPackage;
        else packages.push(persistedPackage);
        const patch = {
          deliveryPackages: packages,
          status: current.status === 'Pending Approval' ? current.status : 'Out for Delivery',
          isToday: current.status !== 'Pending Approval'
        };
        if (!current.delivery) {
          patch.delivery = persistedPackage.delivery;
          patch.gstDetails = persistedPackage.gstDetails;
        }
        transaction.update(orderRef, patch);
      });

      await ensureSheetTab('Delivery_Packages', [
        'Package ID', 'Order ID', 'Platform', 'Model', 'Recipient Name', 'Mobile',
        'Tracking AWB', 'OTP', 'Pincode', 'GSTIN', 'Shop Name', 'Base Amount', 'GST Tax Amount', 'Gross Total', 'Timestamp', 'Status', 'Delivery No', 'Sequence', 'Delivery Date'
      ]);
      const existingHeaders = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Delivery_Packages!Q1:S1' }).catch(() => ({ data: { values: [] } }));
      const headers = existingHeaders.data.values?.[0] || [];
      if (headers[0] !== 'Delivery No' || headers[1] !== 'Sequence' || headers[2] !== 'Delivery Date') {
        await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: 'Delivery_Packages!Q1:S1', valueInputOption: 'RAW', resource: { values: [['Delivery No', 'Sequence', 'Delivery Date']] } });
      }
      const sheetData = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Delivery_Packages!A:A' });
      const packageRow = (sheetData.data.values || []).findIndex(row => row[0] === packageId);
      const packageValues = [[
        packageId, orderId, platform || persistedPackage.delivery.platform, model || existingOrder.productModel,
        persistedPackage.delivery.recipientName, persistedPackage.delivery.mobile, persistedPackage.delivery.tracking,
        persistedPackage.delivery.otp, persistedPackage.delivery.pincode,
        persistedPackage.gstDetails?.gstNumber || 'N/A', persistedPackage.gstDetails?.shopName || 'N/A',
        persistedPackage.gstDetails?.baseAmount || 0, persistedPackage.gstDetails?.gstAmount || 0,
        persistedPackage.gstDetails?.totalAmount || 0, persistedPackage.submittedAt, persistedPackage.status,
        persistedPackage.doNumber, persistedPackage.sequence, persistedPackage.delivery.deliveryDate || ''
      ]];
      if (packageRow > 0) {
        await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `Delivery_Packages!A${packageRow + 1}:S${packageRow + 1}`, valueInputOption: 'USER_ENTERED', resource: { values: packageValues } });
      } else {
        await sheets.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: 'Delivery_Packages!A:S', valueInputOption: 'USER_ENTERED', resource: { values: packageValues } });
      }
      return res.json({ success: true, packageId, sequence: persistedPackage.sequence, doNumber: persistedPackage.doNumber, file: persistedPackage.gstDetails?.fileId ? persistedPackage.gstDetails : null, deletedFileIds: uploaded.deletedFileIds || [] });
    }

    const uploadedInvoice = await uploadInvoiceFile(gstDetails, orderId);
    const persistedGstDetails = uploadedInvoice.gstDetails?.fileData === ''
      ? uploadedInvoice.gstDetails
      : (uploadedInvoice.gstDetails || null);
    if (persistedGstDetails) {
      persistedGstDetails.adminId = existingOrder.adminId || '';
      persistedGstDetails.customerId = existingOrder.customerId || '';
      persistedGstDetails.orderId = orderId;
    }

    await tryFirestore(
      () => orderRef.update({
        delivery,
        gstDetails: persistedGstDetails,
        status: 'Out for Delivery',
        isToday: true
      }),
      `update delivery ${orderId}`
    );

    const previousFileId = existingOrder.gstDetails?.fileId;
    const replacementFileId = persistedGstDetails?.fileId;
    if (previousFileId && replacementFileId && previousFileId !== replacementFileId) {
      await db.collection('invoiceFiles').doc(previousFileId).delete().catch(() => {});
      if (existingOrder.gstDetails.storagePath) {
        await storageBucket.file(existingOrder.gstDetails.storagePath).delete({ ignoreNotFound: true }).catch(() => {});
      }
    }

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
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

app.post('/api/orders/package-status', authenticate, requireSession, async (req, res) => {
  try {
    const { orderId, packageId, status } = req.body;
    const actor = requireAdminSession(req, res);
    if (!actor) return;
    if (!orderId || !packageId || status !== 'Delivered') {
      return res.status(400).json({ success: false, message: 'orderId, packageId, and a valid status are required.' });
    }
    const orderRef = db.collection('orders').doc(orderId);
    const orderSnapshot = await orderRef.get();
    if (!orderSnapshot.exists) return res.status(404).json({ success: false, message: 'Booking not found.' });
    const order = orderSnapshot.data();
    const ownsOrder = actor.isMaster || (actor.role === 'admin'
      ? sameOwner(order.adminId, actor.adminId)
      : String(order.customerId || '').trim() === String(actor.customerId || '').trim());
    if (!ownsOrder) return res.status(403).json({ success: false, message: 'You can only update your own booking.' });
    const result = await db.runTransaction(async transaction => {
      const freshSnapshot = await transaction.get(orderRef);
      if (!freshSnapshot.exists) throw new Error('Booking not found.');
      const current = freshSnapshot.data();
      const packages = Array.isArray(current.deliveryPackages) ? current.deliveryPackages : [];
      const packageIndex = packages.findIndex(item => item.id === packageId);
      if (packageIndex < 0) throw new Error('Delivery package not found.');
      packages[packageIndex] = { ...packages[packageIndex], status };
      const allDelivered = packages.length > 0 && packages.every(item => item.status === 'Delivered');
      transaction.update(orderRef, { deliveryPackages: packages, ...(allDelivered ? { status: 'Delivered' } : {}) });
      return { allDelivered, orderStatus: allDelivered ? 'Delivered' : current.status };
    });
    const sheetData = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Delivery_Packages!A:A' }).catch(() => ({ data: { values: [] } }));
    const rowIndex = (sheetData.data.values || []).findIndex(row => row[0] === packageId);
    if (rowIndex > 0) {
      await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `Delivery_Packages!P${rowIndex + 1}`, valueInputOption: 'USER_ENTERED', resource: { values: [[status]] } });
    }
    if (result.allDelivered) {
      const orderRows = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Orders!A:A' }).catch(() => ({ data: { values: [] } }));
      const orderRow = (orderRows.data.values || []).findIndex(row => row[0] === orderId);
      if (orderRow > 0) {
        await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `Orders!K${orderRow + 1}`, valueInputOption: 'USER_ENTERED', resource: { values: [['Delivered']] } });
      }
    }
    res.json({ success: true, orderId, packageId, status, orderStatus: result.orderStatus });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
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
    const orderRef = db.collection('orders').doc(orderId);
    const orderSnapshot = await orderRef.get();
    if (!orderSnapshot.exists) return res.status(404).json({ success: false, message: 'Booking not found.' });
    if (!canAccessOrder(actor, orderSnapshot.data())) return res.status(403).json({ success: false, message: 'You can only update bookings owned by your account.' });
    const updateObj = { status };
    if (settledAt) updateObj.settledAt = settledAt;
    await orderRef.update(updateObj);

    const sheetData = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Orders!A:A' });
    const rows = sheetData.data.values || [];
    const rowIndex = rows.findIndex(r => r[0] === orderId);

    if (rowIndex !== -1) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `Orders!K${rowIndex + 1}`,
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
    const sheetData = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Orders!A:M' });
    const rows = sheetData.data.values || [];
    const rowIndex = rows.findIndex(row => row[0] === orderId);
    if (!order && rowIndex > 0) order = { adminId: rows[rowIndex][12], status: rows[rowIndex][10] };
    if (!order) return res.status(404).json({ success: false, message: 'Booking not found.' });
    if (!actor.isMaster && order.adminId !== actor.adminId) return res.status(403).json({ success: false, message: 'Only the owning admin can approve this booking.' });
    const hasPackages = Array.isArray(order.deliveryPackages) && order.deliveryPackages.length > 0;
    const approvedStatus = hasPackages ? 'Out for Delivery' : 'Booked';
    const deliveryPackages = hasPackages
      ? order.deliveryPackages.map(packageEntry => ({ ...packageEntry, status: 'Out for Delivery' }))
      : order.deliveryPackages;
    await tryFirestore(() => orderRef.update({
      status: approvedStatus,
      ...(hasPackages ? { deliveryPackages, isToday: true } : {}),
      approvedBy: actor.adminId,
      approvedAt: new Date().toISOString()
    }), `approve order ${orderId}`);
    if (rowIndex > 0) {
      await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `Orders!K${rowIndex + 1}`, valueInputOption: 'USER_ENTERED', resource: { values: [[approvedStatus]] } });
    }
    if (hasPackages) {
      const packageRows = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Delivery_Packages!A:P' }).catch(() => ({ data: { values: [] } }));
      const packageValues = packageRows.data.values || [];
      const packageStatusUpdates = order.deliveryPackages.map(packageEntry => {
        const packageRow = packageValues.findIndex(row => row[0] === packageEntry.id);
        return packageRow > 0 ? sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `Delivery_Packages!P${packageRow + 1}`,
          valueInputOption: 'USER_ENTERED',
          resource: { values: [['Out for Delivery']] }
        }) : null;
      }).filter(Boolean);
      await Promise.all(packageStatusUpdates);
    }
    res.json({ success: true, orderId, status: approvedStatus });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 4. Financial Settlement
app.post('/api/orders/settle', authenticate, requireSession, async (req, res) => {
  try {
    const { orderId, customerId, customerName, amount, notes } = req.body;
    const actor = requireAdminSession(req, res);
    if (!actor) return;
    if (!orderId || !customerId || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ success: false, message: 'A positive settlement amount, orderId, and customerId are required.' });
    }

    const orderSnapshot = await db.collection('orders').doc(orderId).get();
    if (!orderSnapshot.exists) return res.status(404).json({ success: false, message: 'Booking not found.' });
    const order = orderSnapshot.data();
    if (!canAccessOrder(actor, order) || !sameOwner(order.customerId, customerId)) {
      return res.status(403).json({ success: false, message: 'You can only settle bookings owned by your account.' });
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
    if (!actor.isMaster && !sameOwner(customer?.adminId, actor.adminId)) return res.status(403).json({ success: false, message: 'Booker must belong to the active admin.' });
    if (!customer || typeof customer !== 'object' || !customer.id || !customer.name || !customer.password) {
      return res.status(400).json({ success: false, message: 'A Booker ID, name, and password are required.' });
    }
    const customerId = String(customer.id).trim();
    const customerUsername = String(customer.username || customerId).trim();
    customer.name = String(customer.name).trim();
    if (!customer.name || !customerUsername) return res.status(400).json({ success: false, message: 'A Booker name and username are required.' });
    const conflict = findAccountConflict({ id: customerId, username: customerUsername }, await listLoginAccounts());
    if (conflict) return res.status(409).json({ success: false, message: `That Booker ${conflict.field} is already in use.` });
    customer.id = customerId;
    customer.username = customerUsername;
    customer.adminId = actor.isMaster ? String(customer.adminId || MASTER_ADMIN_ID).trim() : actor.adminId;
    customer.active = customer.active !== false;
    customer.sessionVersion = Number(customer.sessionVersion) || 0;
    const savedCustomer = { ...customer, password: '', passwordHash: await hashPassword(customer.password) };
    await tryFirestore(
      () => db.collection('customers').doc(customerId).set(savedCustomer),
      `save customer ${customerId}`
    );

    await ensurePasswordHashColumn('Customers', 9, ['Customer ID', 'Full Name', 'Mobile', 'Password', 'Created By Admin', 'Admin ID', 'Active', 'Timestamp', 'Session Version', 'Password Hash']);
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Customers!A:J',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[customer.id, customer.name, customer.mobile, '', customer.createdByAdmin, customer.adminId || MASTER_ADMIN_ID, customer.active, new Date().toISOString(), customer.sessionVersion, savedCustomer.passwordHash]] }
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
    const productId = String(product.id).trim();
    const requestedAdminId = String(product.adminId || '').trim();
    const productRef = db.collection('products').doc(productId);
    let existingProduct = null;
    let firestoreLookupFailed = false;
    try {
      const existingSnapshot = await productRef.get();
      if (existingSnapshot.exists) existingProduct = existingSnapshot.data();
    } catch (firestoreError) {
      firestoreLookupFailed = true;
      console.warn(`Firestore product lookup failed for ${productId}:`, firestoreError.message);
    }
    if (!actor.isMaster && firestoreLookupFailed) return res.status(503).json({ success: false, message: 'Product ownership could not be verified. Try again shortly.' });
    await ensureSheetTab('Products', ['Product ID', 'Product Name', 'Target Price', 'Commission', 'Admin ID', 'Active', 'Last Synced']);
    const existingRows = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Products!A:G' });
    const existingRowIndex = (existingRows.data.values || []).findIndex((row, index) => index > 0 && String(row[0] || '').trim() === productId);
    const existingSheetRow = existingRowIndex > 0 ? existingRows.data.values[existingRowIndex] : null;
    if (!actor.isMaster) {
      const existingOwner = String(existingProduct?.adminId ?? existingSheetRow?.[4] ?? '').trim();
      if ((existingProduct || existingSheetRow) && !sameOwner(existingOwner, actor.adminId)) {
        return res.status(403).json({ success: false, message: 'You can only manage products assigned to your Admin account.' });
      }
    } else if (requestedAdminId && !sameOwner(requestedAdminId, MASTER_ADMIN_ID)) {
      const assignedAdmin = (await listLoginAccounts()).some(account => account.role === 'admin' && sameOwner(account.id, requestedAdminId));
      if (!assignedAdmin) return res.status(400).json({ success: false, message: 'The assigned Admin account does not exist.' });
    }

    const targetPrice = Number(product.targetPrice);
    const commission = Number(product.commission);
    if (!Number.isFinite(targetPrice) || targetPrice < 0 || !Number.isFinite(commission) || commission < 0) {
      return res.status(400).json({ success: false, message: 'Product price and commission must be valid non-negative numbers.' });
    }

    const productData = {
      ...product,
      id: productId,
      name: String(product.name).trim(),
      targetPrice,
      commission,
      adminId: actor.isMaster ? requestedAdminId : actor.adminId,
      active: !['false', 'inactive', 'revoked'].includes(String(product.active).trim().toLowerCase())
    };
    await productRef.set(productData);
    const sheetData = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Products!A:A' });
    const rowIndex = (sheetData.data.values || []).findIndex(row => String(row[0] || '').trim() === productData.id);
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
    const adminRef = db.collection('admins').doc(adminData.adminId);
    const existingSnapshot = await adminRef.get().catch(() => null);
    const passwordHash = adminData.password
      ? await hashPassword(adminData.password)
      : existingSnapshot?.exists ? existingSnapshot.data().passwordHash || '' : '';
    const savedAdmin = { ...adminData, password: '', ...(passwordHash ? { passwordHash } : {}) };
    await tryFirestore(
      () => adminRef.set(savedAdmin, { merge: true }),
      `save admin ${adminData.adminId}`
    );

    await ensurePasswordHashColumn('Admins', 7, ['Admin ID', 'Admin Name', 'Username', 'Password', 'Active', 'Last Synced', 'Session Version', 'Password Hash']);
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Admins!A:H',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[savedAdmin.adminId, savedAdmin.name, savedAdmin.username, '', savedAdmin.active !== false, new Date().toISOString(), Number(savedAdmin.sessionVersion) || 0, savedAdmin.passwordHash || '']] }
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
    const conflict = findAccountConflict({ id: actor.adminId, excludeId: actor.adminId, username: profile.username }, await listLoginAccounts());
    if (conflict) return res.status(409).json({ success: false, message: 'That username is already used by another account.' });
    const profileData = { adminId: actor.adminId, name: profile.name || actor.name, username: profile.username.trim(), password: '', passwordHash: await hashPassword(profile.password), active: true, sessionVersion: Number(actor.sessionVersion) || 0 };
    await tryFirestore(() => db.collection('admins').doc(actor.adminId).set(profileData, { merge: true }), `update admin profile ${actor.adminId}`);
    await ensurePasswordHashColumn('Admins', 7, ['Admin ID', 'Admin Name', 'Username', 'Password', 'Active', 'Last Synced', 'Session Version', 'Password Hash']);
    const sheetData = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Admins!A:A' });
    const rowIndex = (sheetData.data.values || []).findIndex(row => row[0] === actor.adminId);
    const values = [[profileData.adminId, profileData.name, profileData.username, '', true, new Date().toISOString(), profileData.sessionVersion, profileData.passwordHash]];
    if (rowIndex > 0) {
      await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `Admins!A${rowIndex + 1}:H${rowIndex + 1}`, valueInputOption: 'USER_ENTERED', resource: { values } });
    } else {
      await sheets.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: 'Admins!A:H', valueInputOption: 'USER_ENTERED', resource: { values } });
    }
    res.json({ success: true, profile: withoutCredentials(profileData) });
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

    adminData.adminId = String(adminData.adminId).trim();
    adminData.name = String(adminData.name).trim();
    adminData.username = String(adminData.username).trim();
    if (String(MASTER_ADMIN_USERNAME).trim().toLowerCase() === adminData.username.toLowerCase()) {
      return res.status(409).json({ success: false, message: 'That username is reserved for the Master Admin.' });
    }
    const conflict = findAccountConflict({ id: adminData.adminId, username: adminData.username }, await listLoginAccounts());
    if (conflict) return res.status(409).json({ success: false, message: `That Admin ${conflict.field} is already in use.` });

    const savedAdmin = {
      ...adminData,
      password: '',
      passwordHash: await hashPassword(adminData.password),
      active: adminData.active !== false,
      sessionVersion: Number(adminData.sessionVersion) || 0
    };
    let firestoreSaved = false;
    try {
      await db.collection('admins').doc(savedAdmin.adminId).set(savedAdmin);
      firestoreSaved = true;
    } catch (firestoreError) {
      console.error('Firestore admin create failed; continuing with Sheets:', firestoreError.message);
    }

    await ensurePasswordHashColumn('Admins', 7, ['Admin ID', 'Admin Name', 'Username', 'Password', 'Active', 'Last Synced', 'Session Version', 'Password Hash']);
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Admins!A:H',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[savedAdmin.adminId, savedAdmin.name, savedAdmin.username, '', savedAdmin.active, new Date().toISOString(), savedAdmin.sessionVersion, savedAdmin.passwordHash]] }
    });
    res.json({ success: true, admin: withoutCredentials(savedAdmin), firestoreSaved, sheetsSaved: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/status', authenticate, requireSession, async (req, res) => {
  try {
    if (!requireMaster(req, res)) return;
    const adminId = String(req.body.adminId || '').trim();
    const active = req.body.active === true;
    if (!adminId || sameOwner(adminId, MASTER_ADMIN_ID)) return res.status(400).json({ success: false, message: 'A subordinate adminId is required.' });
    const adminRef = db.collection('admins').doc(adminId);
    let adminSnapshot;
    try {
      adminSnapshot = await adminRef.get();
    } catch (error) {
      return res.status(503).json({ success: false, message: 'Admin status could not be verified in Firestore. Try again shortly.' });
    }
    const sheetAdmin = adminSnapshot.exists ? null : await findAccountInSheets('Admins', adminId, ['Admin ID', 'adminId', 'id']);
    if (!adminSnapshot.exists && !sheetAdmin) return res.status(404).json({ success: false, message: 'Admin not found.' });
    const sessionVersion = (Number(adminSnapshot.exists ? adminSnapshot.data().sessionVersion : sheetField(sheetAdmin, ['Session Version', 'sessionVersion'])) || 0) + 1;
    if (adminSnapshot.exists) await adminRef.update({ active, sessionVersion });
    await syncAccountStatusToSheet('Admins', adminId, active, sessionVersion, 0, 4, 6, ['Admin ID', 'Admin Name', 'Username', 'Password', 'Active', 'Last Synced', 'Session Version']);
    res.json({ success: true, adminId, active, sessionVersion });
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
    const snapshots = new Map();
    for (const collection of collections) {
      const snapshot = await db.collection(collection).where('adminId', '==', adminId).get();
      snapshots.set(collection, snapshot);
      const refs = snapshot.docs.map(doc => doc.ref);
      if (collection === 'admins' && !refs.some(ref => ref.id === adminId)) refs.push(db.collection('admins').doc(adminId));
      for (let index = 0; index < refs.length; index += 400) {
        const batch = db.batch();
        refs.slice(index, index + 400).forEach(ref => batch.delete(ref));
        await batch.commit();
        deletedFirestore += refs.slice(index, index + 400).length;
      }
    }

    const childCustomerIds = (snapshots.get('customers')?.docs || []).map(doc => String(doc.data().id || doc.id));
    const invoiceRecords = new Map();
    const invoiceSnapshot = await db.collection('invoiceFiles').where('adminId', '==', adminId).get();
    invoiceSnapshot.docs.forEach(doc => invoiceRecords.set(doc.id, { ref: doc.ref, data: doc.data() }));
    for (const orderDoc of snapshots.get('orders')?.docs || []) {
      const order = orderDoc.data();
      const invoiceDetails = [order.gstDetails, ...(Array.isArray(order.deliveryPackages) ? order.deliveryPackages.map(item => item.gstDetails) : [])];
      for (const details of invoiceDetails) {
        if (!details?.fileId || invoiceRecords.has(details.fileId)) continue;
        const ref = db.collection('invoiceFiles').doc(details.fileId);
        const fileSnapshot = await ref.get();
        if (fileSnapshot.exists) invoiceRecords.set(details.fileId, { ref, data: fileSnapshot.data() });
        else if (details.storagePath) invoiceRecords.set(details.fileId, { ref: null, data: { storagePath: details.storagePath } });
      }
    }
    for (const [fileId, entry] of invoiceRecords) {
      if (entry.data.storagePath) await storageBucket.file(entry.data.storagePath).delete({ ignoreNotFound: true });
      if (entry.ref) await entry.ref.delete();
      else await db.collection('invoiceFiles').doc(fileId).delete().catch(error => {
        if (error.code !== 5) throw error;
      });
      if (entry.ref) deletedFirestore++;
    }

    const deletedSheets = (await Promise.all([
      deleteSheetRecords('Admins', 0, adminId),
      deleteSheetRecords('Customers', 5, adminId),
      deleteSheetRecords('Products', 4, adminId),
      deleteSheetRecords('Orders', 12, adminId),
      ...childCustomerIds.map(customerId => deleteSheetRecords('Settlements', 1, customerId))
    ])).reduce((total, count) => total + count, 0);
    res.json({ success: true, adminId, deletedFirestore, deletedSheets, deletedInvoiceFiles: invoiceRecords.size });
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
    let customerSnapshot;
    try {
      customerSnapshot = await customerRef.get();
    } catch (error) {
      return res.status(503).json({ success: false, message: 'Booker status could not be verified in Firestore. Try again shortly.' });
    }
    const customer = customerSnapshot.exists
      ? customerSnapshot.data()
      : await findAccountInSheets('Customers', customerId, ['Customer ID', 'Booker ID', 'customerId', 'id']);
    if (!customer) return res.status(404).json({ success: false, message: 'Booker not found.' });
    if (!actor.isMaster && !sameOwner(customer.adminId || customer['Admin ID'], actor.adminId)) {
      return res.status(403).json({ success: false, message: 'Only the owning admin or Master Admin can change this booker.' });
    }
    const nextActive = active === true;
    const sessionVersion = (Number(customer.sessionVersion) || 0) + 1;
    if (customerSnapshot.exists) await customerRef.update({ active: nextActive, sessionVersion });
    await syncAccountStatusToSheet('Customers', customerId, nextActive, sessionVersion, 0, 6, 8, ['Customer ID', 'Full Name', 'Mobile', 'Password', 'Created By Admin', 'Admin ID', 'Active', 'Timestamp', 'Session Version']);
    res.json({ success: true, customerId, active: nextActive, sessionVersion });
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

app.post('/api/customers/delete', authenticate, requireSession, async (req, res) => {
  try {
    const actor = requireAdminSession(req, res);
    const customerId = String(req.body.customerId || '').trim();
    if (!actor || !customerId) return res.status(400).json({ success: false, message: 'customerId is required.' });

    const customerRef = db.collection('customers').doc(customerId);
    let customerSnapshot;
    try {
      customerSnapshot = await customerRef.get();
    } catch (error) {
      return res.status(503).json({ success: false, message: 'Booker ownership could not be verified in Firestore. Try again shortly.' });
    }
    const customer = customerSnapshot.exists
      ? customerSnapshot.data()
      : await findAccountInSheets('Customers', customerId, ['Customer ID', 'Booker ID', 'customerId', 'id']);
    if (!customer) return res.status(404).json({ success: false, message: 'Booker not found.' });
    if (!actor.isMaster && !sameOwner(customer.adminId || customer['Admin ID'], actor.adminId)) {
      return res.status(403).json({ success: false, message: 'Only the owning admin can delete this booker.' });
    }

    const orderSnapshot = await db.collection('orders').where('customerId', '==', customerId).get();
    const invoiceRecords = new Map();
    const customerInvoiceSnapshot = await db.collection('invoiceFiles').where('customerId', '==', customerId).get();
    customerInvoiceSnapshot.docs.forEach(doc => invoiceRecords.set(doc.id, { ref: doc.ref, data: doc.data() }));
    for (const orderDoc of orderSnapshot.docs) {
      const order = orderDoc.data();
      const invoiceDetails = [order.gstDetails, ...(Array.isArray(order.deliveryPackages) ? order.deliveryPackages.map(item => item.gstDetails) : [])];
      for (const details of invoiceDetails) {
        if (!details?.fileId || invoiceRecords.has(details.fileId)) continue;
        const fileRef = db.collection('invoiceFiles').doc(details.fileId);
        const fileSnapshot = await fileRef.get();
        if (fileSnapshot.exists) invoiceRecords.set(details.fileId, { ref: fileRef, data: fileSnapshot.data() });
        else if (details.storagePath) invoiceRecords.set(details.fileId, { ref: null, data: { storagePath: details.storagePath } });
      }
    }

    for (const [fileId, entry] of invoiceRecords) {
      if (entry.data.storagePath) await storageBucket.file(entry.data.storagePath).delete({ ignoreNotFound: true });
      if (entry.ref) await entry.ref.delete();
      else await db.collection('invoiceFiles').doc(fileId).delete().catch(error => {
        if (error.code !== 5) throw error;
      });
    }

    const refs = [customerRef, ...orderSnapshot.docs.map(doc => doc.ref)];
    let deletedFirestore = 0;
    for (let index = 0; index < refs.length; index += 400) {
      const batch = db.batch();
      refs.slice(index, index + 400).forEach(ref => batch.delete(ref));
      await batch.commit();
      deletedFirestore += refs.slice(index, index + 400).length;
    }
    const deletedSheets = (await Promise.all([
      deleteSheetRecords('Customers', 0, customerId),
      deleteSheetRecords('Orders', 5, customerId),
      deleteSheetRecords('Settlements', 1, customerId)
    ])).reduce((total, count) => total + count, 0);
    res.json({ success: true, customerId, deletedOrders: orderSnapshot.size, deletedFiles: invoiceRecords.size, deletedFirestore, deletedSheets });
  } catch (err) {
    res.status(500).json({ success: false, message: `Booker deletion failed: ${err.message}` });
  }
});

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
    const page = normalizePageNumber(req.query.page, 1);
    const pageSize = normalizePageSize(req.query.pageSize, 50, 200);
    const tabs = ['Admins', 'Customers', 'Products', 'Orders'];
    const response = {
      pagination: {
        page,
        pageSize,
        totalCount: 0,
        totalPages: 1,
        hasPreviousPage: false,
        hasNextPage: false
      }
    };
    for (const tab of tabs) {
      try {
        const result = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${tab}!A:Z` });
        const records = sheetRowsToObjects(result.data.values || []);
        const filteredRecords = actor.isMaster ? records : tab === 'Admins'
          ? records.filter(record => ownedBy(record, actor.adminId))
          : records.filter(record => actor.role === 'customer'
            ? tab === 'Products'
              ? ownedBy(record, actor.adminId)
              : String(record['Customer ID'] || record.customerId || record.id || '').trim() === actor.customerId
            : ownedBy(record, actor.adminId));
        const paginated = paginateRecords(filteredRecords, page, pageSize, { defaultPageSize: 100, maxPageSize: 250 });
        response[tab.toLowerCase()] = paginated.items.map(withoutCredentials);
        response.pagination[tab.toLowerCase()] = {
          page: paginated.page,
          pageSize: paginated.pageSize,
          totalCount: paginated.totalCount,
          totalPages: paginated.totalPages,
          hasPreviousPage: paginated.hasPreviousPage,
          hasNextPage: paginated.hasNextPage
        };
      } catch (error) {
        if (error.code === 400 || error.code === 404) {
          response[tab.toLowerCase()] = [];
          response.pagination[tab.toLowerCase()] = { page, pageSize, totalCount: 0, totalPages: 1, hasPreviousPage: false, hasNextPage: false };
          continue;
        }
        throw error;
      }
    }
    try {
      const packageResult = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Delivery_Packages!A:S' });
      const visibleOrderIds = new Set((response.orders || []).map(record =>
        String(record['Order ID'] || record.orderId || record.id || '').trim()).filter(Boolean));
      const packageRecords = sheetRowsToObjects(packageResult.data.values || []).filter(record =>
        visibleOrderIds.has(String(record['Order ID'] || record.orderId || '').trim()));
      const packagePage = paginateRecords(packageRecords, page, pageSize, { defaultPageSize: 100, maxPageSize: 250 });
      response.delivery_packages = packagePage.items;
      response.pagination.delivery_packages = {
        page: packagePage.page,
        pageSize: packagePage.pageSize,
        totalCount: packagePage.totalCount,
        totalPages: packagePage.totalPages,
        hasPreviousPage: packagePage.hasPreviousPage,
        hasNextPage: packagePage.hasNextPage
      };
    } catch (error) {
      if (error.code === 400 || error.code === 404) {
        response.delivery_packages = [];
        response.pagination.delivery_packages = { page, pageSize, totalCount: 0, totalPages: 1, hasPreviousPage: false, hasNextPage: false };
      } else throw error;
    }
    res.json({ success: true, spreadsheetId: SPREADSHEET_ID, data: response });
  } catch (err) {
    res.status(502).json({ success: false, message: `Google Sheets import failed: ${err.message}` });
  }
});

app.get('/api/admin/data/export', authenticate, requireSession, async (req, res) => {
  try {
    const actor = getSession(req).user;
    const page = normalizePageNumber(req.query.page, 1);
    const pageSize = normalizePageSize(req.query.pageSize, 50, 200);
    const [admins, customers, products, orders] = await Promise.all([
      db.collection('admins').get(),
      db.collection('customers').get(),
      db.collection('products').get(),
      db.collection('orders').get()
    ]);
    const collectionData = snapshot => snapshot.docs.map(doc => withoutCredentials({ id: doc.id, ...doc.data() }));
    const scope = records => actor.isMaster ? records : records.filter(record => actor.role === 'customer'
      ? String(record.customerId || record.id || '').trim() === String(actor.customerId || '').trim()
      : sameOwner(record.adminId, actor.adminId));
    const customerProducts = collectionData(products);
    const customerScopedProducts = actor.role === 'customer' && !actor.isMaster
      ? customerProducts.filter(record => sameOwner(record.adminId, actor.adminId))
      : customerProducts;
    const allData = {
      admins: actor.isMaster ? collectionData(admins) : collectionData(admins).filter(record => sameOwner(record.adminId, actor.adminId)),
      customers: scope(collectionData(customers)),
      products: actor.isMaster ? customerProducts : actor.role === 'customer' ? customerScopedProducts : scope(customerProducts),
      orders: scope(collectionData(orders))
    };
    const pagination = {};
    for (const [key, value] of Object.entries(allData)) {
      const pageResult = paginateRecords(value, page, pageSize, { defaultPageSize: 100, maxPageSize: 250 });
      allData[key] = pageResult.items;
      pagination[key] = {
        page: pageResult.page,
        pageSize: pageResult.pageSize,
        totalCount: pageResult.totalCount,
        totalPages: pageResult.totalPages,
        hasPreviousPage: pageResult.hasPreviousPage,
        hasNextPage: pageResult.hasNextPage
      };
    }
    res.json({
      success: true,
      exportedAt: new Date().toISOString(),
      data: allData,
      pagination
    });
  } catch (err) {
    res.status(502).json({ success: false, message: `Cloud data export failed: ${err.message}` });
  }
});

const PORT = process.env.PORT || 5000;
if (require.main === module) {
  const host = ISOLATED_TEST_MODE ? '127.0.0.1' : '0.0.0.0';
  app.listen(PORT, host, () => console.log(`DeviceTrade Backend running on ${host}:${PORT}${ISOLATED_TEST_MODE ? ' (isolated test mode)' : ''}`));
}

module.exports = app;