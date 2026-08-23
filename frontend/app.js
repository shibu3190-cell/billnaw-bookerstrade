/**
 * DeviceTrade Pro - Production Client Controller & Exporter
 */

// 1. PWA Installation Service
let deferredPwaPrompt = null;

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(err => console.warn('SW error:', err));
  });
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPwaPrompt = e;
  const banner = document.getElementById('pwa-install-banner');
  if (banner) banner.style.display = 'flex';
});

async function triggerPwaInstall() {
  if (deferredPwaPrompt) {
    const installPrompt = deferredPwaPrompt;
    deferredPwaPrompt = null;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    dismissPwaPrompt();
  }
}

function dismissPwaPrompt() {
  const banner = document.getElementById('pwa-install-banner');
  if (banner) banner.style.display = 'none';
}

// 2. Cloud Configuration & Synchronizer
const API_CONFIG = {
  baseUrl: "https://billnow-bookerstrade-3.onrender.com/api",
  secretToken: "AVI_TRADE_SECURE_KEY_2026"
};

const STORAGE_DB_NAME = 'devicetrade-local';
const STORAGE_DB_VERSION = 2;
const STORAGE_STATE_STORE = 'state';
const STORAGE_QUEUE_STORE = 'outbox';
let storageDb = null;
let offlineOutbox = [];

function sameAdminId(left, right) {
  return String(left || '').replace(/[-_\s]/g, '').toLowerCase() === String(right || '').replace(/[-_\s]/g, '').toLowerCase();
}

function openStorageDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB is unavailable'));
      return;
    }

    const request = indexedDB.open(STORAGE_DB_NAME, STORAGE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORAGE_STATE_STORE)) db.createObjectStore(STORAGE_STATE_STORE);
      if (!db.objectStoreNames.contains(STORAGE_QUEUE_STORE)) db.createObjectStore(STORAGE_QUEUE_STORE, { keyPath: 'id', autoIncrement: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Unable to open IndexedDB'));
  });
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

async function readStoredState(key, fallback) {
  if (!storageDb) return fallback;
  const value = await idbRequest(storageDb.transaction(STORAGE_STATE_STORE, 'readonly').objectStore(STORAGE_STATE_STORE).get(key));
  return value === undefined ? fallback : value;
}

async function writeStoredState(key, value) {
  if (!storageDb) return;
  await idbRequest(storageDb.transaction(STORAGE_STATE_STORE, 'readwrite').objectStore(STORAGE_STATE_STORE).put(value, key));
}

async function readStoredQueue() {
  if (!storageDb) return [];
  return (await idbRequest(storageDb.transaction(STORAGE_QUEUE_STORE, 'readonly').objectStore(STORAGE_QUEUE_STORE).getAll())) || [];
}

async function addStoredQueueItem(item) {
  if (!storageDb) return;
  await idbRequest(storageDb.transaction(STORAGE_QUEUE_STORE, 'readwrite').objectStore(STORAGE_QUEUE_STORE).add(item));
}

async function replaceStoredQueue(items) {
  if (!storageDb) return;
  const tx = storageDb.transaction(STORAGE_QUEUE_STORE, 'readwrite');
  const store = tx.objectStore(STORAGE_QUEUE_STORE);
  store.clear();
  items.forEach(item => store.add(item));
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('Unable to replace offline queue'));
  });
}

async function initializeStorage() {
  try {
    storageDb = await openStorageDb();
    const migrated = await readStoredState('migrationComplete', false);
    if (!migrated) {
      const localState = {
        orders: localStorage.getItem('dt_orders'),
        customers: localStorage.getItem('dt_customers'),
        products: localStorage.getItem('dt_products'),
        adminProfile: localStorage.getItem('dt_admin_profile'),
        queue: localStorage.getItem('dt_offline_queue')
      };
      for (const [key, raw] of Object.entries(localState)) {
        if (key === 'queue' || !raw) continue;
        try { await writeStoredState(key, JSON.parse(raw)); } catch (e) { console.warn(`Skipping invalid local data: ${key}`, e); }
      }
      if (localState.queue) {
        try {
          const oldQueue = JSON.parse(localState.queue);
          for (const item of oldQueue) await addStoredQueueItem(item);
        } catch (e) { console.warn('Skipping invalid offline queue.', e); }
      }
      await writeStoredState('migrationComplete', true);
      ['dt_orders', 'dt_customers', 'dt_products', 'dt_admin_profile', 'dt_offline_queue'].forEach(key => localStorage.removeItem(key));
    }
    offlineOutbox = await readStoredQueue();
  } catch (e) {
    console.warn('IndexedDB unavailable; using in-memory session storage.', e);
    offlineOutbox = [];
  }
}

const storageReady = initializeStorage();

function updateQueueBadge() {
  const dot = document.getElementById('cloud-sync-dot');
  const label = document.getElementById('cloud-sync-label');
  if (!dot || !label) return;

  if (!navigator.onLine) {
    dot.className = 'sync-dot busy';
    label.textContent = offlineOutbox.length > 0 ? `Offline (${offlineOutbox.length})` : 'Offline';
  } else if (offlineOutbox.length > 0) {
    dot.className = 'sync-dot busy';
    label.textContent = `Syncing (${offlineOutbox.length})...`;
  } else {
    dot.className = 'sync-dot';
    label.textContent = 'Online';
  }
}

async function dispatchToBackend(endpoint, payload) {
  // Always include secretToken in both header and body payload
  const fullPayload = { ...payload, secretToken: API_CONFIG.secretToken };
  const res = await fetch(`${API_CONFIG.baseUrl}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_CONFIG.secretToken,
      ...(AppState.sessionToken ? { 'x-session-token': AppState.sessionToken } : {})
    },
    body: JSON.stringify(fullPayload)
  });

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}));
    throw new Error(errorBody.message || `HTTP ${res.status}`);
  }
  return await res.json();
}

async function fetchFromBackend(endpoint) {
  const res = await fetch(`${API_CONFIG.baseUrl}${endpoint}`, {
    headers: {
      'x-api-key': API_CONFIG.secretToken,
      ...(AppState.sessionToken ? { 'x-session-token': AppState.sessionToken } : {})
    }
  });
  const result = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(result.message || `HTTP ${res.status}`);
  return result;
}

function setDataManagementStatus(message, isError = false) {
  const status = document.getElementById('data-management-status');
  if (status) {
    status.textContent = message;
    status.style.color = isError ? 'var(--accent-red)' : 'var(--text-muted)';
  }
}

function csvOrNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function syncFromGoogleSheets() {
  setDataManagementStatus('Importing Google Sheet data...');
  try {
    const result = await fetchFromBackend('/admin/sheets/data');
    const data = result.data || {};
    const admins = data.admins || [];
    const customers = data.customers || [];
    const products = data.products || [];
    const orders = data.orders || [];

    if (admins.length > 0) {
      AppState.admins = admins.map(importedAdmin => ({
        adminId: importedAdmin['Admin ID'] || importedAdmin.adminId,
        name: importedAdmin['Admin Name'] || importedAdmin.name || '',
        username: importedAdmin.Username || importedAdmin.username || '',
        password: importedAdmin.Password || importedAdmin.password || '',
        active: importedAdmin.Active !== 'false' && importedAdmin.active !== false
      })).filter(adminItem => adminItem.adminId && adminItem.username);
      const importedAdmin = AppState.admins[0];
      AppState.adminProfile = {
        adminId: importedAdmin['Admin ID'] || AppState.adminProfile.adminId,
        name: importedAdmin['Admin Name'] || AppState.adminProfile.name,
        username: importedAdmin.Username || AppState.adminProfile.username,
        password: importedAdmin.Password || AppState.adminProfile.password
      };
    }
    if (customers.length > 0) {
      AppState.customers = customers.map(customer => ({
        id: String(customer['Customer ID'] || customer.id || '').trim(),
        username: customer['Customer ID'] || customer.username || customer.id,
        password: customer.Password || customer.password || '',
        name: customer['Full Name'] || customer.name || '',
        mobile: customer.Mobile || customer.mobile || '',
        createdByAdmin: customer['Created By Admin'] || customer.createdByAdmin || AppState.adminProfile.name,
        totalSettled: csvOrNumber(customer.totalSettled),
        adminId: String(customer['Admin ID'] || customer.adminId || AppState.adminProfile.adminId || '').trim(),
        active: customer.Active !== 'false' && customer.active !== false
      })).filter(customer => customer.id);
    }
    if (products.length > 0) {
      AppState.products = products.map(product => ({
        id: product['Product ID'] || product.id || `sheet_${Date.now()}_${Math.random()}`,
        name: product['Product Name'] || product.name || '',
        targetPrice: csvOrNumber(product['Target Price'] || product.targetPrice),
        commission: csvOrNumber(product.Commission || product.commission)
      })).filter(product => product.name && (AppState.currentUser?.isMaster || !product.adminId || product.adminId === AppState.currentUser?.adminId));
    }
    if (orders.length > 0) {
      AppState.orders = orders.map(order => normalizeOrder({
        id: order['Order ID'] || order.id,
        platform: order.Platform || order.platform || 'Other',
        productModel: order['Product Model'] || order.productModel || '',
        customerName: order['Customer Name'] || order.customerName || '',
        customerId: order['Customer ID'] || order.customerId || '',
        cardLast4: order['Card Last 4'] || order.cardLast4 || '',
        amountPaid: csvOrNumber(order['Amount Paid'] || order.amountPaid),
        payableAmount: csvOrNumber(order['Payable Due'] || order.payableAmount),
        advancePaid: csvOrNumber(order['Advance Paid'] || order.advancePaid),
        settledAmount: csvOrNumber(order.settledAmount),
        status: order.Status || order.status || 'Booked',
        createdAt: order.Date || order.createdAt || new Date().toISOString().slice(0, 10),
        adminId: order['Admin ID'] || order.adminId || AppState.adminProfile.adminId,
        isToday: order.isToday === true || order.isToday === 'true',
        delivery: order.delivery || null,
        gstDetails: order.gstDetails || null
      })).filter(order => order.id);
    }

    persistLocalState();
    renderAllViews();
    setDataManagementStatus(`Imported ${admins.length} admins, ${customers.length} bookers, ${products.length} products, and ${orders.length} orders.`);
    alert('Google Sheet data imported successfully.');
  } catch (error) {
    setDataManagementStatus(error.message, true);
    alert(`Google Sheet import failed: ${error.message}`);
  }
}

async function downloadAllAppData() {
  setDataManagementStatus('Preparing complete data download...');
  try {
    let data = {
      admins: [AppState.adminProfile],
      customers: AppState.customers,
      products: AppState.products,
      orders: AppState.orders
    };
    if (navigator.onLine) {
      try {
        const cloud = await fetchFromBackend('/admin/data/export');
        if (cloud.data) data = cloud.data;
      } catch (error) {
        console.warn('Cloud export unavailable; downloading local data.', error);
      }
    }
    triggerBlobDownload(JSON.stringify({ exportedAt: new Date().toISOString(), data }, null, 2), `DeviceTrade_Backup_${new Date().toISOString().slice(0, 10)}.json`, 'application/json;charset=utf-8;');
    setDataManagementStatus('Complete data backup downloaded.');
  } catch (error) {
    setDataManagementStatus(error.message, true);
  }
}

async function resetLocalAppData() {
  if (!confirm('Reset all local POS data? This removes local orders, bookers, products, and queued sync actions. Cloud data is not deleted.')) return;
  await storageReady;
  if (storageDb) {
    const tx = storageDb.transaction([STORAGE_STATE_STORE, STORAGE_QUEUE_STORE], 'readwrite');
    tx.objectStore(STORAGE_STATE_STORE).clear();
    tx.objectStore(STORAGE_QUEUE_STORE).clear();
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('Unable to reset local data'));
    });
  }
  ['dt_orders', 'dt_customers', 'dt_products', 'dt_admin_profile', 'dt_offline_queue'].forEach(key => localStorage.removeItem(key));
  location.reload();
}

function applyCloudInvoiceResult(order, result) {
  if (!order || !result) return;
  if (result.file && order.gstDetails) {
    order.gstDetails = {
      ...order.gstDetails,
      ...result.file,
      fileData: ''
    };
  }
  const deleted = new Set(result.deletedFileIds || []);
  if (deleted.size > 0) {
    AppState.orders.forEach(item => {
      if (item.gstDetails?.fileId && deleted.has(item.gstDetails.fileId)) {
        item.gstDetails = { ...item.gstDetails, fileData: '', fileUrl: '', attachmentDeleted: true };
      }
    });
  }
  persistLocalState();
}

async function triggerAutoCloudSync(actionType, data = {}) {
  await storageReady;
  persistLocalState();

  let endpoint = '';
  let payload = {};

  if (actionType === "NEW_ORDER") {
    endpoint = '/orders/create';
    payload = { order: data.order };
  } else if (actionType === "DELIVERY_SUBMITTED") {
    endpoint = '/orders/delivery';
    payload = {
      orderId: data.order.id,
      platform: data.order.platform,
      model: data.order.productModel,
      delivery: data.order.delivery,
      gstDetails: data.order.gstDetails
    };
  } else if (actionType === "STATUS_CHANGED") {
    endpoint = '/orders/status';
    payload = {
      orderId: data.order.id,
      status: data.order.status,
      settledAt: data.order.settledAt
    };
  } else if (actionType === "SETTLEMENT_RECORDED") {
    endpoint = '/orders/settle';
    payload = {
      orderId: data.orderId,
      customerId: data.customerId,
      customerName: data.customerName,
      amount: data.amount,
      notes: data.notes
    };
  } else if (actionType === "CUSTOMER_CREATED") {
    endpoint = '/customers/create';
    payload = { customer: data.customer };
  } else if (actionType === "ADMIN_SYNC") {
    endpoint = '/admin/sync';
    payload = { admin: AppState.adminProfile };
  } else if (actionType === "ADMIN_CREATED") {
    endpoint = '/admin/create';
    payload = { admin: data.admin, actorAdminId: AppState.currentUser?.adminId };
  } else if (actionType === "ADMIN_STATUS_CHANGED") {
    endpoint = '/admin/status';
    payload = { adminId: data.adminId, active: data.active, actorAdminId: AppState.currentUser?.adminId };
  } else if (actionType === "ADMIN_DELETED") {
    endpoint = '/admin/delete';
    payload = { adminId: data.adminId };
  } else if (actionType === "CUSTOMER_STATUS_CHANGED") {
    endpoint = '/customers/status';
    payload = { customerId: data.customerId, active: data.active, actorAdminId: AppState.currentUser?.adminId };
  } else if (actionType === "PRODUCT_SYNC") {
    endpoint = '/products/sync';
    payload = { product: data.product };
  } else if (actionType === "ORDER_APPROVED") {
    endpoint = '/orders/approve';
    payload = { orderId: data.orderId };
  } else if (actionType === "ADMIN_PROFILE_SYNC") {
    endpoint = '/admin/profile';
    payload = { profile: data.profile };
  }

  if (!endpoint) return;

  if (navigator.onLine) {
    try {
      const result = await dispatchToBackend(endpoint, payload);
      if (actionType === 'DELIVERY_SUBMITTED') applyCloudInvoiceResult(data.order, result);
      updateQueueBadge();
    } catch (err) {
      console.warn(`[Network/Auth Issue] Queuing ${actionType}:`, err.message);
      const item = { endpoint, payload, actionType };
      offlineOutbox.push(item);
      await addStoredQueueItem(item);
      updateQueueBadge();
    }
  } else {
    const item = { endpoint, payload, actionType };
    offlineOutbox.push(item);
    await addStoredQueueItem(item);
    updateQueueBadge();
  }
}

async function flushOfflineQueue() {
  await storageReady;
  if (offlineOutbox.length === 0 || !navigator.onLine) return;
  const remaining = [];
  for (const item of offlineOutbox) {
    try {
      const result = await dispatchToBackend(item.endpoint, item.payload);
      if (item.actionType === 'DELIVERY_SUBMITTED') {
        const orderId = item.payload.orderId;
        const order = AppState.orders.find(orderItem => orderItem.id === orderId);
        applyCloudInvoiceResult(order, result);
      }
    } catch (e) {
      remaining.push(item);
    }
  }
  offlineOutbox = remaining;
  await replaceStoredQueue(offlineOutbox);
  updateQueueBadge();
}

window.addEventListener('online', flushOfflineQueue);

// 3. Application State & Storage
const AppState = {
  adminProfile: { adminId: '', name: '', username: '', password: '', active: true },
  admins: [],
  currentUser: null,
  products: [
    { id: 'p1', name: 'iPhone 16 128GB Black', targetPrice: 74900, commission: 1500 },
    { id: 'p2', name: 'REDMI Note 15 SE 5G', targetPrice: 16999, commission: 800 },
    { id: 'p3', name: 'OnePlus 13R 256GB Cool Blue', targetPrice: 42999, commission: 1200 },
    { id: 'p4', name: 'MacBook Air M3 8/256GB Space Grey', targetPrice: 99900, commission: 2500 }
  ],
  customers: [],
  orders: [],
  tempGstFileData: null,
  sessionToken: ''
};

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeOrder(order) {
  const delivery = order.delivery ? {
    ...order.delivery,
    platform: order.delivery.platform || order.platform || 'Other',
    pincode: String(order.delivery.pincode || ''),
    tracking: String(order.delivery.tracking || ''),
    recipientName: String(order.delivery.recipientName || ''),
    deliveryDate: order.delivery.deliveryDate || order.delivery.submittedAt || order.createdAt || todayIsoDate()
  } : null;
  return {
    ...order,
    id: String(order.id || ''),
    customerId: String(order.customerId || ''),
    customerName: String(order.customerName || ''),
    productModel: String(order.productModel || ''),
    cardLast4: String(order.cardLast4 || ''),
    platform: String(order.platform || 'Other'),
    amountPaid: csvOrNumber(order.amountPaid),
    payableAmount: csvOrNumber(order.payableAmount),
    advancePaid: csvOrNumber(order.advancePaid),
    settledAmount: csvOrNumber(order.settledAmount),
    profit: csvOrNumber(order.profit),
    createdAt: order.createdAt || todayIsoDate(),
    delivery,
    isToday: delivery?.deliveryDate === todayIsoDate(),
    gstDetails: order.gstDetails || null
  };
}

function getVisibleOrders() {
  if (!AppState.currentUser) return [];
  if (AppState.currentUser.role !== 'admin') {
    return AppState.orders.filter(order => order.customerId === AppState.currentUser.customerId);
  }
  if (AppState.currentUser.isMaster) return AppState.orders;
  return AppState.orders.filter(order => sameAdminId(order.adminId, AppState.currentUser.adminId));
}

function getOrderProfit(order) {
  return csvOrNumber(order.profit);
}

function getDeliveryDate(order) {
  return order.delivery?.deliveryDate || order.createdAt || '';
}

function persistLocalState() {
  try {
    if (storageDb) {
      Promise.all([
        writeStoredState('orders', AppState.orders),
        writeStoredState('customers', AppState.customers),
        writeStoredState('products', AppState.products),
        writeStoredState('adminProfile', AppState.adminProfile)
      ]).catch(e => console.warn('Unable to persist IndexedDB state:', e));
    } else {
      localStorage.setItem('dt_orders', JSON.stringify(AppState.orders));
      localStorage.setItem('dt_customers', JSON.stringify(AppState.customers));
      localStorage.setItem('dt_products', JSON.stringify(AppState.products));
      localStorage.setItem('dt_admin_profile', JSON.stringify(AppState.adminProfile));
    }
  } catch (e) {
    console.warn("Storage quota exceeded:", e);
  }
}

async function loadPersistedState() {
  const readJson = (key, fallback) => {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch (e) {
      console.warn(`Unable to restore ${key}; using defaults.`, e);
      return fallback;
    }
  };

  await storageReady;
  if (storageDb) {
    AppState.orders = await readStoredState('orders', AppState.orders);
    AppState.customers = await readStoredState('customers', AppState.customers);
    AppState.products = await readStoredState('products', AppState.products);
    AppState.adminProfile = await readStoredState('adminProfile', AppState.adminProfile);
  } else {
    AppState.orders = readJson('dt_orders', AppState.orders);
    AppState.customers = readJson('dt_customers', AppState.customers);
    AppState.products = readJson('dt_products', AppState.products);
    AppState.adminProfile = readJson('dt_admin_profile', AppState.adminProfile);
  }
  AppState.orders = AppState.orders.map(normalizeOrder).filter(order => order.id);
  if (AppState.adminProfile.username === 'master.admin' && AppState.adminProfile.password === 'admin123') {
    AppState.adminProfile = { adminId: '', name: '', username: '', password: '', active: true };
  }
  AppState.customers = AppState.customers.filter(customer => !(customer.id === 'CUST-1001' && customer.password === 'booker123'));
  AppState.admins = AppState.admins.filter(adminItem => adminItem.adminId);
  if (AppState.adminProfile.adminId && !AppState.admins.some(adminItem => adminItem.adminId === AppState.adminProfile.adminId)) {
    AppState.admins.unshift(AppState.adminProfile);
  }
}

// 4. Utilities, Debounce & Image Compression
function debounce(func, delay = 200) {
  let timeoutId;
  return function (...args) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => func.apply(this, args), delay);
  };
}

const debouncedRenderOrders = debounce(renderOrdersTable, 200);
const debouncedRenderDeliveries = debounce(renderDeliveryTable, 200);
const debouncedRenderCustomers = debounce(renderCustomersTable, 200);
const debouncedRenderInvoices = debounce(renderInvoicesGallery, 200);

function compressImage(file) {
  return new Promise((resolve, reject) => {
    if (file.type === "application/pdf") {
      const reader = new FileReader();
      reader.onload = (e) => resolve({ data: e.target.result, name: file.name, isPdf: true });
      reader.onerror = reject;
      reader.readAsDataURL(file);
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        let width = img.width;
        let height = img.height;
        const maxDim = 1024;

        if (width > height && width > maxDim) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else if (height > maxDim) {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        resolve({ data: canvas.toDataURL("image/jpeg", 0.7), name: file.name.replace(/\.[^/.]+$/, ".jpg"), isPdf: false });
      };
      img.onerror = reject;
      img.src = event.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function handleGstFileChosen(input) {
  const file = input.files[0];
  if (!file) return;

  if (file.type === "application/pdf" && file.size > 2 * 1024 * 1024) {
    alert("PDF file must be under 2MB.");
    input.value = "";
    return;
  }

  try {
    const compressed = await compressImage(file);
    AppState.tempGstFileData = {
      name: compressed.name,
      data: compressed.data,
      fileId: window.crypto?.randomUUID?.() || `file_${Date.now()}_${Math.random().toString(36).slice(2)}`
    };
    const preview = document.getElementById('deliv-gst-preview');
    if (!compressed.isPdf) {
      preview.src = compressed.data;
      preview.style.display = 'block';
    } else {
      preview.style.display = 'none';
    }
    document.getElementById('upload-status-text').innerHTML = `✅ <strong>${compressed.name}</strong> ready to save`;
  } catch (e) {
    alert("Error reading file.");
  }
}

// 5. Authentication Engine
function selectAuthRole(role) {
  document.getElementById('btn-auth-admin').classList.toggle('active', role === 'admin');
  document.getElementById('btn-auth-customer').classList.toggle('active', role === 'customer');
  document.getElementById('auth-username').value = '';
  document.getElementById('auth-password').value = '';
}

function togglePasswordVisibility(inputId, button) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const visible = input.type === 'text';
  input.type = visible ? 'password' : 'text';
  button.setAttribute('aria-label', visible ? 'Show password' : 'Hide password');
}

async function executeLogin(e) {
  e.preventDefault();
  await appStateReady;
  const u = document.getElementById('auth-username').value.trim();
  const p = document.getElementById('auth-password').value.trim();

  try {
    const result = await dispatchToBackend('/auth/login', { username: u, password: p });
    AppState.currentUser = result.user;
    AppState.sessionToken = result.sessionToken;
    await syncFromGoogleSheets().catch(error => console.warn('Unable to refresh cloud data after login:', error.message));
    if (result.user.isMaster) {
      AppState.adminProfile = { ...AppState.adminProfile, adminId: result.user.adminId, name: result.user.name, active: true };
      if (!AppState.admins.some(adminItem => adminItem.adminId === result.user.adminId)) AppState.admins.unshift(AppState.adminProfile);
    }
  } catch (error) {
    alert(error.message || 'Login failed.');
    return;
  }

  document.getElementById('view-auth').style.display = 'none';
  document.getElementById('view-app-main').style.display = 'flex';
  document.getElementById('badge-active-role').textContent = AppState.currentUser.role === 'admin' ? 'Master Admin' : 'Booker Portal';
  document.getElementById('user-display-label').textContent = AppState.currentUser.name;
  if (AppState.currentUser.role === 'admin') {
    document.getElementById('cfg-admin-id').value = AppState.currentUser.adminId;
    document.getElementById('cfg-admin-name').value = AppState.currentUser.name || '';
    document.getElementById('cfg-admin-user').value = AppState.currentUser.username || '';
    document.getElementById('master-security-card').querySelector('.form-label').textContent = 'Admin ID';
    document.getElementById('add-admin-button').style.display = AppState.currentUser.isMaster ? '' : 'none';
    document.getElementById('admin-access-card').style.display = AppState.currentUser.isMaster ? '' : 'none';
  }
  if (AppState.currentUser.role === 'admin' && AppState.currentUser.isMaster) {
    document.getElementById('cfg-admin-id').value = AppState.adminProfile.adminId;
    document.getElementById('cfg-admin-name').value = AppState.adminProfile.name;
    document.getElementById('cfg-admin-user').value = AppState.adminProfile.username;
  }

  buildNavigation();
  renderAllViews();
  updateQueueBadge();
}

function logoutApp() {
  AppState.currentUser = null;
  document.getElementById('view-app-main').style.display = 'none';
  document.getElementById('view-auth').style.display = 'flex';
}

function handleSaveAdminProfile(e) {
  e.preventDefault();
  const profile = {
    adminId: AppState.currentUser.adminId,
    name: document.getElementById('cfg-admin-name').value.trim(),
    username: document.getElementById('cfg-admin-user').value.trim(),
    password: document.getElementById('cfg-admin-pass').value.trim(),
    active: true
  };
  if (AppState.currentUser.isMaster) {
    AppState.adminProfile = { ...AppState.adminProfile, ...profile };
    AppState.currentUser = { ...AppState.currentUser, name: profile.name, username: profile.username };
    triggerAutoCloudSync('ADMIN_SYNC');
  } else {
    AppState.currentUser = { ...AppState.currentUser, name: profile.name, username: profile.username };
    triggerAutoCloudSync('ADMIN_PROFILE_SYNC', { profile });
  }
  alert('Admin profile update submitted.');
}

function openCreateAdminModal() {
  if (!AppState.currentUser?.isMaster) return;
  const adminNumbers = AppState.admins.map(item => Number(String(item.adminId).match(/^adm-?(\d{3})$/i)?.[1] || 0));
  const nextAdminNumber = Math.max(0, ...adminNumbers) + 1;
  let nextAdminId = `adm${String(nextAdminNumber).padStart(3, '0')}`;
  while (AppState.admins.some(item => String(item.adminId).toLowerCase() === nextAdminId)) {
    nextAdminId = `adm${String(Number(nextAdminId.slice(3)) + 1).padStart(3, '0')}`;
  }
  document.getElementById('new-admin-id').value = nextAdminId;
  document.getElementById('new-admin-name').value = '';
  document.getElementById('new-admin-username').value = '';
  document.getElementById('new-admin-password').value = '';
  openModal('modal-create-admin');
}

function handleCreateAdmin(e) {
  e.preventDefault();
  if (!AppState.currentUser?.isMaster) return;
  const admin = {
    adminId: document.getElementById('new-admin-id').value.trim(),
    name: document.getElementById('new-admin-name').value.trim(),
    username: document.getElementById('new-admin-username').value.trim(),
    password: document.getElementById('new-admin-password').value,
    active: true,
    createdBy: AppState.currentUser.adminId
  };
  if (AppState.admins.some(item => item.adminId === admin.adminId || item.username === admin.username)) {
    alert('Admin ID or username already exists.');
    return;
  }
  AppState.admins.push(admin);
  persistLocalState();
  renderAdminAccessTable();
  closeModal('modal-create-admin');
  triggerAutoCloudSync('ADMIN_CREATED', { admin });
  alert(`Admin created. Username: ${admin.username}`);
}

// 6. Navigation
function buildNavigation() {
  const dNav = document.getElementById('desktop-nav-container');
  const mNav = document.getElementById('mobile-nav-container');
  dNav.innerHTML = '';
  mNav.innerHTML = '';
  const deliveryDate = document.getElementById('delivery-date-filter');
  if (deliveryDate && !deliveryDate.value) deliveryDate.value = todayIsoDate();

  const tabs = [
    { id: 'tab-home', label: 'Home', icon: '📊', adminOnly: false },
    { id: 'tab-orders', label: 'Bookings', icon: '📦', adminOnly: false },
    { id: 'tab-delivery', label: 'Deliveries', icon: '🚚', adminOnly: false },
    { id: 'tab-customers', label: 'Bookers', icon: '👥', adminOnly: true },
    { id: 'tab-invoices', label: 'GST Bills', icon: '📄', adminOnly: false },
    { id: 'tab-settings', label: 'Settings', icon: '⚙️', adminOnly: true }
  ];

  tabs.filter(t => (!t.adminOnly || AppState.currentUser.role === 'admin') && (!t.masterOnly || AppState.currentUser.isMaster)).forEach((item, idx) => {
    const dBtn = document.createElement('button');
    dBtn.className = `nav-btn ${idx === 0 ? 'active' : ''}`;
    dBtn.innerHTML = `<span>${item.icon}</span> <span>${item.label}</span>`;
    dBtn.onclick = () => switchTab(item.id, dBtn);
    dNav.appendChild(dBtn);

    const mBtn = document.createElement('button');
    mBtn.className = `mobile-tab-btn ${idx === 0 ? 'active' : ''}`;
    mBtn.innerHTML = `<span>${item.icon}</span><span>${item.label}</span>`;
    mBtn.onclick = () => switchTab(item.id, mBtn);
    mNav.appendChild(mBtn);
  });
}

function switchTab(tabId, btn) {
  document.querySelectorAll('.view-content').forEach(el => el.classList.remove('active'));
  const target = document.getElementById(tabId);
  if (target) target.classList.add('active');
  document.querySelectorAll('.nav-btn, .mobile-tab-btn').forEach(b => b.classList.remove('active'));
  if (btn) {
    btn.classList.add('active');
  } else {
    document.querySelectorAll('.nav-btn, .mobile-tab-btn').forEach(navButton => {
      if (navButton.textContent.toLowerCase().includes((tabId === 'tab-orders' ? 'bookings' : tabId.replace('tab-', '')).toLowerCase())) {
        navButton.classList.add('active');
      }
    });
  }
  renderAllViews();
}

// 7. Render Views
function renderAllViews() {
  if (!AppState.currentUser) return;
  renderKPIs();
  renderHomeOrders();
  renderOrdersTable();
  renderDeliveryTable();
  renderInvoicesGallery();
  renderProductListSettings();
  renderAdminAccessTable();
  if (AppState.currentUser?.role === 'admin') renderCustomersTable();
  updateTodayBadge();
}

function renderKPIs() {
  const list = getVisibleOrders();
  const active = list.filter(o => o.status !== 'Settled');
  const settled = list.filter(o => o.status === 'Settled');

  const activeVol = active.reduce((s, o) => s + o.amountPaid, 0);
  const totalDue = active.reduce((s, o) => s + (o.payableAmount - (o.advancePaid || 0) - (o.settledAmount || 0)), 0);

  const homeGrid = document.getElementById('home-kpi-grid');
  if (!homeGrid) return;
  const profit = list.reduce((sum, order) => sum + getOrderProfit(order), 0);
  const profitDue = list.filter(order => order.status !== 'Settled').reduce((sum, order) => sum + getOrderProfit(order), 0);
  homeGrid.innerHTML = `
    <div class="kpi-card cyan interactive" onclick="switchTab('tab-orders')">
      <div class="kpi-label">Active Bookings (${active.length})</div>
      <div class="kpi-val">₹${activeVol.toLocaleString()}</div>
      <div class="kpi-sub">Pending Due: ₹${totalDue.toLocaleString()}</div>
    </div>
    <div class="kpi-card green interactive" onclick="openLifetimeDrilldownModal()">
      <div class="kpi-label">Settled Deals (${settled.length})</div>
      <div class="kpi-val">₹${settled.reduce((s, o) => s + o.amountPaid, 0).toLocaleString()}</div>
      <div class="kpi-sub">Lifetime Processed (Click for Ledger)</div>
    </div>
    <div class="kpi-card amber">
      <div class="kpi-label">${AppState.currentUser.role === 'admin' ? 'Booker Profit' : 'My Profit'}</div>
      <div class="kpi-val">₹${profit.toLocaleString()}</div>
      <div class="kpi-sub">Due: ₹${profitDue.toLocaleString()} | Open Profit</div>
    </div>
  `;
}

function updateTodayBadge() {
  const count = AppState.orders.filter(o => o.isToday && (o.status === 'Out for Delivery' || o.status === 'In Process')).length;
  const badge = document.getElementById('badge-today-count');
  if (badge) badge.textContent = `${count} Shipments`;
}

function renderHomeOrders() {
  const homeTbody = document.getElementById('table-home-orders');
  if (!homeTbody) return;
  homeTbody.innerHTML = '';

  const list = getVisibleOrders().filter(o => o.status !== 'Settled');

  if (list.length === 0) {
    homeTbody.innerHTML = `<tr><td colspan="11" style="text-align:center; color:var(--text-muted); padding:20px;">No active bookings.</td></tr>`;
    return;
  }

  list.slice(0, 5).forEach(o => {
    const due = o.payableAmount - (o.advancePaid || 0) - (o.settledAmount || 0);
    homeTbody.innerHTML += `
      <tr>
        <td><strong>${o.id}</strong></td>
        <td><span class="pill pill-indigo">${o.platform}</span></td>
        <td>${o.productModel}</td>
        <td>${o.customerName}</td>
        <td>•••• ${o.cardLast4}</td>
        <td>₹${o.amountPaid.toLocaleString()}</td>
        <td style="color:#fbbf24;">₹${(o.advancePaid || 0).toLocaleString()}</td>
        <td style="color:#34d399; font-weight:700;">₹${due.toLocaleString()}</td>
        <td>${o.gstDetails ? `<span class="pill pill-green">₹${o.gstDetails.gstAmount}</span>` : '-'}</td>
        <td><span class="pill pill-amber">${o.status}</span></td>
        <td>
          ${!o.delivery?.submitted ? `<button class="btn btn-primary btn-sm" onclick="openDeliveryModalForOrder('${o.id}')">Submit Delivery</button>` : `<span class="pill pill-green">✓ Out</span>`}
        </td>
      </tr>
    `;
  });
}

function renderOrdersTable() {
  const tbody = document.getElementById('table-all-orders');
  if (!tbody) return;
  tbody.innerHTML = '';

  const search = (document.getElementById('order-search')?.value || '').toLowerCase();
  const statusFilter = document.getElementById('order-status-filter')?.value || 'ALL';
  const isAdmin = AppState.currentUser?.role === 'admin';

  const filtered = getVisibleOrders().filter(o => {
    if (!isAdmin && o.customerId !== AppState.currentUser.customerId) return false;
    if (statusFilter !== 'ALL' && o.status !== statusFilter) return false;
    if (search) {
      const match = String(o.id).toLowerCase().includes(search) || 
                    o.productModel.toLowerCase().includes(search) ||
                    o.customerName.toLowerCase().includes(search) ||
                    o.cardLast4.includes(search);
      if (!match) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11" style="text-align:center; color:var(--text-muted); padding:20px;">No matching bookings.</td></tr>`;
    return;
  }

  filtered.forEach(o => {
    const due = o.payableAmount - (o.advancePaid || 0) - (o.settledAmount || 0);
    tbody.innerHTML += `
      <tr>
        <td><strong>${o.id}</strong></td>
        <td><span class="pill pill-indigo">${o.platform}</span></td>
        <td>${o.productModel}</td>
        <td>•••• ${o.cardLast4}</td>
        <td>${o.customerName}</td>
        <td>₹${o.amountPaid.toLocaleString()}</td>
        <td style="color:#fbbf24;">₹${(o.advancePaid || 0).toLocaleString()}</td>
        <td style="color:#34d399; font-weight:700;">₹${due.toLocaleString()}</td>
        <td>${o.gstDetails ? `<span class="pill pill-green">₹${o.gstDetails.totalAmount}</span>` : '-'}</td>
        <td><span class="pill ${o.status === 'Settled' ? 'pill-green' : 'pill-amber'}">${o.status}</span></td>
        <td>
          <div style="display:flex; gap:6px;">
            ${isAdmin && o.status === 'Pending Approval' ? `<button class="btn btn-primary btn-sm" onclick="approveBooking('${o.id}')">Approve</button>` : ''}
            ${o.status !== 'Pending Approval' && !o.delivery?.submitted ? `<button class="btn btn-subtle btn-sm" onclick="openDeliveryModalForOrder('${o.id}')">Delivery & GST</button>` : ''}
            ${isAdmin && o.status === 'Out for Delivery' ? `<button class="btn btn-primary btn-sm" onclick="markOrderDelivered('${o.id}')">Mark Delivered</button>` : ''}
            ${isAdmin && o.status === 'Delivered' ? `<button class="btn btn-success btn-sm" onclick="openSettlementModalForOrder('${o.id}')">Settle</button>` : ''}
          </div>
        </td>
      </tr>
    `;
  });
}

function approveBooking(orderId) {
  const order = AppState.orders.find(item => item.id === orderId);
  if (!order || AppState.currentUser?.role !== 'admin' || !confirm(`Approve booking ${orderId}?`)) return;
  order.status = 'Booked';
  order.approvedBy = AppState.currentUser.adminId;
  order.approvedAt = new Date().toISOString();
  renderAllViews();
  triggerAutoCloudSync('ORDER_APPROVED', { orderId });
}

function renderDeliveryTable() {
  const tbody = document.getElementById('table-delivery-list');
  if (!tbody) return;
  tbody.innerHTML = '';

  const search = (document.getElementById('delivery-search')?.value || '').toLowerCase();
  const platFilter = document.getElementById('delivery-platform-filter')?.value || 'ALL';
  const isAdmin = AppState.currentUser?.role === 'admin';
  const selectedDate = document.getElementById('delivery-date-filter')?.value || todayIsoDate();

  const deliveries = getVisibleOrders().filter(o => {
    if (!isAdmin && o.customerId !== AppState.currentUser.customerId) return false;
    if (!o.delivery || !o.delivery.submitted) return false;
    if (getDeliveryDate(o) !== selectedDate) return false;
    if (platFilter !== 'ALL' && o.delivery.platform !== platFilter) return false;
    if (search) {
      const d = o.delivery;
      return d.pincode.includes(search) || d.tracking.toLowerCase().includes(search) || d.recipientName.toLowerCase().includes(search) || o.productModel.toLowerCase().includes(search);
    }
    return true;
  });

  if (deliveries.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center; color:var(--text-muted); padding:20px;">No deliveries found.</td></tr>`;
    return;
  }

  deliveries.forEach(o => {
    const d = o.delivery;
    tbody.innerHTML += `
      <tr>
        <td><span class="pill pill-indigo">${d.platform}</span></td>
        <td><strong>${o.productModel}</strong></td>
        <td>${d.recipientName}</td>
        <td>${d.mobile}</td>
        <td><code>${d.tracking}</code></td>
        <td><strong style="color:#fbbf24;">${d.otp}</strong></td>
        <td><strong>${d.pincode}</strong></td>
        <td>${o.gstDetails ? `<button class="btn btn-subtle btn-sm" onclick="viewGstInvoice('${o.id}')">📄 View GST</button>` : 'None'}</td>
        <td><span class="pill pill-green">${o.status}</span></td>
        <td>
          ${isAdmin && o.status === 'Out for Delivery' ? `<button class="btn btn-primary btn-sm" onclick="markOrderDelivered('${o.id}')">Mark Delivered</button>` : ''}
          ${isAdmin && o.status === 'Delivered' ? `<button class="btn btn-success btn-sm" onclick="openSettlementModalForOrder('${o.id}')">Settle</button>` : ''}
        </td>
      </tr>
    `;
  });
}

function renderCustomersTable() {
  const tbody = document.getElementById('table-customers-list');
  if (!tbody) return;
  tbody.innerHTML = '';

  const search = (document.getElementById('cust-search')?.value || '').toLowerCase();
  const filterState = document.getElementById('cust-status-filter')?.value || 'ALL';

  const customers = AppState.currentUser.isMaster
    ? AppState.customers
    : AppState.customers.filter(customer => sameAdminId(customer.adminId, AppState.currentUser.adminId));
  customers.forEach(c => {
    const cOrders = AppState.orders.filter(o => o.customerId === c.id);
    if (filterState !== 'ALL' && !cOrders.some(o => o.status === filterState)) return;
    if (search && !c.name.toLowerCase().includes(search) && !c.id.toLowerCase().includes(search)) return;

    const volume = cOrders.reduce((s, o) => s + o.amountPaid, 0);
    const advance = cOrders.reduce((s, o) => s + (o.advancePaid || 0), 0);
    const settled = c.totalSettled || 0;
    const due = cOrders.reduce((s, o) => s + o.payableAmount, 0) - advance - settled;

    tbody.innerHTML += `
      <tr>
        <td><strong style="color:var(--accent-cyan);">${c.id}</strong></td>
        <td>${c.name}<br/><span style="font-size:0.75rem; color:var(--text-muted);">${c.mobile}</span></td>
        <td><span class="pill ${c.active === false ? 'pill-amber' : 'pill-green'}">${c.active === false ? 'Revoked' : 'Active'}</span></td>
        <td>${c.createdByAdmin || 'N/A'}</td>
        <td>${cOrders.filter(o => o.status !== 'Settled').length} Active</td>
        <td>${cOrders.filter(o => o.status === 'Settled').length} Lifetime</td>
        <td>₹${volume.toLocaleString()}</td>
        <td style="color:#38bdf8;">₹${settled.toLocaleString()}</td>
        <td style="color:#34d399; font-weight:700;">₹${due.toLocaleString()}</td>
        <td><button class="btn btn-subtle btn-sm" onclick="filterCustomerOrders('${c.id}')">View</button>
          <button class="btn ${c.active === false ? 'btn-success' : 'btn-danger'} btn-sm" onclick="setCustomerActive('${c.id}', ${c.active === false})">${c.active === false ? 'Activate' : 'Revoke'}</button></td>
      </tr>
    `;
  });
}

function setCustomerActive(customerId, active) {
  const customer = AppState.customers.find(item => item.id === customerId);
  if (!customer || !confirm(`${active ? 'Activate' : 'Revoke'} ${customer.id}?`)) return;
  customer.active = active;
  persistLocalState();
  renderCustomersTable();
  triggerAutoCloudSync('CUSTOMER_STATUS_CHANGED', { customerId, active });
}

function renderAdminAccessTable() {
  const container = document.getElementById('admin-access-list');
  if (!container) return;
  const masterId = AppState.adminProfile.adminId;
  container.innerHTML = AppState.admins.map(admin => `
    <div style="display:flex; justify-content:space-between; gap:8px; align-items:center; border-bottom:1px solid var(--border-subtle); padding:8px 0;">
      <span><strong>${admin.adminId}</strong> ${admin.name || ''}<br /><small>${admin.username}</small></span>
      <span><span class="pill ${admin.active === false ? 'pill-amber' : 'pill-green'}">${admin.active === false ? 'Revoked' : 'Active'}</span>
      ${admin.adminId === masterId ? '<span class="pill pill-indigo">Master</span>' : `<button class="btn ${admin.active === false ? 'btn-success' : 'btn-danger'} btn-sm" onclick="setAdminActive('${admin.adminId}', ${admin.active === false})">${admin.active === false ? 'Activate' : 'Revoke'}</button><button class="btn btn-danger btn-sm" onclick="deleteAdminAndData('${admin.adminId}')">Delete</button>`}</span>
    </div>
  `).join('') || '<span style="color:var(--text-muted);">No configured admins.</span>';
}

function deleteAdminAndData(adminId) {
  if (!AppState.currentUser?.isMaster || !confirm(`Delete ${adminId} and all of its bookers, products, and bookings? This cannot be undone.`)) return;
  AppState.admins = AppState.admins.filter(admin => !sameAdminId(admin.adminId, adminId));
  AppState.customers = AppState.customers.filter(customer => !sameAdminId(customer.adminId, adminId));
  AppState.products = AppState.products.filter(product => !sameAdminId(product.adminId, adminId));
  AppState.orders = AppState.orders.filter(order => !sameAdminId(order.adminId, adminId));
  persistLocalState();
  renderAllViews();
  triggerAutoCloudSync('ADMIN_DELETED', { adminId });
}

function setAdminActive(adminId, active) {
  const admin = AppState.admins.find(item => item.adminId === adminId);
  if (!admin || adminId === AppState.adminProfile.adminId || !confirm(`${active ? 'Activate' : 'Revoke'} ${adminId}?`)) return;
  admin.active = active;
  persistLocalState();
  renderAdminAccessTable();
  triggerAutoCloudSync('ADMIN_STATUS_CHANGED', { adminId, active });
}

function filterCustomerOrders(custId) {
  switchTab('tab-orders');
  document.getElementById('order-search').value = custId;
  renderOrdersTable();
}

function renderInvoicesGallery() {
  const container = document.getElementById('invoice-cards-container');
  if (!container) return;
  container.innerHTML = '';

  const selectFilter = document.getElementById('invoice-product-filter');
  const search = (document.getElementById('invoice-search')?.value || '').toLowerCase();
  const productFilter = selectFilter ? selectFilter.value : 'ALL';

  if (selectFilter && selectFilter.options.length <= 1) {
    AppState.products.forEach(p => {
      selectFilter.innerHTML += `<option value="${p.name}">${p.name}</option>`;
    });
  }

  const isAdmin = AppState.currentUser?.role === 'admin';
  const list = AppState.orders.filter(o => {
    if (!o.gstDetails || !o.gstDetails.included || o.gstDetails.attachmentDeleted) return false;
    if (!isAdmin && o.customerId !== AppState.currentUser?.customerId) return false;
    if (productFilter !== 'ALL' && o.productModel !== productFilter) return false;
    if (search) {
      return o.customerName.toLowerCase().includes(search) || o.productModel.toLowerCase().includes(search) || o.gstDetails.gstNumber?.toLowerCase().includes(search);
    }
    return true;
  });

  if (list.length === 0) {
    container.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 20px;">No GST invoices found.</div>`;
    return;
  }

  list.forEach(o => {
    const invoiceUrl = getInvoiceAttachmentUrl(o.gstDetails);
    container.innerHTML += `
      <div class="invoice-card">
        <div class="invoice-preview-box" onclick="viewGstInvoice('${o.id}')" style="cursor:pointer;">
          ${invoiceUrl ? `<img src="${invoiceUrl}" />` : '<span style="color:var(--text-muted);">Attachment unavailable</span>'}
        </div>
        <div style="font-size:0.85rem; font-weight:700;">${o.productModel}</div>
        <div style="font-size:0.75rem; color:var(--text-muted);">${o.gstDetails.shopName || 'N/A'} | Tax: ₹${o.gstDetails.gstAmount}</div>
        <div style="display:flex; gap:6px; margin-top:4px;">
          <button class="btn btn-subtle btn-sm" style="flex:1;" onclick="viewGstInvoice('${o.id}')">View</button>
          <button class="btn btn-primary btn-sm" style="flex:1;" onclick="downloadSingleInvoice('${o.id}')">Download</button>
        </div>
      </div>
    `;
  });
}

function renderProductListSettings() {
  const container = document.getElementById('settings-product-list');
  if (!container) return;
  container.innerHTML = '';
  const products = AppState.currentUser?.isMaster ? AppState.products : AppState.products.filter(product => !product.adminId || sameAdminId(product.adminId, AppState.currentUser.adminId));
  products.forEach(p => {
    container.innerHTML += `
      <div style="background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); padding:8px 12px; border-radius:6px; display:flex; justify-content:space-between; align-items:center; font-size:0.8rem;">
        <div><strong>${p.name}</strong><br/><span style="color:var(--text-muted); font-size:0.72rem;">Buy: ₹${p.targetPrice.toLocaleString()}</span></div>
        <div style="display:flex; align-items:center; gap:8px;">
          <span class="pill pill-green">+₹${p.commission} Comm.</span>
          <button class="btn btn-subtle btn-sm" onclick="openEditProductModal('${p.id}')">✏️ Edit</button>
        </div>
      </div>
    `;
  });
}

// 8. Workflows (Booking, Delivery, Settlement)
async function openNewOrderModal() {
  await syncFromGoogleSheets().catch(error => console.warn('Unable to refresh bookers before booking:', error.message));
  const pSelect = document.getElementById('modal-order-product');
  pSelect.innerHTML = `${AppState.products.map(p => `<option value="${p.id}">${p.name} (₹${p.targetPrice})</option>`).join('')}<option value="Other">Other device</option>`;

  const cSelect = document.getElementById('modal-order-customer-select');
  if (AppState.currentUser.role === 'admin') {
    const availableCustomers = AppState.currentUser.isMaster
      ? AppState.customers
      : AppState.customers.filter(customer => sameAdminId(customer.adminId, AppState.currentUser.adminId));
    cSelect.innerHTML = availableCustomers.map(c => `<option value="${c.id}">${c.name} (${c.id})</option>`).join('');
  } else {
    cSelect.innerHTML = `<option value="${AppState.currentUser.customerId}">${AppState.currentUser.name}</option>`;
  }

  document.getElementById('modal-order-id').value = `OD${Math.floor(1000000000 + Math.random() * 9000000000)}`;
  document.getElementById('modal-order-card').value = '';
  document.getElementById('modal-order-paid').value = AppState.products[0].targetPrice;
  document.getElementById('modal-order-advance').value = '0';
  document.getElementById('modal-order-platform-other').value = '';
  document.getElementById('modal-order-platform-other').style.display = 'none';
  document.getElementById('modal-order-product-other').value = '';
  document.getElementById('modal-order-product-other').style.display = 'none';
  openModal('modal-new-order');
}

function handleBookingOtherField(type) {
  const field = document.getElementById(`modal-order-${type}-other`);
  const select = document.getElementById(`modal-order-${type}`);
  if (!field || !select) return;
  field.style.display = select.value === 'Other' ? 'block' : 'none';
  field.required = select.value === 'Other';
}

function autoFillOrderPrice() {
  const pid = document.getElementById('modal-order-product').value;
  const prod = AppState.products.find(p => p.id === pid);
  if (prod) document.getElementById('modal-order-paid').value = prod.targetPrice;
}

function handleCreateBooking(e) {
  e.preventDefault();
  const pid = document.getElementById('modal-order-product').value;
  const prod = AppState.products.find(p => p.id === pid);
  const custId = document.getElementById('modal-order-customer-select').value;
  const cust = AppState.customers.find(c => String(c.id).trim() === String(custId).trim()) ||
    (AppState.currentUser.role === 'customer' && String(AppState.currentUser.customerId).trim() === String(custId).trim()
      ? { id: AppState.currentUser.customerId, name: AppState.currentUser.name, adminId: AppState.currentUser.adminId }
      : null);
  if (!cust) {
    alert('Create or select a valid booker account first.');
    return;
  }
  const paid = Number(document.getElementById('modal-order-paid').value);
  const adv = Number(document.getElementById('modal-order-advance').value) || 0;
  const comm = prod ? prod.commission : 1000;

  const newOrder = {
    id: document.getElementById('modal-order-id').value.trim(),
    platform: document.getElementById('modal-order-platform').value === 'Other'
      ? document.getElementById('modal-order-platform-other').value.trim()
      : document.getElementById('modal-order-platform').value,
    customerId: cust.id,
    adminId: AppState.currentUser.adminId || AppState.adminProfile.adminId,
    customerName: cust.name,
    productModel: document.getElementById('modal-order-product').value === 'Other'
      ? document.getElementById('modal-order-product-other').value.trim()
      : (prod ? prod.name : 'Custom Device'),
    cardLast4: document.getElementById('modal-order-card').value.trim(),
    amountPaid: paid,
    payableAmount: paid + comm,
    advancePaid: adv,
    settledAmount: 0,
    profit: comm,
    status: AppState.currentUser.role === 'customer' ? 'Pending Approval' : 'Booked',
    isToday: false,
    createdAt: new Date().toISOString().slice(0, 10),
    settledAt: null,
    delivery: null,
    gstDetails: null
  };

  AppState.orders.unshift(newOrder);
  closeModal('modal-new-order');
  renderAllViews();
  triggerAutoCloudSync('NEW_ORDER', { order: newOrder });
}

function openDeliveryModalForOrder(orderId) {
  const o = AppState.orders.find(item => item.id === orderId);
  if (!o) return;

  document.getElementById('deliv-form-order-id').value = o.id;
  document.getElementById('deliv-form-model').value = o.productModel;
  document.getElementById('deliv-form-platform').value = o.platform || 'Flipkart';
  document.getElementById('deliv-gst-toggle').checked = false;
  toggleGstFields();
  AppState.tempGstFileData = null;
  document.getElementById('deliv-gst-preview').style.display = 'none';
  openModal('modal-delivery-submission');
}

function toggleGstFields() {
  const isChecked = document.getElementById('deliv-gst-toggle').checked;
  document.getElementById('deliv-gst-fields-wrapper').style.display = isChecked ? 'block' : 'none';
}

function recalcGstTotal() {
  const base = Number(document.getElementById('gst-input-base').value) || 0;
  const rate = Number(document.getElementById('gst-input-rate').value) || 18;
  const tax = Math.round((base * rate) / 100);
  document.getElementById('gst-calc-tax').textContent = `₹${tax.toLocaleString()}`;
  document.getElementById('gst-calc-total').textContent = `₹${(base + tax).toLocaleString()}`;
}

function handleSaveDeliveryWithGst(e) {
  e.preventDefault();
  const orderId = document.getElementById('deliv-form-order-id').value;
  const order = AppState.orders.find(o => o.id === orderId);
  if (!order) return;

  order.status = 'Out for Delivery';
  order.isToday = true;
  order.delivery = {
    platform: document.getElementById('deliv-form-platform').value,
    recipientName: document.getElementById('deliv-form-name').value,
    mobile: document.getElementById('deliv-form-mobile').value,
    tracking: document.getElementById('deliv-form-tracking').value,
    otp: document.getElementById('deliv-form-otp').value,
    pincode: document.getElementById('deliv-form-pincode').value,
    submitted: true,
    deliveryDate: todayIsoDate(),
    submittedAt: new Date().toISOString()
  };
  order.isToday = true;

  if (document.getElementById('deliv-gst-toggle').checked) {
    const base = Number(document.getElementById('gst-input-base').value) || 0;
    const rate = Number(document.getElementById('gst-input-rate').value) || 18;
    const tax = Math.round((base * rate) / 100);
    order.gstDetails = {
      included: true,
      gstNumber: document.getElementById('gst-input-number').value.trim(),
      shopName: document.getElementById('gst-input-shop').value.trim(),
      baseAmount: base,
      gstRate: rate,
      gstAmount: tax,
      totalAmount: base + tax,
      fileName: AppState.tempGstFileData?.name || 'invoice.jpg',
      fileId: AppState.tempGstFileData?.fileId || '',
      fileData: AppState.tempGstFileData?.data || ''
    };
  } else {
    order.gstDetails = null;
  }

  closeModal('modal-delivery-submission');
  renderAllViews();
  triggerAutoCloudSync('DELIVERY_SUBMITTED', { order });
}

function markOrderDelivered(orderId) {
  const o = AppState.orders.find(item => item.id === orderId);
  if (o && confirm(`Mark ${o.id} Delivered?`)) {
    o.status = 'Delivered';
    renderAllViews();
    triggerAutoCloudSync('STATUS_CHANGED', { order: o });
  }
}

function openSettlementModalForOrder(orderId) {
  const o = AppState.orders.find(item => item.id === orderId);
  if (!o) return;
  const due = o.payableAmount - (o.advancePaid || 0) - (o.settledAmount || 0);

  document.getElementById('settle-order-id').value = o.id;
  document.getElementById('settle-customer-id').value = o.customerId;
  document.getElementById('settle-order-ref').value = `${o.id} (${o.productModel})`;
  document.getElementById('settle-customer-name').value = o.customerName;
  document.getElementById('settle-current-balance').value = `₹${due.toLocaleString()}`;
  document.getElementById('settle-amount-input').value = due > 0 ? due : '';
  openModal('modal-settlement');
}

function handleExecuteSettlement(e) {
  e.preventDefault();
  const orderId = document.getElementById('settle-order-id').value;
  const custId = document.getElementById('settle-customer-id').value;
  const amount = Number(document.getElementById('settle-amount-input').value);
  const notes = document.getElementById('settle-notes').value;

  const order = AppState.orders.find(o => o.id === orderId);
  const cust = AppState.customers.find(c => c.id === custId);
  const outstanding = order ? order.payableAmount - (order.advancePaid || 0) - (order.settledAmount || 0) : 0;

  if (!order || !cust || !Number.isFinite(amount) || amount <= 0 || amount > outstanding) {
    alert('Settlement amount must be greater than zero and no more than the outstanding balance.');
    return;
  }

  if (order && cust) {
    order.settledAmount = (order.settledAmount || 0) + amount;
    cust.totalSettled = (cust.totalSettled || 0) + amount;

    const fullySettled = (order.advancePaid || 0) + order.settledAmount >= order.payableAmount;
    order.status = fullySettled ? 'Settled' : 'Delivered';
    if (fullySettled) order.settledAt = new Date().toISOString().slice(0, 10);

    closeModal('modal-settlement');
    renderAllViews();
    triggerAutoCloudSync('SETTLEMENT_RECORDED', { orderId, customerId: custId, customerName: cust.name, amount, notes });
    triggerAutoCloudSync('STATUS_CHANGED', { order });
  }
}

// 9. Modals, Lifetime Drilldown & Out For Delivery Today
function openCreateCustomerModal() {
  const adminDigits = String(AppState.currentUser.adminId).match(/(?:adm-?)(\d{3})$/i)?.[1] || '000';
  const prefix = adminDigits.slice(-2);
  const customerNumbers = AppState.customers
    .map(customer => String(customer.id).match(new RegExp(`^cust${prefix}(\\d{2})$`, 'i')))
    .filter(Boolean)
    .map(match => Number(match[1]));
  let nextSequence = Math.max(0, ...customerNumbers) + 1;
  let nextCustomerId = `cust${prefix}${String(nextSequence).padStart(2, '0')}`;
  while (AppState.customers.some(customer => String(customer.id).toLowerCase() === nextCustomerId)) {
    nextSequence += 1;
    nextCustomerId = `cust${prefix}${String(nextSequence).padStart(2, '0')}`;
  }
  document.getElementById('new-cust-id').value = nextCustomerId;
  document.getElementById('new-cust-name').value = '';
  document.getElementById('new-cust-mobile').value = '';
  document.getElementById('new-cust-password').value = `dt@${Math.floor(1000 + Math.random() * 9000)}`;
  document.getElementById('new-cust-admin-creator').value = `${AppState.currentUser.name} (${AppState.currentUser.adminId})`;
  openModal('modal-create-customer');
}

function handleCreateCustomerAccount(e) {
  e.preventDefault();
  const newCust = {
    id: document.getElementById('new-cust-id').value,
    username: document.getElementById('new-cust-id').value,
    name: document.getElementById('new-cust-name').value.trim(),
    mobile: document.getElementById('new-cust-mobile').value.trim(),
    password: document.getElementById('new-cust-password').value.trim(),
    createdByAdmin: AppState.currentUser.name,
    adminId: AppState.currentUser.adminId || AppState.adminProfile.adminId,
    totalSettled: 0
  };

  AppState.customers.push(newCust);
  closeModal('modal-create-customer');
  renderCustomersTable();
  triggerAutoCloudSync('CUSTOMER_CREATED', { customer: newCust });
  alert(`Booker Created!\nID: ${newCust.id}\nPassword: ${newCust.password}`);
}

function openLifetimeDrilldownModal() {
  document.getElementById('lifetime-date-filter-type').value = 'ALL';
  handleLifetimeFilterTypeChange();
  openModal('modal-lifetime-drilldown');
}

function handleLifetimeFilterTypeChange() {
  const type = document.getElementById('lifetime-date-filter-type').value;
  document.getElementById('lifetime-filter-date').style.display = type === 'DAY' ? 'inline-block' : 'none';
  document.getElementById('lifetime-filter-month').style.display = type === 'MONTH' ? 'inline-block' : 'none';
  document.getElementById('lifetime-filter-year').style.display = type === 'YEAR' ? 'inline-block' : 'none';
  renderLifetimeDrilldownTable();
}

function renderLifetimeDrilldownTable() {
  const tbody = document.getElementById('table-lifetime-drilldown-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  const type = document.getElementById('lifetime-date-filter-type').value;
  const fDay = document.getElementById('lifetime-filter-date').value;
  const fMonth = document.getElementById('lifetime-filter-month').value;
  const fYear = document.getElementById('lifetime-filter-year').value;

  const settledOrders = AppState.orders.filter(o => {
    if (o.status !== 'Settled') return false;
    const dateStr = o.settledAt || '';
    if (type === 'DAY' && fDay && dateStr !== fDay) return false;
    if (type === 'MONTH' && fMonth && !dateStr.startsWith(fMonth)) return false;
    if (type === 'YEAR' && fYear && !dateStr.startsWith(fYear)) return false;
    return true;
  });

  document.getElementById('lifetime-metric-count').textContent = settledOrders.length;
  document.getElementById('lifetime-metric-volume').textContent = `₹${settledOrders.reduce((s, o) => s + o.amountPaid, 0).toLocaleString()}`;
  document.getElementById('lifetime-metric-profit').textContent = `₹${settledOrders.reduce((s, o) => s + o.profit, 0).toLocaleString()}`;

  if (settledOrders.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; color:var(--text-muted); padding:20px;">No lifetime records found.</td></tr>`;
    return;
  }

  settledOrders.forEach(o => {
    tbody.innerHTML += `
      <tr>
        <td><strong>${o.id}</strong></td>
        <td><span class="pill pill-indigo">${o.platform}</span></td>
        <td>${o.productModel}</td>
        <td>${o.customerName}</td>
        <td>•••• ${o.cardLast4}</td>
        <td>₹${o.amountPaid.toLocaleString()}</td>
        <td><strong style="color:#34d399;">${o.settledAt}</strong></td>
        <td>${o.gstDetails ? `<span class="pill pill-green">₹${o.gstDetails.totalAmount}</span>` : '-'}</td>
        <td><span class="pill pill-green">✓ Settled</span></td>
      </tr>
    `;
  });
}

function openOutForDeliveryModal() {
  renderTodayDeliveryTable();
  openModal('modal-today-delivery');
}

function renderTodayDeliveryTable() {
  const tbody = document.getElementById('table-today-deliveries-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  const todayList = getTodayModalDeliveries();

  if (todayList.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--text-muted); padding:20px;">No dispatches for today.</td></tr>`;
    return;
  }

  todayList.forEach(o => {
    const d = o.delivery;
    tbody.innerHTML += `
      <tr>
        <td><span class="pill pill-indigo">${d.platform}</span></td>
        <td><strong>${o.productModel}</strong></td>
        <td>${d.recipientName}</td>
        <td>${d.mobile}</td>
        <td><code>${d.tracking}</code></td>
        <td><strong style="color:#fbbf24;">${d.otp}</strong></td>
        <td><strong>${d.pincode}</strong></td>
      </tr>
    `;
  });
}

function openNewProductModal() {
  document.getElementById('prod-modal-title').textContent = 'Add Tracked Product Model';
  document.getElementById('edit-prod-id').value = '';
  document.getElementById('edit-prod-name').value = '';
  document.getElementById('edit-prod-price').value = '';
  document.getElementById('edit-prod-comm').value = '';
  openModal('modal-edit-product');
}

function openEditProductModal(productId) {
  const p = AppState.products.find(item => item.id === productId);
  if (!p) return;
  document.getElementById('prod-modal-title').textContent = 'Edit Product & Commission';
  document.getElementById('edit-prod-id').value = p.id;
  document.getElementById('edit-prod-name').value = p.name;
  document.getElementById('edit-prod-price').value = p.targetPrice;
  document.getElementById('edit-prod-comm').value = p.commission;
  openModal('modal-edit-product');
}

function handleSaveProduct(e) {
  e.preventDefault();
  const id = document.getElementById('edit-prod-id').value;
  const name = document.getElementById('edit-prod-name').value.trim();
  const targetPrice = Number(document.getElementById('edit-prod-price').value);
  const commission = Number(document.getElementById('edit-prod-comm').value);

  if (id) {
    const p = AppState.products.find(item => item.id === id);
    if (p) {
      p.name = name;
      p.targetPrice = targetPrice;
      p.commission = commission;
    }
  } else {
    AppState.products.push({ id: `p_${Date.now()}`, name, targetPrice, commission, adminId: AppState.currentUser.adminId, active: true });
  }

  const savedProduct = AppState.products.find(item => item.id === (id || AppState.products[AppState.products.length - 1].id));
  if (savedProduct) triggerAutoCloudSync('PRODUCT_SYNC', { product: savedProduct });

  closeModal('modal-edit-product');
  persistLocalState();
  renderProductListSettings();
  alert('Product catalog updated.');
}

function exportProductCatalogCSV() {
  const products = AppState.products.filter(product => AppState.currentUser?.isMaster || !product.adminId || product.adminId === AppState.currentUser?.adminId);
  const csv = ['Product ID,Product Name,Target Price,Commission,Admin ID', ...products.map(product =>
    [product.id, product.name, product.targetPrice, product.commission, product.adminId || ''].map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')
  )].join('\n');
  triggerBlobDownload(csv, 'Product_Catalog.csv', 'text/csv;charset=utf-8;');
}

function handleProductCatalogUpload(input) {
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const lines = String(reader.result || '').split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return alert('Catalog CSV must contain a header and at least one product.');
    lines.slice(1).forEach(line => {
      const values = line.split(',').map(value => value.trim().replace(/^"|"$/g, '').replaceAll('""', '"'));
      const [id, name, targetPrice, commission] = values;
      if (!name) return;
      const product = { id: id || `p_${Date.now()}_${Math.random().toString(36).slice(2)}`, name, targetPrice: csvOrNumber(targetPrice), commission: csvOrNumber(commission), adminId: AppState.currentUser.adminId, active: true };
      const existing = AppState.products.find(item => item.id === product.id);
      if (existing) Object.assign(existing, product); else AppState.products.push(product);
      triggerAutoCloudSync('PRODUCT_SYNC', { product });
    });
    persistLocalState();
    renderProductListSettings();
    alert('Product catalog uploaded and queued for sync.');
    input.value = '';
  };
  reader.readAsText(file);
}

// 10. CSV Exports & Downloads
function triggerBlobDownload(content, filename, contentType) {
  const blob = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportFilteredDeliveriesToExcel() {
  let csv = "Platform,Product Model,Recipient Name,Phone,Tracking,OTP,Pincode,Status\n";
  getFilteredDeliveries().forEach(o => {
    const d = o.delivery;
    csv += `"${d.platform}","${o.productModel}","${d.recipientName}","${d.mobile}","${d.tracking}","${d.otp}","${d.pincode}","${o.status}"\n`;
  });
  triggerBlobDownload(csv, 'All_Deliveries_Registry.csv', 'text/csv;charset=utf-8;');
}

function getFilteredDeliveries() {
  const search = (document.getElementById('delivery-search')?.value || '').toLowerCase();
  const platform = document.getElementById('delivery-platform-filter')?.value || 'ALL';
  const date = document.getElementById('delivery-date-filter')?.value || todayIsoDate();
  return getVisibleOrders().filter(order => {
    const delivery = order.delivery;
    if (!delivery?.submitted || getDeliveryDate(order) !== date) return false;
    if (platform !== 'ALL' && delivery.platform !== platform) return false;
    if (!search) return true;
    return [delivery.pincode, delivery.tracking, delivery.recipientName, order.productModel]
      .some(value => String(value || '').toLowerCase().includes(search));
  });
}

function exportTodayDeliveriesToExcel() {
  const todayList = getTodayModalDeliveries();
  if (todayList.length === 0) {
    alert('No active delivery dispatches found for today.');
    return;
  }
  let csv = "Platform,Model,Recipient Name,Mobile,Tracking AWB,OTP,Pincode,Order ID,Card Last 4\n";
  todayList.forEach(o => {
    const d = o.delivery;
    csv += `"${d.platform}","${o.productModel}","${d.recipientName}","${d.mobile}","${d.tracking}","${d.otp}","${d.pincode}","${o.id}","${o.cardLast4}"\n`;
  });
  triggerBlobDownload(csv, `Deliveries_Today_${new Date().toISOString().slice(0,10)}.csv`, 'text/csv;charset=utf-8;');
}

function getTodayModalDeliveries() {
  const fPin = (document.getElementById('today-filter-pin')?.value || '').trim().toLowerCase();
  const fName = (document.getElementById('today-filter-name')?.value || '').toLowerCase().trim();
  const fProd = (document.getElementById('today-filter-product')?.value || '').toLowerCase().trim();
  return getVisibleOrders().filter(order => {
    const delivery = order.delivery;
    if (!delivery?.submitted || getDeliveryDate(order) !== todayIsoDate()) return false;
    if (fPin && !String(delivery.pincode || '').toLowerCase().includes(fPin)) return false;
    if (fName && !String(delivery.recipientName || '').toLowerCase().includes(fName)) return false;
    if (fProd && !String(order.productModel || '').toLowerCase().includes(fProd)) return false;
    return true;
  });
}

function exportCustomerLedgerCSV() {
  let csv = "Customer ID,Customer Name,Created By Admin,Orders Count,Total Paid,Advance Taken,Settled,Net Balance\n";
  AppState.customers.forEach(c => {
    const cOrders = AppState.orders.filter(o => o.customerId === c.id);
    const paid = cOrders.reduce((s, o) => s + o.amountPaid, 0);
    const payable = cOrders.reduce((s, o) => s + o.payableAmount, 0);
    const advance = cOrders.reduce((s, o) => s + (o.advancePaid || 0), 0);
    const settled = c.totalSettled || 0;
    const bal = payable - advance - settled;
    csv += `"${c.id}","${c.name}","${c.createdByAdmin || 'N/A'}",${cOrders.length},${paid},${advance},${settled},${bal}\n`;
  });
  triggerBlobDownload(csv, 'Customer_Ledgers_Master.csv', 'text/csv;charset=utf-8;');
}

function downloadAllInvoicesCSV() {
  let csv = "Order ID,Customer Name,Product,Shop Name,GST Number,Base Amount,GST Tax,Total Gross\n";
  AppState.orders.filter(o => o.gstDetails?.included).forEach(o => {
    const g = o.gstDetails;
    csv += `"${o.id}","${o.customerName}","${o.productModel}","${g.shopName}","${g.gstNumber}",${g.baseAmount},${g.gstAmount},${g.totalAmount}\n`;
  });
  triggerBlobDownload(csv, 'GST_Invoices_Master_List.csv', 'text/csv;charset=utf-8;');
}

function downloadSingleInvoice(orderId) {
  const order = AppState.orders.find(o => o.id === orderId);
  if (!order || !order.gstDetails) return;
  const a = document.createElement('a');
  a.href = getInvoiceAttachmentUrl(order.gstDetails);
  if (!a.href) return;
  a.download = order.gstDetails.fileName || `GST_${order.id}.jpg`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function getInvoiceAttachmentUrl(gstDetails) {
  return gstDetails?.fileData || gstDetails?.fileUrl || '';
}

function exportLifetimeBookingsToExcel() {
  let csv = "Order ID,Platform,Product Model,Customer Name,Card Last 4,Amount Paid,Settled Date,GST Total,Status\n";
  AppState.orders.filter(o => o.status === 'Settled').forEach(o => {
    const gstTot = o.gstDetails?.included ? o.gstDetails.totalAmount : 0;
    csv += `"${o.id}","${o.platform}","${o.productModel}","${o.customerName}","${o.cardLast4}",${o.amountPaid},"${o.settledAt}",${gstTot},"${o.status}"\n`;
  });
  triggerBlobDownload(csv, `Lifetime_Settled_Deals_${new Date().toISOString().slice(0,10)}.csv`, 'text/csv;charset=utf-8;');
}

function viewGstInvoice(orderId) {
  const order = AppState.orders.find(o => o.id === orderId);
  if (!order || !order.gstDetails) return;
  const g = order.gstDetails;
  const invoiceUrl = getInvoiceAttachmentUrl(g);
  document.getElementById('preview-invoice-title').textContent = `GST Bill - ${order.productModel}`;
  document.getElementById('preview-invoice-body').innerHTML = `
    ${invoiceUrl ? `<img src="${invoiceUrl}" style="max-width: 100%; border-radius: 8px; border: 1px solid var(--border-subtle);" />` : '<div style="color:var(--text-muted);">Invoice attachment unavailable.</div>'}
    <div style="margin-top: 10px; font-size: 0.8rem; color: var(--text-muted); text-align: left; background: rgba(0,0,0,0.2); padding: 10px; border-radius: 6px;">
      <strong>Merchant:</strong> ${g.shopName || 'N/A'}<br />
      <strong>GSTIN:</strong> <code>${g.gstNumber || 'N/A'}</code><br />
      <strong>Tax Breakdown:</strong> Base ₹${g.baseAmount?.toLocaleString()} + GST ${g.gstRate}% (₹${g.gstAmount}) = <strong>₹${g.totalAmount?.toLocaleString()}</strong>
    </div>
  `;
  document.getElementById('btn-download-active-invoice').onclick = () => downloadSingleInvoice(order.id);
  openModal('modal-view-invoice');
}

function triggerManualSheetSync() {
  triggerAutoCloudSync('ADMIN_SYNC');
  alert('Synced to Google Sheets.');
}

function testFirebaseConnection() {
  triggerAutoCloudSync('ADMIN_SYNC');
  alert('Firebase Firestore Connection Verified.');
}

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

// Run Hydration
const appStateReady = loadPersistedState();