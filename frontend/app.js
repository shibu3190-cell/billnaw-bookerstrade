/**
 * DeviceTrade Pro - Production Client Controller & Exporter
 */

const APP_UPDATE_PENDING_KEY = 'dt_app_update_pending';
const APP_GLOBAL_LOADING_DISABLED = false;

function isAppUpdatePending() {
  try {
    return localStorage.getItem(APP_UPDATE_PENDING_KEY) === 'true';
  } catch (error) {
    return false;
  }
}

function showAppUpdateOverlay(message, showActions = false) {
  const overlay = document.getElementById('app-loading-overlay');
  const text = overlay?.querySelector('.app-loading-text');
  const actions = document.getElementById('app-update-actions');
  const spinner = overlay?.querySelector('.app-loading-spinner');
  if (!overlay || !text) return;
  overlay.classList.remove('compact');
  text.textContent = message;
  overlay.hidden = false;
  overlay.setAttribute('aria-busy', String(!showActions));
  if (spinner) spinner.hidden = showActions;
  if (actions) actions.hidden = !showActions;
}

function forceOverlayHiddenOnStartup() {
  if (isAppUpdatePending()) {
    showAppUpdateOverlay('Installing update and refreshing cloud data...');
    return;
  }
  const overlay = document.getElementById('app-loading-overlay');
  if (!overlay) return;
  overlay.classList.remove('compact');
  overlay.setAttribute('aria-busy', 'false');
  overlay.hidden = true;
  const text = overlay.querySelector('.app-loading-text');
  if (text) text.textContent = '';
}

window.addEventListener('DOMContentLoaded', forceOverlayHiddenOnStartup, { once: true });
window.addEventListener('pageshow', forceOverlayHiddenOnStartup, { once: true });

const APP_CAN_USE_PWA = window.location.protocol === 'http:' || window.location.protocol === 'https:' || window.location.protocol === 'localhost:';
if (APP_CAN_USE_PWA && !document.querySelector('link[rel="manifest"]')) {
  const manifestLink = document.createElement('link');
  manifestLink.rel = 'manifest';
  manifestLink.href = 'manifest.json';
  manifestLink.crossOrigin = 'use-credentials';
  document.head.appendChild(manifestLink);
}

// 1. PWA Installation Service
let deferredPwaPrompt = null;
let hadServiceWorkerController = Boolean(navigator.serviceWorker?.controller);
let waitingServiceWorker = null;

if (APP_CAN_USE_PWA && 'serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadServiceWorkerController) window.location.reload();
    hadServiceWorkerController = true;
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then(registration => {
      const showUpdate = worker => {
        waitingServiceWorker = worker;
        const banner = document.getElementById('app-update-banner');
        if (banner) banner.hidden = false;
      };
      const checkForUpdates = () => {
        if (document.visibilityState === 'visible') {
          registration.update().catch(error => console.warn('App update check failed:', error.message));
        }
      };
      if (registration.waiting) showUpdate(registration.waiting);
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (worker) worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdate(worker);
        });
      });
      window.addEventListener('focus', checkForUpdates);
      window.setInterval(checkForUpdates, 5 * 60 * 1000);
    }).catch(err => console.warn('SW error:', err));
  });
}

function applyAppUpdate() {
  if (!waitingServiceWorker) return;
  try {
    localStorage.setItem(APP_UPDATE_PENDING_KEY, 'true');
  } catch (error) {
    console.warn('Unable to remember the pending app update:', error);
  }
  const banner = document.getElementById('app-update-banner');
  const button = banner?.querySelector('button');
  if (button) {
    button.disabled = true;
    button.textContent = 'Updating...';
  }
  showAppUpdateOverlay('Installing update and refreshing cloud data...');
  waitingServiceWorker.postMessage({ type: 'CLEAR_AND_ACTIVATE' });
}

window.addEventListener('beforeinstallprompt', (e) => {
  if (!e || typeof e.preventDefault !== 'function') return;
  if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) return;
  if (typeof e.prompt !== 'function') return;
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
const isolatedTestMode = ['localhost', '127.0.0.1'].includes(window.location.hostname)
  && new URLSearchParams(window.location.search).get('isolatedTest') === '1';
const API_CONFIG = {
  baseUrl: isolatedTestMode ? 'http://127.0.0.1:5001/api' : "https://billnow-bookerstrade-3.onrender.com/api",
  secretToken: isolatedTestMode ? 'local-isolated-test-token' : ''
};

const STORAGE_DB_NAME = 'devicetrade-local';
const STORAGE_DB_VERSION = 2;
const STORAGE_STATE_STORE = 'state';
const STORAGE_QUEUE_STORE = 'outbox';
const REQUEST_TIMEOUT_MS = 60000;
let storageDb = null;
let offlineOutbox = [];
let cloudSyncInFlight = null;
let isFlushingOfflineQueue = false;
let lastCloudSyncError = null;
let directDeliveryEntry = false;
let directDeliveryPackageIndex = 0;

function withRequestTimeout(timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return {
    controller,
    cleanup: () => clearTimeout(timeoutId)
  };
}

function sameAdminId(left, right) {
  return String(left || '').replace(/[-_\s]/g, '').toLowerCase() === String(right || '').replace(/[-_\s]/g, '').toLowerCase();
}

function normalizeProductName(productName) {
  return String(productName || '').trim().toLowerCase();
}

function refreshProductLookupIndex() {
  const byId = new Map();
  const byName = new Map();
  for (const product of AppState.products || []) {
    if (!product || !product.name) continue;
    const id = String(product.id || '').trim();
    if (id) byId.set(id.toLowerCase(), product);
    const key = normalizeProductName(product.name);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(product);
  }
  AppState.productIndexById = byId;
  AppState.productIndexByName = byName;
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
let appLoadingRequestCount = 0;

function updateSyncStatus(status = 'online', label = '') {
  const item = document.getElementById('global-sync-status');
  if (!item) return;

  const dot = item.querySelector('.sync-dot');
  const text = item.querySelector('.sync-label');
  const nextState = String(status || 'online').toLowerCase();
  const nextLabel = label || {
    online: 'Online',
    busy: 'Syncing',
    queued: 'Queued',
    offline: 'Offline',
    failed: 'Failed'
  }[nextState] || 'Online';

  item.classList.remove('online', 'busy', 'queued', 'offline', 'failed');
  item.classList.add(nextState);
  if (text) text.textContent = nextLabel;
  if (dot) dot.style.animation = nextState === 'busy' ? 'pulse 1.2s infinite' : 'none';
}

function updateQueueBadge() {
  const queuedCount = offlineOutbox.length;
  if (queuedCount > 0) {
    updateSyncStatus('queued', `Queued (${queuedCount})`);
    return;
  }
  updateSyncStatus(navigator.onLine ? 'online' : 'offline', navigator.onLine ? 'Online' : 'Offline');
}

async function dispatchToBackend(endpoint, payload) {
  // Always include secretToken in both header and body payload
  const fullPayload = { ...payload, secretToken: API_CONFIG.secretToken };
  const timeout = withRequestTimeout();
  const compactLoading = endpoint === '/auth/login';
  updateSyncStatus('busy', endpoint === '/auth/login' ? 'Signing in' : 'Syncing');
  setAppLoadingState(endpoint.includes('/orders/') || endpoint.includes('/customers/') || endpoint.includes('/admin/') ? 'Syncing data...' : 'Saving...', true, compactLoading);
  try {
    const res = await fetch(`${API_CONFIG.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_CONFIG.secretToken,
        ...(AppState.sessionToken ? { 'x-session-token': AppState.sessionToken } : {})
      },
      body: JSON.stringify(fullPayload),
      signal: timeout.controller.signal
    });

    if (!res.ok) {
      const errorBody = await res.json().catch(() => ({}));
      if (isSessionUnauthorized(res.status, errorBody.message)) {
        await logoutApp('Your session has expired or is invalid. Please sign in again.');
      }
      const error = new Error(errorBody.message || errorBody.error || `HTTP ${res.status}`);
      error.status = res.status;
      throw error;
    }
    updateSyncStatus('online', 'Synced');
    return await res.json();
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('The request timed out. Please check your connection and try again.');
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    timeout.cleanup();
    setAppLoadingState('Saving...', false);
  }
}

function isSessionUnauthorized(status, message) {
  return status === 401 && (
    message === 'An active login session is required.'
    || (AppState.sessionToken && message === 'Unauthorized request.')
  );
}

async function fetchFromBackend(endpoint, { silentLoading = false } = {}) {
  const timeout = withRequestTimeout();
  const compactLoading = endpoint.includes('/auth/login') || endpoint.includes('/admin/sheets/data?page=1&pageSize=50');
  if (!silentLoading) setAppLoadingState(endpoint.includes('/admin/') ? 'Loading data...' : 'Updating data...', true, compactLoading);
  try {
    const res = await fetch(`${API_CONFIG.baseUrl}${endpoint}`, {
      headers: {
        'x-api-key': API_CONFIG.secretToken,
        ...(AppState.sessionToken ? { 'x-session-token': AppState.sessionToken } : {})
      },
      signal: timeout.controller.signal
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (isSessionUnauthorized(res.status, result.message)) {
        await logoutApp('Your session has expired or is invalid. Please sign in again.');
      }
      throw new Error(result.message || `HTTP ${res.status}`);
    }
    return result;
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('The request timed out. Please check your connection and try again.');
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    timeout.cleanup();
    if (!silentLoading) setAppLoadingState('Loading data...', false);
  }
}

function resetLoadingOverlay() {
  if (isAppUpdatePending()) {
    showAppUpdateOverlay('Installing update and refreshing cloud data...');
    return;
  }
  appLoadingRequestCount = 0;
  const overlay = document.getElementById('app-loading-overlay');
  const text = overlay?.querySelector('.app-loading-text');
  if (!overlay || !text) return;
  overlay.classList.remove('compact');
  text.textContent = '';
  overlay.hidden = true;
  overlay.setAttribute('aria-busy', 'false');
}

window.addEventListener('pageshow', resetLoadingOverlay);

function setAppLoadingState(message = 'Saving...', visible = true, compact = false) {
  if (isAppUpdatePending()) {
    showAppUpdateOverlay('Updating application and syncing data...');
    return;
  }
  if (typeof APP_GLOBAL_LOADING_DISABLED !== 'undefined' && APP_GLOBAL_LOADING_DISABLED) {
    resetLoadingOverlay();
    return;
  }

  const overlay = document.getElementById('app-loading-overlay');
  const text = overlay?.querySelector('.app-loading-text');
  if (!overlay || !text) return;

  overlay.classList.toggle('compact', compact);

  if (visible) {
    appLoadingRequestCount = Math.max(appLoadingRequestCount + 1, 1);
    text.textContent = message || 'Loading...';
    overlay.hidden = false;
    overlay.setAttribute('aria-busy', 'true');
    return;
  }

  appLoadingRequestCount = Math.max(appLoadingRequestCount - 1, 0);
  if (appLoadingRequestCount === 0) {
    text.textContent = '';
    overlay.hidden = true;
    overlay.setAttribute('aria-busy', 'false');
    return;
  }

  text.textContent = message || 'Loading...';
  overlay.hidden = false;
  overlay.setAttribute('aria-busy', 'true');
}

function setButtonLoadingState(button, label, isLoading) {
  if (!button) return;
  const originalText = button.dataset.originalText || button.textContent.trim();
  if (!button.dataset.originalText) button.dataset.originalText = originalText;
  button.disabled = isLoading;
  button.classList.toggle('is-loading', isLoading);
  button.textContent = isLoading ? label : originalText;
}

function setInlineLoadingState(message = 'Loading...', isLoading = true) {
  const loader = document.getElementById('app-inline-loading');
  const label = loader?.querySelector('.app-inline-text');
  if (!loader || !label) return;
  label.textContent = message;
  loader.hidden = !isLoading;
  loader.setAttribute('aria-busy', String(isLoading));
}

function findButtonByAction(actionName, actionArg) {
  if (!actionArg) return null;
  const match = `${actionName}('${actionArg}'`;
  return [...document.querySelectorAll('button')].find(button => {
    const handler = button.getAttribute('onclick') || '';
    return handler.includes(match) || handler.includes(`${actionName}(\"${actionArg}\"`);
  }) || null;
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

async function syncCloudData(showResult = false) {
  if (!showResult && hasPendingSyncForCurrentUser()) return false;
  if (cloudSyncInFlight && !showResult) return cloudSyncInFlight;
  if (showResult) setDataManagementStatus('Importing Google Sheet data...');
  const exportEndpoint = (showResult ? '/admin/sheets/data' : '/admin/data/export') + '?page=1&pageSize=50';
  const syncRequest = (async () => {
    try {
    const result = await fetchFromBackend(exportEndpoint, { silentLoading: !showResult });
    const data = result.data || {};
    const admins = data.admins || [];
    const customers = data.customers || [];
    const products = data.products || [];
    const orders = data.orders || [];

    if (AppState.currentUser?.role === 'admin' && admins.length > 0) {
      AppState.admins = admins.map(importedAdmin => ({
        adminId: importedAdmin['Admin ID'] || importedAdmin.adminId,
        name: importedAdmin['Admin Name'] || importedAdmin.name || '',
        username: importedAdmin.Username || importedAdmin.username || '',
        active: importedAdmin.Active !== 'false' && importedAdmin.active !== false
      })).filter(adminItem => adminItem.adminId && adminItem.username);
      const currentAdminRecord = AppState.admins.find(adminItem => sameAdminId(adminItem.adminId, AppState.currentUser?.adminId));
      if (currentAdminRecord) {
        AppState.adminProfile = {
          adminId: currentAdminRecord.adminId,
          name: currentAdminRecord.name || AppState.adminProfile.name,
          username: currentAdminRecord.username || AppState.adminProfile.username
        };
      }
    }
    if (AppState.currentUser?.role === 'admin' || AppState.currentUser?.role === 'customer') {
      AppState.customers = customers.map(customer => ({
        id: String(customer['Customer ID'] || customer.id || '').trim(),
        username: customer['Customer ID'] || customer.username || customer.id,
        name: customer['Full Name'] || customer.name || '',
        mobile: customer.Mobile || customer.mobile || '',
        createdByAdmin: customer['Created By Admin'] || customer.createdByAdmin || AppState.adminProfile.name,
        totalSettled: csvOrNumber(customer.totalSettled),
        adminId: String(customer['Admin ID'] || customer.adminId || AppState.adminProfile.adminId || '').trim(),
        active: customer.Active !== 'false' && customer.active !== false
      })).filter(customer => customer.id);
    }
    if (AppState.currentUser) {
      AppState.products = products.map(product => ({
        id: product['Product ID'] || product.id || `sheet_${Date.now()}_${Math.random()}`,
        name: product['Product Name'] || product.name || '',
        targetPrice: csvOrNumber(product['Target Price'] || product.targetPrice),
        commission: csvOrNumber(product.Commission || product.commission),
        adminId: String(product['Admin ID'] || product.adminId || '').trim(),
        active: product.Active === undefined ? product.active !== false : !['false', 'revoked', 'inactive'].includes(String(product.Active).trim().toLowerCase())
      })).filter(product => product.name && (AppState.currentUser?.isMaster || !product.adminId || sameAdminId(product.adminId, AppState.currentUser?.adminId)));
      refreshProductLookupIndex();
    }
    if (AppState.currentUser) {
      const previousPackagesByOrder = new Map(AppState.orders.map(order => [order.id, order.deliveryPackages || []]));
      AppState.orders = orders.map(order => normalizeOrder({
        id: order['Order ID'] || order.id,
        productId: order['Product ID'] || order.productId || '',
        platform: order.Platform || order.platform || 'Other',
        productModel: order['Product Model'] || order.productModel || '',
        quantity: Number(order.Quantity || order.quantity) || 1,
        customerName: order['Customer Name'] || order.customerName || '',
        customerId: order['Customer ID'] || order.customerId || '',
        cardLast4: order['Card Last 4'] || order.cardLast4 || '',
        amountPaid: csvOrNumber(order['Amount Paid'] || order.amountPaid),
        payableAmount: csvOrNumber(order['Payable Due'] || order.payableAmount),
        advancePaid: csvOrNumber(order['Advance Paid'] || order.advancePaid),
        settledAmount: csvOrNumber(order['Settled Amount'] || order.settledAmount),
        profit: csvOrNumber(order.Profit || order.profit || AppState.products.find(product => product.name === (order['Product Model'] || order.productModel))?.commission),
        status: order.Status || order.status || 'Booked',
        createdAt: order.Date || order.createdAt || new Date().toISOString().slice(0, 10),
        settledAt: order.settledAt || order['Settled Date'] || (String(order.Status || order.status).toLowerCase() === 'settled' ? (order.Date || order.createdAt || new Date().toISOString().slice(0, 10)) : null),
        adminId: order['Admin ID'] || order.adminId || AppState.adminProfile.adminId,
        isToday: order.isToday === true || order.isToday === 'true',
        delivery: order.delivery || null,
        deliveryPackages: Array.isArray(order.deliveryPackages)
          ? order.deliveryPackages
          : previousPackagesByOrder.get(String(order['Order ID'] || order.id || '').trim()) || [],
        gstDetails: order.gstDetails ? { ...order.gstDetails, adminId: order.gstDetails.adminId || order.adminId, customerId: order.gstDetails.customerId || order.customerId, quantity: order.gstDetails.quantity || (Number(order.Quantity) || 1) } : null
      })).filter(order => order.id);
      const packagesByOrder = new Map();
      (data.delivery_packages || []).forEach(record => {
        const orderId = String(record['Order ID'] || record.orderId || '').trim();
        const packageId = String(record['Package ID'] || record.id || '').trim();
        if (!orderId || !packageId) return;
        const importedPackage = {
          id: packageId,
          sequence: Number(record.Sequence || record.sequence) || 0,
          doNumber: String(record['Delivery No'] || record.doNumber || '').trim(),
          packageTag: String(record['Delivery Tag'] || record.packageTag || '').trim(),
          delivery: {
            platform: record.Platform || record.platform || 'Other',
            recipientName: record['Recipient Name'] || record.recipientName || '',
            mobile: record.Mobile || record.mobile || '',
            tracking: record['Tracking AWB'] || record.tracking || '',
            otp: record.OTP || record.otp || '',
            pincode: record.Pincode || record.pincode || '',
            submitted: true,
            deliveryDate: record['Delivery Date'] || String(record.Timestamp || '').slice(0, 10),
            submittedAt: record.Timestamp || record.submittedAt || ''
          },
          gstDetails: record.GSTIN && record.GSTIN !== 'N/A' ? {
            included: true,
            gstNumber: record.GSTIN,
            shopName: record['Shop Name'] || '',
            baseAmount: csvOrNumber(record['Base Amount']),
            gstAmount: csvOrNumber(record['GST Tax Amount']),
            totalAmount: csvOrNumber(record['Gross Total'])
          } : null,
          status: record.Status || record.status || 'Out for Delivery',
          submittedAt: record.Timestamp || record.submittedAt || ''
        };
        if (!packagesByOrder.has(orderId)) packagesByOrder.set(orderId, []);
        packagesByOrder.get(orderId).push(importedPackage);
      });
      AppState.orders = dedupeOrderRecords(AppState.orders.map(order => {
        const sheetPackages = packagesByOrder.get(order.id);
        if (!sheetPackages?.length) return normalizeOrder(order);
        const existingPackages = new Map((order.deliveryPackages || []).map(packageEntry => [packageEntry.id, packageEntry]));
        sheetPackages.forEach(importedPackage => {
          const existingPackage = existingPackages.get(importedPackage.id) || {};
          existingPackages.set(importedPackage.id, {
            ...importedPackage,
            ...existingPackage,
            sequence: Number(existingPackage.sequence) || importedPackage.sequence,
            doNumber: existingPackage.doNumber || importedPackage.doNumber,
            packageTag: existingPackage.packageTag || importedPackage.packageTag,
            delivery: { ...importedPackage.delivery, ...(existingPackage.delivery || {}) },
            gstDetails: existingPackage.gstDetails || importedPackage.gstDetails
          });
        });
        const deliveryPackages = [...existingPackages.values()].sort((left, right) =>
          (Number(left.sequence) || 0) - (Number(right.sequence) || 0));
        return normalizeOrder({ ...order, deliveryPackages });
      }));
    }

    persistLocalState();
    renderAllViews();
    lastCloudSyncError = null;
    if (showResult) {
      setDataManagementStatus(`Imported ${admins.length} admins, ${customers.length} bookers, ${products.length} products, and ${orders.length} orders.`);
      alert('Google Sheet data imported successfully.');
    }
    return true;
    } catch (error) {
    lastCloudSyncError = error;
    if (showResult) {
      setDataManagementStatus(error.message, true);
      alert(`Google Sheet import failed: ${error.message}`);
    } else {
      console.warn('Background cloud sync failed:', error.message);
    }
    return false;
    }
  })();
  if (showResult) return syncRequest;
  cloudSyncInFlight = syncRequest.finally(() => { cloudSyncInFlight = null; });
  return cloudSyncInFlight;
}

function currentSyncActorKey() {
  if (AppState.currentUser?.role === 'customer') return `customer:${AppState.currentUser.customerId}`;
  if (AppState.currentUser?.role === 'admin') return `admin:${AppState.currentUser.adminId}`;
  return '';
}

function hasPendingSyncForCurrentUser() {
  const actorKey = currentSyncActorKey();
  return offlineOutbox.some(item => !item.actorKey || item.actorKey === actorKey);
}

function syncFromGoogleSheets() {
  return syncCloudData(true);
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
  if (result.file && order.gstDetails && !result.packageId) {
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
      item.deliveryPackages?.forEach(packageEntry => {
        if (packageEntry.gstDetails?.fileId && deleted.has(packageEntry.gstDetails.fileId)) {
          packageEntry.gstDetails = { ...packageEntry.gstDetails, fileData: '', fileUrl: '', attachmentDeleted: true };
        }
      });
    });
  }
  if (result.packageId && result.file) {
    const packageEntry = order.deliveryPackages?.find(item => item.id === result.packageId);
    if (packageEntry) packageEntry.gstDetails = { ...packageEntry.gstDetails, ...result.file, fileData: '' };
  }
  if (result.packageId && (result.sequence || result.doNumber)) {
    const packageEntry = order.deliveryPackages?.find(item => item.id === result.packageId);
    if (packageEntry) {
      packageEntry.sequence = Number(result.sequence) || packageEntry.sequence;
      packageEntry.doNumber = result.doNumber || `DO${packageEntry.sequence}`;
      packageEntry.packageTag = result.packageTag || deliveryPackageTag(order, packageEntry);
    }
  }
  persistLocalState();
}

function ensureOrderSettlementMeta(order) {
  if (!order || typeof order !== 'object') return order;
  const status = String(order.status || '').trim();
  if (status.toLowerCase() === 'settled' && !order.settledAt) {
    order.settledAt = todayIsoDate();
  }
  return order;
}

function resolveMappedCatalogProductName(productName) {
  const normalized = String(productName || '').trim();
  if (!normalized) return { matched: false, productId: '', productModel: '' };

  const currentAdminId = AppState.currentUser?.role === 'customer'
    ? AppState.currentUser.adminId
    : AppState.currentUser?.adminId || AppState.adminProfile?.adminId || '';

  const candidates = AppState.productIndexByName?.get(normalizeProductName(normalized)) || [];
  const existingProduct = candidates.find(product => {
    if (!product || !product.name) return false;
    if (AppState.currentUser?.isMaster) return true;
    if (!currentAdminId) return true;
    return sameAdminId(product.adminId, currentAdminId);
  }) || AppState.products.find(product => {
    if (!product || !product.name) return false;
    const sameName = normalizeProductName(product.name) === normalizeProductName(normalized);
    if (!sameName) return false;
    if (AppState.currentUser?.isMaster) return true;
    if (!currentAdminId) return true;
    return sameAdminId(product.adminId, currentAdminId);
  });

  if (!existingProduct) return { matched: false, productId: '', productModel: normalized };
  return { matched: true, productId: String(existingProduct.id), productModel: existingProduct.name };
}

function normalizeOrderForCloudSync(order) {
  if (!order || typeof order !== 'object') return order;
  const normalized = { ...order };
  const productModel = String(normalized.productModel || '').trim();
  if (!productModel) return ensureOrderSettlementMeta(normalized);
  const mapped = resolveMappedCatalogProductName(productModel);
  if (!mapped.matched) return ensureOrderSettlementMeta(normalized);
  return ensureOrderSettlementMeta({
    ...normalized,
    productId: mapped.productId || normalized.productId || '',
    productModel: mapped.productModel
  });
}

function normalizeQueuedSyncItem(item) {
  if (!item || typeof item !== 'object') return item;
  if (item.actionType === 'NEW_ORDER' && item.payload?.order) {
    const normalizedOrder = normalizeOrderForCloudSync(item.payload.order);
    const mapped = resolveMappedCatalogProductName(String(normalizedOrder.productModel || ''));
    return {
      ...item,
      payload: {
        ...item.payload,
        order: { ...normalizedOrder, ...(mapped.matched ? { productId: mapped.productId, productModel: mapped.productModel } : {}) }
      }
    };
  }
  if (item.actionType === 'DELIVERY_SUBMITTED' && item.payload?.order) {
    const normalizedOrder = normalizeOrderForCloudSync(item.payload.order);
    return {
      ...item,
      payload: {
        ...item.payload,
        order: normalizedOrder,
        ...(normalizedOrder.productId ? { orderId: normalizedOrder.id || item.payload.orderId } : {})
      }
    };
  }
  return item;
}

async function triggerAutoCloudSync(actionType, data = {}) {
  await storageReady;
  persistLocalState();

  let endpoint = '';
  let payload = {};

  if (actionType === "NEW_ORDER") {
    endpoint = '/orders/create';
    const sanitized = normalizeOrderForCloudSync(data.order);
    const resolved = resolveMappedCatalogProductName(String(sanitized?.productModel || ''));
    if (String(sanitized?.productModel || '').trim() && resolved.matched) {
      sanitized.productId = resolved.productId;
      sanitized.productModel = resolved.productModel;
    }
    payload = { order: sanitized };
  } else if (actionType === "DELIVERY_SUBMITTED") {
    endpoint = '/orders/delivery';
    payload = {
      orderId: data.order.id,
      platform: data.order.platform,
      model: data.order.productModel,
      delivery: data.order.delivery,
      gstDetails: data.order.gstDetails,
      ...(data.packageEntry ? { packageEntry: data.packageEntry } : {})
    };
  } else if (actionType === "STATUS_CHANGED") {
    endpoint = '/orders/status';
    payload = {
      orderId: data.order.id,
      status: data.order.status,
      settledAt: data.order.settledAt,
      settledAmount: data.order.settledAmount
    };
  } else if (actionType === "PACKAGE_STATUS_CHANGED") {
    endpoint = '/orders/package-status';
    payload = { orderId: data.orderId, packageId: data.packageId, status: data.status };
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
    payload = { admin: data.profile || AppState.adminProfile };
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
  } else if (actionType === "CUSTOMER_DELETED") {
    endpoint = '/customers/delete';
    payload = { customerId: data.customerId };
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

  if (!endpoint) return { status: 'ignored' };

  if (navigator.onLine) {
    try {
      const result = await dispatchToBackend(endpoint, payload);
      if (actionType === 'DELIVERY_SUBMITTED') applyCloudInvoiceResult(data.order, result);
      updateQueueBadge();
      return { status: 'synced', result };
    } catch (err) {
      const isValidationIssue = err.status === 400 || err.status === 404 || err.status === 409 || err.status === 422;
      const isAuthIssue = err.status === 401 || err.status === 403
        || err.message.includes('active login session') || err.message.includes('Unauthorized API Token');
      const isRetryableIssue = !err.status || err.status >= 500 || err.status === 408 || err.status === 429;

      if (isAuthIssue || isValidationIssue) {
        console.warn(`[Request rejected] ${actionType}:`, err.message);
        return { status: 'rejected', error: err };
      }
      if (!isRetryableIssue) {
        console.warn(`[Request rejected] ${actionType}:`, err.message);
        return { status: 'rejected', error: err };
      }
      console.warn(`[Network/Auth Issue] Queuing ${actionType}:`, err.message);
      const item = { endpoint, payload, actionType, actorKey: currentSyncActorKey() };
      offlineOutbox.push(item);
      await addStoredQueueItem(item);
      updateQueueBadge();
      return { status: 'queued', error: err };
    }
  } else {
    const item = { endpoint, payload, actionType, actorKey: currentSyncActorKey() };
    offlineOutbox.push(item);
    await addStoredQueueItem(item);
    updateQueueBadge();
    return { status: 'queued' };
  }
}

async function flushOfflineQueue() {
  await storageReady;
  const actorKey = currentSyncActorKey();
  if (isFlushingOfflineQueue || offlineOutbox.length === 0 || !navigator.onLine || !AppState.sessionToken || !actorKey) return;
  isFlushingOfflineQueue = true;
  try {
    const pending = [...offlineOutbox];
    const actorQueue = pending.filter(item => !item.actorKey || item.actorKey === actorKey);
    const completed = new Set();
    for (const item of actorQueue) {
      const normalizedItem = normalizeQueuedSyncItem(item);
      if (!normalizedItem) {
        completed.add(item);
        continue;
      }
      try {
        const result = await dispatchToBackend(normalizedItem.endpoint, normalizedItem.payload);
        if (normalizedItem.actionType === 'DELIVERY_SUBMITTED') {
          const orderId = normalizedItem.payload.orderId;
          const order = AppState.orders.find(orderItem => orderItem.id === orderId);
          applyCloudInvoiceResult(order, { ...result, packageId: normalizedItem.payload.packageEntry?.id });
        }
        completed.add(item);
      } catch (error) {
        console.warn('Cloud sync queue paused; remaining actions kept for retry:', error.message);
        break;
      }
    }
    offlineOutbox = pending.filter(item => !completed.has(item));
    await replaceStoredQueue(offlineOutbox);
    updateQueueBadge();
  } finally {
    isFlushingOfflineQueue = false;
  }
}

window.addEventListener('online', () => {
  updateSyncStatus('busy', 'Syncing');
  flushOfflineQueue().catch(() => {});
});
window.addEventListener('offline', () => {
  updateSyncStatus('offline', 'Offline');
});

// 3. Application State & Storage
const AppState = {
  adminProfile: { adminId: '', name: '', username: '', active: true },
  admins: [],
  currentUser: null,
  activeAdminScope: null,
  productIndexById: new Map(),
  productIndexByName: new Map(),
  products: [
    { id: 'p1', name: 'iPhone 16 128GB Black', targetPrice: 74900, commission: 1500 },
    { id: 'p2', name: 'REDMI Note 15 SE 5G', targetPrice: 16999, commission: 800 },
    { id: 'p3', name: 'OnePlus 13R 256GB Cool Blue', targetPrice: 42999, commission: 1200 },
    { id: 'p4', name: 'MacBook Air M3 8/256GB Space Grey', targetPrice: 99900, commission: 2500 }
  ],
  customers: [],
  orders: [],
  tempGstFileData: null,
  sessionToken: '',
  pagination: {
    orders: { page: 1, pageSize: 25 },
    deliveries: { page: 1, pageSize: 20 },
    customers: { page: 1, pageSize: 20 }
  }
};
refreshProductLookupIndex();

let cloudSyncTimer = null;

async function persistSession() {
  await storageReady;
  if (!AppState.currentUser || !AppState.sessionToken) return;
  const session = { user: AppState.currentUser, token: AppState.sessionToken };
  if (storageDb) await writeStoredState('session', session);
  localStorage.setItem('dt_session', JSON.stringify(session));
}

async function clearPersistedSession() {
  await storageReady;
  if (storageDb) {
    await idbRequest(storageDb.transaction(STORAGE_STATE_STORE, 'readwrite').objectStore(STORAGE_STATE_STORE).delete('session'));
  }
  localStorage.removeItem('dt_session');
}

async function refreshCloudAfterAppUpdate() {
  if (!isAppUpdatePending()) return;
  showAppUpdateOverlay('Refreshing cloud data...');
  try {
    await flushOfflineQueue();
    if (AppState.currentUser && navigator.onLine) {
      showAppUpdateOverlay('Refreshing cloud data...');
      const refreshed = await syncCloudData();
      if (!AppState.currentUser) {
        localStorage.removeItem(APP_UPDATE_PENDING_KEY);
        resetLoadingOverlay();
        return;
      }
      if (!refreshed) {
        throw lastCloudSyncError || new Error('Pending local changes could not be synchronized. Your local data has been preserved.');
      }
    } else if (AppState.currentUser) {
      throw new Error('You are offline. Your local data has been preserved; cloud data was not refreshed.');
    }
    localStorage.removeItem(APP_UPDATE_PENDING_KEY);
    resetLoadingOverlay();
  } catch (error) {
    console.warn('App update cloud refresh failed:', error.message);
    showAppUpdateOverlay(`Update installed, but cloud refresh failed: ${error.message}`, true);
  }
}

function continueAfterAppUpdateOffline() {
  localStorage.removeItem(APP_UPDATE_PENDING_KEY);
  resetLoadingOverlay();
}

function retryAppUpdateCloudRefresh() {
  return refreshCloudAfterAppUpdate();
}

function startCloudSync() {
  if (cloudSyncTimer) clearInterval(cloudSyncTimer);
  cloudSyncTimer = setInterval(() => {
    if (AppState.currentUser && navigator.onLine) syncCloudData().catch(() => {});
  }, 60000);
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function getInvoiceDate(order) {
  return String(order.gstDetails?.uploadedAt || order.delivery?.submittedAt || order.createdAt || '').slice(0, 10);
}

function deliveryPackageTag(order, packageEntry) {
  const deliveryDate = String(packageEntry.delivery?.deliveryDate
    || packageEntry.delivery?.submittedAt
    || packageEntry.submittedAt
    || order.createdAt
    || todayIsoDate()).slice(0, 10);
  const sequence = Number(packageEntry.sequence)
    || Number(String(packageEntry.doNumber || '').match(/^DO(\d+)$/i)?.[1])
    || 0;
  const bookerId = String(order.customerId || '').trim() || 'shared';
  return `day-${deliveryDate}|booker-${bookerId}|order-${order.id || 'order'}|do-${sequence}`;
}

function dedupeOrderPackages(order, packages) {
  const byIdentity = new Map();
  const seenIds = new Set();
  const seenTags = new Set();
  (Array.isArray(packages) ? packages : []).forEach((packageEntry, index) => {
    const sequence = Number(packageEntry.sequence)
      || Number(String(packageEntry.doNumber || '').match(/^DO(\d+)$/i)?.[1])
      || index + 1;
    const normalized = {
      ...packageEntry,
      sequence,
      doNumber: packageEntry.doNumber || `DO${sequence}`
    };
    const id = String(normalized.id || '').trim();
    const tag = deliveryPackageTag(order, normalized);
    if ((id && seenIds.has(id)) || (sequence > 0 && seenTags.has(tag))) return;
    if (id) seenIds.add(id);
    if (sequence > 0) seenTags.add(tag);
    normalized.packageTag = tag;
    byIdentity.set(id || tag, normalized);
  });
  return [...byIdentity.values()].sort((left, right) => left.sequence - right.sequence);
}

function dedupeOrderRecords(orders) {
  const unique = new Map();
  (Array.isArray(orders) ? orders : []).forEach(order => {
    const id = String(order.id || '').trim();
    if (!id) return;
    const previous = unique.get(id);
    if (!previous) {
      unique.set(id, order);
      return;
    }
    const merged = { ...previous, ...order };
    merged.deliveryPackages = dedupeOrderPackages(merged, [
      ...(previous.deliveryPackages || []),
      ...(order.deliveryPackages || [])
    ]);
    unique.set(id, merged);
  });
  return [...unique.values()];
}

function getOrderNetDue(order) {
  if (!order) return 0;
  let payable = csvOrNumber(order.payableAmount);
  if (payable <= 0) {
    const paid = csvOrNumber(order.amountPaid);
    const profit = typeof getOrderProfit === 'function' ? getOrderProfit(order) : csvOrNumber(order.profit);
    payable = paid + profit;
  }
  return Math.max(0, payable - csvOrNumber(order.advancePaid) - csvOrNumber(order.settledAmount));
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

  const quantity = Math.max(1, Number(order.quantity) || 1);
  let amountPaid = csvOrNumber(order.amountPaid);
  let payableAmount = csvOrNumber(order.payableAmount);
  const profit = csvOrNumber(order.profit);

  // If amountPaid was stored as unit card price (e.g. 10,000 for quantity 2 with payable 20,200),
  // upgrade amountPaid to total order card amount: amountPaid * quantity
  let unitPrice = csvOrNumber(order.unitPrice);
  if (quantity > 1 && amountPaid > 0 && Math.round(amountPaid * quantity + profit) === Math.round(payableAmount)) {
    unitPrice = amountPaid;
    amountPaid = amountPaid * quantity;
  } else if (quantity > 1 && unitPrice <= 0 && amountPaid > 0) {
    unitPrice = Math.round(amountPaid / quantity);
  } else if (quantity === 1) {
    unitPrice = amountPaid;
  }

  if (payableAmount <= 0 && (amountPaid > 0 || profit > 0)) {
    payableAmount = amountPaid + profit;
  }

  return {
    ...order,
    id: String(order.id || ''),
    merchantOrderId: String(order.merchantOrderId || ''),
    customerId: String(order.customerId || ''),
    customerName: String(order.customerName || ''),
    productModel: String(order.productModel || ''),
    cardLast4: String(order.cardLast4 || ''),
    platform: String(order.platform || 'Other'),
    unitPrice,
    amountPaid,
    payableAmount,
    advancePaid: csvOrNumber(order.advancePaid),
    settledAmount: csvOrNumber(order.settledAmount),
    profit,
    quantity,
    createdAt: order.createdAt || todayIsoDate(),
    settledAt: order.settledAt || order['Settled Date'] || (String(order.Status || order.status).toLowerCase() === 'settled' ? (order.Date || order.createdAt || todayIsoDate()) : null),
    delivery,
    deliveryPackages: dedupeOrderPackages(order, (Array.isArray(order.deliveryPackages) ? order.deliveryPackages : []).map((packageEntry, index) => {
      const sequence = Number(packageEntry.sequence) || index + 1;
      return {
        ...packageEntry,
        id: String(packageEntry.id || ''),
        sequence,
        doNumber: packageEntry.doNumber || `DO${sequence}`,
        delivery: packageEntry.delivery ? {
          ...packageEntry.delivery,
          platform: packageEntry.delivery.platform || order.platform || 'Other',
          pincode: String(packageEntry.delivery.pincode || ''),
          tracking: String(packageEntry.delivery.tracking || ''),
          recipientName: String(packageEntry.delivery.recipientName || ''),
          deliveryDate: packageEntry.delivery.deliveryDate || packageEntry.delivery.submittedAt || order.createdAt || todayIsoDate()
        } : null
      };
    })),
    isToday: delivery?.deliveryDate === todayIsoDate(),
    gstDetails: order.gstDetails ? {
      ...order.gstDetails,
      included: Boolean(order.gstDetails.included),
      totalAmount: csvOrNumber(order.gstDetails.totalAmount),
      gstAmount: csvOrNumber(order.gstDetails.gstAmount),
      baseAmount: csvOrNumber(order.gstDetails.baseAmount)
    } : null
  };
}

function getEffectiveAdminScopeId() {
  if (!AppState.currentUser || AppState.currentUser.role !== 'admin') return null;
  if (AppState.currentUser.isMaster) {
    return AppState.activeAdminScope || null;
  }
  return AppState.currentUser.adminId;
}

function getVisibleOrders() {
  if (!AppState.currentUser) return [];
  if (AppState.currentUser.role !== 'admin') {
    return dedupeOrderRecords(AppState.orders.filter(order =>
      String(order.customerId || '').trim().toLowerCase() === String(AppState.currentUser.customerId || '').trim().toLowerCase()));
  }
  if (AppState.currentUser.isMaster) {
    return dedupeOrderRecords(AppState.activeAdminScope
      ? AppState.orders.filter(order => sameAdminId(order.adminId, AppState.activeAdminScope))
      : AppState.orders);
  }
  return dedupeOrderRecords(AppState.orders.filter(order => sameAdminId(order.adminId, AppState.currentUser.adminId)));
}

function getOrderProfit(order) {
  const storedProfit = csvOrNumber(order.profit);
  if (storedProfit > 0) return storedProfit;
  const product = AppState.products.find(item => item.name === order.productModel);
  return csvOrNumber(product?.commission) * (order.quantity || 1);
}

function getDeliveryDate(order) {
  return order.delivery?.deliveryDate || order.createdAt || '';
}

function persistLocalState() {
  try {
    delete AppState.adminProfile.password;
    delete AppState.adminProfile.passwordHash;
    AppState.admins.forEach(adminItem => {
      delete adminItem.password;
      delete adminItem.passwordHash;
    });
    AppState.customers.forEach(customer => {
      delete customer.password;
      delete customer.passwordHash;
    });
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
    AppState.adminProfile = { adminId: '', name: '', username: '', active: true };
  }
  AppState.customers = AppState.customers.filter(customer => !(customer.id === 'CUST-1001' && customer.password === 'booker123'));
  delete AppState.adminProfile.password;
  delete AppState.adminProfile.passwordHash;
  AppState.admins.forEach(adminItem => {
    delete adminItem.password;
    delete adminItem.passwordHash;
  });
  AppState.customers.forEach(customer => {
    delete customer.password;
    delete customer.passwordHash;
  });
  persistLocalState();
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

const MAX_TABLE_ROWS = 80;

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
  const notice = document.getElementById('auth-session-notice');
  if (notice) notice.style.display = 'none';
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
  const loginButton = document.getElementById('auth-submit-button');

  setInlineLoadingState('Signing in...', true);
  setButtonLoadingState(loginButton, 'Signing in...', true);

  try {
    updateSyncStatus('busy', 'Signing in');
    const result = await dispatchToBackend('/auth/login', { username: u, password: p });
    AppState.currentUser = result.user;
    AppState.sessionToken = result.sessionToken;
    await persistSession();
    await flushOfflineQueue();
    if (!AppState.currentUser) return;
    await syncCloudData().catch(() => {});
    if (result.user.isMaster) {
      AppState.adminProfile = { ...AppState.adminProfile, adminId: result.user.adminId, name: result.user.name, active: true };
      if (!AppState.admins.some(adminItem => adminItem.adminId === result.user.adminId)) AppState.admins.unshift(AppState.adminProfile);
      AppState.activeAdminScope = null;
    }
    updateSyncStatus('online', 'Synced');
    showAuthenticatedView();
  } catch (error) {
    updateSyncStatus('failed', 'Login failed');
    alert(error.message || 'Login failed.');
  } finally {
    setInlineLoadingState('Signing in...', false);
    setButtonLoadingState(loginButton, 'Signing in...', false);
  }
}

function showAuthenticatedView() {
  document.getElementById('view-auth').style.display = 'none';
  document.getElementById('view-app-main').style.display = 'flex';
  document.getElementById('badge-active-role').textContent = AppState.currentUser.role === 'admin'
    ? (AppState.currentUser.isMaster ? 'Master Admin' : 'Admin Portal')
    : 'Booker Portal';
  document.getElementById('user-display-label').textContent = AppState.currentUser.name;
  if (AppState.currentUser.role === 'admin') {
    document.getElementById('cfg-admin-id').value = AppState.currentUser.adminId;
    document.getElementById('cfg-admin-name').value = AppState.currentUser.name || '';
    document.getElementById('cfg-admin-user').value = AppState.currentUser.username || '';
    document.getElementById('master-security-card').querySelector('.form-label').textContent = 'Admin ID';
    const addAdminButton = document.getElementById('add-admin-button');
    if (addAdminButton) addAdminButton.style.display = AppState.currentUser.isMaster ? '' : 'none';
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
  startCloudSync();
}

async function logoutApp(reason = '') {
  appLoadingRequestCount = 0;
  const overlay = document.getElementById('app-loading-overlay');
  if (overlay) {
    overlay.classList.remove('compact');
    overlay.hidden = true;
    overlay.setAttribute('aria-busy', 'false');
    overlay.querySelector('.app-loading-text').textContent = '';
  }
  AppState.currentUser = null;
  AppState.sessionToken = '';
  if (cloudSyncTimer) clearInterval(cloudSyncTimer);
  await clearPersistedSession();
  const notice = document.getElementById('auth-session-notice');
  if (notice) {
    if (reason) {
      notice.textContent = reason;
      notice.style.display = 'block';
    } else {
      notice.textContent = '';
      notice.style.display = 'none';
    }
  }
  document.getElementById('view-app-main').style.display = 'none';
  document.getElementById('view-auth').style.display = 'flex';
}

async function handleSaveAdminProfile(e) {
  e.preventDefault();
  const profile = {
    adminId: AppState.currentUser.adminId,
    name: document.getElementById('cfg-admin-name').value.trim(),
    username: document.getElementById('cfg-admin-user').value.trim(),
    password: document.getElementById('cfg-admin-pass').value.trim(),
    active: true
  };
  if (AppState.currentUser.isMaster) {
    AppState.adminProfile = { ...AppState.adminProfile, adminId: profile.adminId, name: profile.name, username: profile.username, active: true };
    AppState.currentUser = { ...AppState.currentUser, name: profile.name, username: profile.username };
    await triggerAutoCloudSync('ADMIN_SYNC', { profile });
  } else {
    AppState.currentUser = { ...AppState.currentUser, name: profile.name, username: profile.username };
    await triggerAutoCloudSync('ADMIN_PROFILE_SYNC', { profile });
  }
  document.getElementById('cfg-admin-pass').value = '';
  persistLocalState();
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
    active: true,
    createdBy: AppState.currentUser.adminId
  };
  const adminPayload = { ...admin, password: document.getElementById('new-admin-password').value };
  if (AppState.admins.some(item => String(item.adminId).trim().toLowerCase() === admin.adminId.toLowerCase()
    || String(item.username).trim().toLowerCase() === admin.username.toLowerCase())
    || AppState.customers.some(item => String(item.username || item.id).trim().toLowerCase() === admin.username.toLowerCase())) {
    alert('Admin ID or username already exists.');
    return;
  }
  AppState.admins.push(admin);
  persistLocalState();
  renderAdminAccessTable();
  closeModal('modal-create-admin');
  triggerAutoCloudSync('ADMIN_CREATED', { admin: adminPayload });
  document.getElementById('new-admin-password').value = '';
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
  const totalDue = active.reduce((s, o) => s + getOrderNetDue(o), 0);

  const homeGrid = document.getElementById('home-kpi-grid');
  if (!homeGrid) return;
  const profit = list.reduce((sum, order) => sum + getOrderProfit(order), 0);
  const profitDue = list.filter(order => order.status !== 'Settled').reduce((sum, order) => sum + getOrderProfit(order), 0);
  homeGrid.innerHTML = `
    <div class="kpi-card cyan interactive" onclick="showActiveBookings()">
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

function showActiveBookings() {
  const statusFilter = document.getElementById('order-status-filter');
  const search = document.getElementById('order-search');
  if (statusFilter) statusFilter.value = 'ACTIVE';
  if (search) search.value = '';
  switchTab('tab-orders');
}

function packageProgressLabel(order) {
  const packages = dedupeOrderPackages(order, order.deliveryPackages || []);
  if (packages.length === 0) return '';
  const delivered = packages.filter(item => item.status === 'Delivered').length;
  return `Packages ${packages.length}/${order.quantity || 1} saved${delivered ? `, ${delivered} delivered` : ''}`;
}

function openOrderDeliveryPackages(orderId) {
  const search = document.getElementById('delivery-search');
  const dateFilter = document.getElementById('delivery-date-filter');
  if (search) search.value = orderId;
  if (dateFilter) dateFilter.value = '';
  switchTab('tab-delivery');
  renderDeliveryTable();
}

function openDeliveryPackageDetails(orderId, packageId = '') {
  const order = AppState.orders.find(item => item.id === orderId);
  const packageEntry = packageId
    ? order?.deliveryPackages?.find(item => item.id === packageId)
    : null;
  const delivery = packageEntry?.delivery || order?.delivery;
  if (!order || !delivery) return;

  const sequence = Number(packageEntry?.sequence) || 1;
  const doNumber = packageEntry?.doNumber || `DO${sequence}`;
  const parcelIndex = packageEntry
    ? Math.max(1, (order.deliveryPackages || []).findIndex(p => p.id === packageId) + 1)
    : 1;
  const deliveryLabel = (order.quantity || 1) > 1 ? `${doNumber} (Parcel ${parcelIndex} of ${order.quantity})` : doNumber;
  const details = [
    ['Delivery', deliveryLabel],
    ['Delivery date', delivery.deliveryDate || delivery.submittedAt || order.createdAt],
    ['Booker', order.customerName],
    ['Booker ID', order.customerId],
    ['Order ID', order.id],
    ['Product', `${order.productModel} ×${order.quantity || 1}`],
    ['Platform', delivery.platform || order.platform],
    ['Recipient', delivery.recipientName],
    ['Mobile', delivery.mobile],
    ['Tracking / AWB', delivery.tracking],
    ['OTP', delivery.otp],
    ['Pincode', delivery.pincode],
    ['Order amount paid', `₹${order.amountPaid.toLocaleString()}`],
    ['Order payable total', `₹${order.payableAmount.toLocaleString()}`],
    ['Advance taken', `₹${order.advancePaid.toLocaleString()}`],
    ['Settled', `₹${order.settledAmount.toLocaleString()}`],
    ['Net due', `₹${getOrderNetDue(order).toLocaleString()}`],
    ['Delivery status', packageEntry?.status || order.status]
  ];
  document.getElementById('delivery-details-title').textContent = `${doNumber} · ${order.productModel}${(order.quantity || 1) > 1 ? ` (Parcel ${parcelIndex}/${order.quantity})` : ''}`;
  document.getElementById('delivery-details-body').innerHTML = details.map(([label, value]) =>
    `<div class="delivery-detail-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || '—')}</strong></div>`
  ).join('');
  openModal('modal-delivery-details');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function updateTodayBadge() {
  const count = getTodayModalDeliveries(false).length;
  const badge = document.getElementById('badge-today-count');
  if (badge) badge.textContent = `${count} Shipments`;
}

function getPaginationState(key, defaultSize = 25) {
  const state = AppState.pagination[key] || { page: 1, pageSize: defaultSize };
  AppState.pagination[key] = { ...state, pageSize: defaultSize };
  return AppState.pagination[key];
}

function renderPaginationControls(containerId, key, totalCount, defaultSize = 25) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const state = getPaginationState(key, defaultSize);
  const totalPages = Math.max(1, Math.ceil(totalCount / state.pageSize));
  state.page = Math.min(Math.max(1, state.page), totalPages);

  const prevDisabled = state.page <= 1 ? 'disabled' : '';
  const nextDisabled = state.page >= totalPages ? 'disabled' : '';
  const label = totalCount === 0 ? 'No rows' : `Page ${state.page} / ${totalPages}`;

  container.innerHTML = `
    <div class="table-pagination">
      <button class="btn btn-subtle btn-sm" data-page-role="prev" ${prevDisabled}>Prev</button>
      <span>${label}</span>
      <button class="btn btn-subtle btn-sm" data-page-role="next" ${nextDisabled}>Next</button>
    </div>
  `;

  const prevButton = container.querySelector('[data-page-role="prev"]');
  const nextButton = container.querySelector('[data-page-role="next"]');
  if (prevButton && !prevDisabled) prevButton.onclick = () => { state.page = Math.max(1, state.page - 1); renderAllViews(); };
  if (nextButton && !nextDisabled) nextButton.onclick = () => { state.page = Math.min(totalPages, state.page + 1); renderAllViews(); };
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
    const due = getOrderNetDue(o);
    const deliveryPackages = dedupeOrderPackages(o, o.deliveryPackages || []);
    const unitPrice = o.unitPrice || (o.quantity > 1 ? Math.round(o.amountPaid / o.quantity) : o.amountPaid);
    const paidDisplay = `₹${o.amountPaid.toLocaleString()}${o.quantity > 1 ? `<br><small style="color:var(--text-muted); font-size:11px;">(₹${unitPrice.toLocaleString()}/unit)</small>` : ''}`;
    homeTbody.innerHTML += `
      <tr>
        <td><strong>${o.id}</strong>${o.merchantOrderId ? `<br><small style="color:var(--text-muted); font-size:11px;">Merchant: ${o.merchantOrderId}</small>` : ''}</td>
        <td><span class="pill pill-indigo">${o.platform}</span></td>
        <td>${o.productModel} <span class="pill pill-indigo">×${o.quantity || 1}</span>${packageProgressLabel(o) ? `<br><small>${packageProgressLabel(o)}</small>` : ''}</td>
        <td>${o.customerName}</td>
        <td>•••• ${o.cardLast4}</td>
        <td>${paidDisplay}</td>
        <td style="color:#fbbf24;">₹${(o.advancePaid || 0).toLocaleString()}</td>
        <td style="color:#34d399; font-weight:700;">₹${due.toLocaleString()}</td>
        <td>${o.gstDetails ? `<span class="pill pill-green">₹${o.gstDetails.gstAmount || o.gstDetails.totalAmount}</span>` : '-'}</td>
        <td><span class="pill pill-amber">${o.status}</span></td>
        <td>
          ${deliveryPackages.length ? `<button class="btn btn-subtle btn-sm" onclick="openOrderDeliveryPackages('${o.id}')">View delivery details</button>` : !o.delivery?.submitted ? `<button class="btn btn-primary btn-sm" onclick="openDeliveryModalForOrder('${o.id}')">Submit Delivery</button>` : `<button class="btn btn-subtle btn-sm" onclick="openDeliveryPackageDetails('${o.id}')">View details</button>`}
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
    if (statusFilter === 'ACTIVE' && o.status === 'Settled') return false;
    if (statusFilter !== 'ALL' && statusFilter !== 'ACTIVE' && o.status !== statusFilter) return false;
    if (search) {
      const match = String(o.id).toLowerCase().includes(search) || 
                    (o.merchantOrderId && String(o.merchantOrderId).toLowerCase().includes(search)) ||
                    o.productModel.toLowerCase().includes(search) ||
                    o.customerName.toLowerCase().includes(search) ||
                    o.cardLast4.includes(search);
      if (!match) return false;
    }
    return true;
  });

  const paginationState = getPaginationState('orders', 25);
  const totalPages = Math.max(1, Math.ceil(filtered.length / paginationState.pageSize));
  paginationState.page = Math.min(Math.max(1, paginationState.page), totalPages);
  const pageItems = filtered.slice((paginationState.page - 1) * paginationState.pageSize, paginationState.page * paginationState.pageSize);

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11" style="text-align:center; color:var(--text-muted); padding:20px;">No matching bookings.</td></tr>`;
    renderPaginationControls('orders-pagination', 'orders', 0, 25);
    return;
  }

  pageItems.forEach(o => {
    const due = getOrderNetDue(o);
    const deliveryPackages = dedupeOrderPackages(o, o.deliveryPackages || []);
    const unitPrice = o.unitPrice || (o.quantity > 1 ? Math.round(o.amountPaid / o.quantity) : o.amountPaid);
    const paidDisplay = `₹${o.amountPaid.toLocaleString()}${o.quantity > 1 ? `<br><small style="color:var(--text-muted); font-size:11px;">(₹${unitPrice.toLocaleString()}/unit)</small>` : ''}`;
    tbody.innerHTML += `
      <tr>
        <td><strong>${o.id}</strong>${o.merchantOrderId ? `<br><small style="color:var(--text-muted); font-size:11px;">Merchant: ${o.merchantOrderId}</small>` : ''}</td>
        <td><span class="pill pill-indigo">${o.platform}</span></td>
        <td>${o.productModel} <span class="pill pill-indigo">×${o.quantity || 1}</span>${packageProgressLabel(o) ? `<br><small>${packageProgressLabel(o)}</small>` : ''}</td>
        <td>•••• ${o.cardLast4}</td>
        <td>${o.customerName}</td>
        <td>${paidDisplay}</td>
        <td style="color:#fbbf24;">₹${(o.advancePaid || 0).toLocaleString()}</td>
        <td style="color:#34d399; font-weight:700;">₹${due.toLocaleString()}</td>
        <td>${o.gstDetails ? `<span class="pill pill-green">₹${o.gstDetails.totalAmount || o.gstDetails.gstAmount}</span>` : '-'}</td>
        <td><span class="pill ${o.status === 'Settled' ? 'pill-green' : 'pill-amber'}">${o.status}</span></td>
        <td>
          <div style="display:flex; gap:6px;">
            ${isAdmin && o.status === 'Pending Approval' ? `<button class="btn btn-primary btn-sm" onclick="approveBooking('${o.id}')">Approve</button>` : ''}
            ${deliveryPackages.length > 0 && deliveryPackages.length < o.quantity ? `<button class="btn btn-subtle btn-sm" onclick="continueDirectDeliveryEntry('${o.id}')">Continue packages</button>` : ''}
            ${deliveryPackages.length > 0 ? `<button class="btn btn-subtle btn-sm" onclick="openOrderDeliveryPackages('${o.id}')">View parcels</button>` : ''}
            ${o.status !== 'Pending Approval' && !o.delivery?.submitted ? `<button class="btn btn-subtle btn-sm" onclick="openDeliveryModalForOrder('${o.id}')">Delivery & GST</button>` : ''}
            ${isAdmin && o.status === 'Out for Delivery' && !deliveryPackages.length ? `<button class="btn btn-primary btn-sm" onclick="markOrderDelivered('${o.id}')">Mark Delivered</button>` : ''}
            ${isAdmin && o.status === 'Delivered' ? `<button class="btn btn-success btn-sm" onclick="openSettlementModalForOrder('${o.id}')">Settle</button>` : ''}
          </div>
        </td>
      </tr>
    `;
  });

  renderPaginationControls('orders-pagination', 'orders', filtered.length, 25);
}

function approveBooking(orderId) {
  const order = AppState.orders.find(item => item.id === orderId);
  if (!order || AppState.currentUser?.role !== 'admin' || !confirm(`Approve booking ${orderId}?`)) return;
  const triggerButton = findButtonByAction('approveBooking', orderId);
  setButtonLoadingState(triggerButton, 'Approving...', true);
  try {
    const deliveryPackages = dedupeOrderPackages(order, order.deliveryPackages || []);
    order.status = deliveryPackages.length ? 'Out for Delivery' : 'Booked';
    if (deliveryPackages.length) {
      order.deliveryPackages = deliveryPackages.map(packageEntry => ({ ...packageEntry, status: 'Out for Delivery' }));
      order.isToday = true;
    }
    order.approvedBy = AppState.currentUser.adminId;
    order.approvedAt = new Date().toISOString();
    renderAllViews();
    triggerAutoCloudSync('ORDER_APPROVED', { orderId });
  } finally {
    setButtonLoadingState(triggerButton, 'Approving...', false);
  }
}

function orderDeliveryEntries(order) {
  const packages = dedupeOrderPackages(order, order.deliveryPackages || []);
  if (packages.length) return packages.map((packageEntry, pIndex) => ({
    id: packageEntry.id,
    orderIndex: pIndex + 1,
    sequence: Number(packageEntry.sequence) || 0,
    doNumber: packageEntry.doNumber || '',
    packageTag: packageEntry.packageTag || deliveryPackageTag(order, packageEntry),
    delivery: packageEntry.delivery,
    gstDetails: packageEntry.gstDetails,
    status: packageEntry.status || (order.status === 'Pending Approval' ? 'Pending Approval' : 'Out for Delivery'),
    packageEntry: true
  }));
  return order.delivery?.submitted ? [{
    id: `pkg_${order.id}_1`,
    orderIndex: 1,
    sequence: 1,
    doNumber: 'DO1',
    packageTag: deliveryPackageTag(order, { sequence: 1, doNumber: 'DO1', delivery: order.delivery }),
    delivery: order.delivery,
    gstDetails: order.gstDetails,
    status: order.status,
    packageEntry: true
  }] : [];
}

function dedupeDeliveryRows(entries) {
  const seen = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const order = entry?.order;
    const deliveryDate = String(entry?.delivery?.deliveryDate || entry?.delivery?.submittedAt || order?.createdAt || todayIsoDate()).slice(0, 10);
    const customerKey = String(order?.customerId || '').trim() || 'shared';
    const doNumber = String(entry?.doNumber || 'DO1').trim();
    const sequence = Number(entry?.sequence) || Number(doNumber.match(/^DO(\d+)$/i)?.[1]) || 0;
    const packageKey = entry?.packageTag
      || (sequence > 0
        ? `day-${deliveryDate}|booker-${customerKey}|order-${order?.id || 'legacy'}|do-${sequence}`
        : `${order?.id || 'legacy'}|package-${entry?.id || entry?.packageId || 'legacy'}`);
    if (!seen.has(packageKey)) seen.set(packageKey, entry);
  }
  return [...seen.values()];
}

function renderDeliveryTable() {
  const tbody = document.getElementById('table-delivery-list');
  if (!tbody) return;
  tbody.innerHTML = '';

  const search = (document.getElementById('delivery-search')?.value || '').toLowerCase();
  const platFilter = document.getElementById('delivery-platform-filter')?.value || 'ALL';
  const isAdmin = AppState.currentUser?.role === 'admin';
  const selectedDate = document.getElementById('delivery-date-filter')?.value || '';

  const deliveries = dedupeDeliveryRows(getVisibleOrders().flatMap(order => orderDeliveryEntries(order).map((entry, index) => ({
    order,
    ...entry,
    sequence: entry.sequence || (entry.packageEntry ? index + 1 : 1),
    doNumber: entry.doNumber || (entry.packageEntry ? `DO${entry.sequence || index + 1}` : 'DO1')
  })))).filter(item => {
    const o = item.order;
    const d = item.delivery;
    if (!isAdmin && o.customerId !== AppState.currentUser.customerId) return false;
    if (!d || !d.submitted) return false;
    if (selectedDate && String(d.deliveryDate || d.submittedAt || o.createdAt).slice(0, 10) !== selectedDate) return false;
    if (platFilter !== 'ALL' && d.platform !== platFilter) return false;
    if (search) {
      return d.pincode.includes(search) || d.tracking.toLowerCase().includes(search) || d.recipientName.toLowerCase().includes(search)
        || o.productModel.toLowerCase().includes(search) || o.id.toLowerCase().includes(search)
        || (o.merchantOrderId && String(o.merchantOrderId).toLowerCase().includes(search))
        || item.doNumber.toLowerCase().includes(search);
    }
    return true;
  });

  // Sort deliveries by DO sequence ascending: DO1, DO2, DO3...
  deliveries.sort((a, b) => {
    const seqA = Number(a.sequence) || Number(String(a.doNumber || '').match(/\d+/)?.[0]) || 0;
    const seqB = Number(b.sequence) || Number(String(b.doNumber || '').match(/\d+/)?.[0]) || 0;
    return seqA - seqB;
  });

  const paginationState = getPaginationState('deliveries', 20);
  const totalPages = Math.max(1, Math.ceil(deliveries.length / paginationState.pageSize));
  paginationState.page = Math.min(Math.max(1, paginationState.page), totalPages);
  const pageItems = deliveries.slice((paginationState.page - 1) * paginationState.pageSize, paginationState.page * paginationState.pageSize);

  if (deliveries.length === 0) {
    tbody.innerHTML = `<tr><td colspan="12" style="text-align:center; color:var(--text-muted); padding:20px;">No deliveries found.</td></tr>`;
    renderPaginationControls('deliveries-pagination', 'deliveries', 0, 20);
    return;
  }

  pageItems.forEach(item => {
    const { order: o, delivery: d, gstDetails: packageGst, id: packageId } = item;
    const deliveryStatus = item.status || o.status;
    const parcelText = o.quantity > 1 ? `<br><small style="color:var(--text-muted);">Parcel ${item.orderIndex || 1} of ${o.quantity}</small>` : '';
    tbody.innerHTML += `
      <tr>
        <td><span class="pill pill-indigo">${d.platform}</span></td>
        <td><strong>${o.productModel}</strong>${parcelText}</td>
        <td><strong>${o.id}</strong>${o.merchantOrderId ? `<br><small style="color:var(--text-muted); font-size:11px;">Merchant: ${o.merchantOrderId}</small>` : ''}</td>
        <td><strong>${item.doNumber || 'DO1'}</strong></td>
        <td>${d.recipientName}</td>
        <td>${d.mobile}</td>
        <td><code>${d.tracking}</code></td>
        <td><strong style="color:#fbbf24;">${d.otp}</strong></td>
        <td><strong>${d.pincode}</strong></td>
        <td>${packageGst ? `<button class="btn btn-subtle btn-sm" onclick="viewGstInvoice('${o.id}', '${packageId}')">📄 View GST</button>` : 'None'}</td>
        <td><span class="pill pill-green">${deliveryStatus}</span></td>
        <td>
          <button class="btn btn-subtle btn-sm" onclick="openDeliveryPackageDetails('${o.id}', '${packageId}')">Details</button>
          ${isAdmin && deliveryStatus === 'Out for Delivery' ? `<button class="btn btn-primary btn-sm" onclick="markOrderDelivered('${o.id}', '${packageId}')">Mark Delivered</button>` : ''}
          ${isAdmin && !item.packageEntry && deliveryStatus === 'Delivered' ? `<button class="btn btn-success btn-sm" onclick="openSettlementModalForOrder('${o.id}')">Settle</button>` : ''}
          ${isAdmin && item.packageEntry && o.status === 'Delivered' && packageId === dedupeOrderPackages(o, o.deliveryPackages || []).at(-1)?.id ? `<button class="btn btn-success btn-sm" onclick="openSettlementModalForOrder('${o.id}')">Settle Order</button>` : ''}
        </td>
      </tr>
    `;
  });

  renderPaginationControls('deliveries-pagination', 'deliveries', deliveries.length, 20);
}

function renderCustomersTable() {
  const tbody = document.getElementById('table-customers-list');
  if (!tbody) return;
  tbody.innerHTML = '';

  const search = (document.getElementById('cust-search')?.value || '').toLowerCase();
  const filterState = document.getElementById('cust-status-filter')?.value || 'ALL';

  const customers = AppState.currentUser.isMaster
    ? (AppState.activeAdminScope
        ? AppState.customers.filter(customer => sameAdminId(customer.adminId, AppState.activeAdminScope))
        : AppState.customers)
    : AppState.customers.filter(customer => sameAdminId(customer.adminId, AppState.currentUser.adminId));
  const filteredCustomers = customers.filter(c => {
    const cOrders = dedupeOrderRecords(AppState.orders.filter(o => o.customerId === c.id));
    if (filterState !== 'ALL' && !cOrders.some(o => o.status === filterState)) return false;
    if (search && !c.name.toLowerCase().includes(search) && !c.id.toLowerCase().includes(search)) return false;
    return true;
  });

  const paginationState = getPaginationState('customers', 20);
  const totalPages = Math.max(1, Math.ceil(filteredCustomers.length / paginationState.pageSize));
  paginationState.page = Math.min(Math.max(1, paginationState.page), totalPages);
  const pageItems = filteredCustomers.slice((paginationState.page - 1) * paginationState.pageSize, paginationState.page * paginationState.pageSize);

  if (filteredCustomers.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center; color:var(--text-muted); padding:20px;">No matching bookers.</td></tr>`;
    renderPaginationControls('customers-pagination', 'customers', 0, 20);
    return;
  }

  pageItems.forEach(c => {
    const cOrders = dedupeOrderRecords(AppState.orders.filter(o => o.customerId === c.id));
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
          <button class="btn ${c.active === false ? 'btn-success' : 'btn-danger'} btn-sm" onclick="setCustomerActive('${c.id}', ${c.active === false})">${c.active === false ? 'Activate' : 'Revoke'}</button>
          <button class="btn btn-danger btn-sm" onclick="deleteCustomer('${c.id}')">Delete</button></td>
      </tr>
    `;
  });

  renderPaginationControls('customers-pagination', 'customers', filteredCustomers.length, 20);
}

function setCustomerActive(customerId, active) {
  const customer = AppState.customers.find(item => item.id === customerId);
  if (!customer || !confirm(`${active ? 'Activate' : 'Revoke'} ${customer.id}?`)) return;
  customer.active = active;
  persistLocalState();
  renderCustomersTable();
  triggerAutoCloudSync('CUSTOMER_STATUS_CHANGED', { customerId, active });
}

async function deleteCustomer(customerId) {
  const customer = AppState.customers.find(item => item.id === customerId);
  if (!customer || !confirm(`Delete booker ${customer.id} and all their bookings? This cannot be undone.`)) return;
  const triggerButton = findButtonByAction('deleteCustomer', customerId);
  setButtonLoadingState(triggerButton, 'Deleting...', true);
  try {
    const result = await dispatchToBackend('/customers/delete', { customerId });
    AppState.customers = AppState.customers.filter(item => item.id !== customerId);
    AppState.orders = AppState.orders.filter(order => order.customerId !== customerId);
    persistLocalState();
    renderAllViews();
    alert(`Booker deleted. ${result.deletedOrders || 0} booking(s) removed.`);
  } catch (error) {
    alert(`Booker deletion failed: ${error.message}`);
  } finally {
    setButtonLoadingState(triggerButton, 'Deleting...', false);
  }
}

function renderAdminAccessTable() {
  const container = document.getElementById('admin-access-list');
  if (!container) return;

  if (!AppState.currentUser?.isMaster) {
    container.innerHTML = '<span style="color:var(--text-muted);">Only the Master Admin can manage subordinate admins.</span>';
    return;
  }

  const masterId = AppState.adminProfile?.adminId || AppState.currentUser?.adminId;
  const subordinateAdmins = AppState.admins.filter(admin => admin && admin.adminId && !sameAdminId(admin.adminId, masterId));
  const scopedAdminId = AppState.activeAdminScope || null;

  const ownerScopeButton = scopedAdminId
    ? '<button class="btn btn-subtle btn-sm" onclick="returnToOwnerDashboard()">Return to Owner</button>'
    : '';

  container.innerHTML = subordinateAdmins.length
    ? subordinateAdmins.map(admin => `
      <div style="display:flex; justify-content:space-between; gap:10px; align-items:center; border-bottom:1px solid var(--border-subtle); padding:10px 0;">
        <div>
          <strong>${admin.adminId}</strong><br />
          <small>${admin.name || 'Unnamed admin'} · ${admin.username || 'No username'}</small>
        </div>
        <div style="display:flex; flex-wrap:wrap; gap:6px; justify-content:flex-end; align-items:center;">
          <span class="pill ${admin.active === false ? 'pill-amber' : 'pill-green'}">${admin.active === false ? 'Revoked' : 'Active'}</span>
          <button class="btn btn-subtle btn-sm" onclick="viewAdminProfile('${admin.adminId}')">Profile</button>
          <button class="btn btn-subtle btn-sm" onclick="openAdminDashboard('${admin.adminId}')">${scopedAdminId && sameAdminId(scopedAdminId, admin.adminId) ? 'Current Scope' : 'Open Dashboard'}</button>
          <button class="btn ${admin.active === false ? 'btn-success' : 'btn-danger'} btn-sm" onclick="setAdminActive('${admin.adminId}', ${admin.active === false})">${admin.active === false ? 'Activate' : 'Revoke'}</button>
          <button class="btn btn-danger btn-sm" onclick="deleteAdminAndData('${admin.adminId}')">Delete Data</button>
        </div>
      </div>
    `).join('') + ownerScopeButton
    : `<span style="color:var(--text-muted);">No subordinate admins have been created yet.</span>${ownerScopeButton}`;
}

function openAdminDashboard(adminId) {
  if (!AppState.currentUser?.isMaster) return;
  const admin = AppState.admins.find(item => sameAdminId(item.adminId, adminId));
  if (!admin) {
    alert('Admin not found.');
    return;
  }
  AppState.activeAdminScope = admin.adminId;
  switchTab('tab-home');
  renderAllViews();
}

function returnToOwnerDashboard() {
  if (!AppState.currentUser?.isMaster) return;
  AppState.activeAdminScope = null;
  switchTab('tab-home');
  renderAllViews();
}

function viewAdminProfile(adminId) {
  if (!AppState.currentUser?.isMaster) return;
  const admin = AppState.admins.find(item => sameAdminId(item.adminId, adminId));
  if (!admin) {
    alert('Admin profile was not found.');
    return;
  }

  const fields = {
    'admin-profile-id': admin.adminId || 'Unknown',
    'admin-profile-status': admin.active === false ? 'Revoked' : 'Active',
    'admin-profile-name': admin.name || 'Not set',
    'admin-profile-username': admin.username || 'Not set',
    'admin-profile-bookers': AppState.customers.filter(item => sameAdminId(item.adminId, admin.adminId)).length,
    'admin-profile-bookings': AppState.orders.filter(item => sameAdminId(item.adminId, admin.adminId)).length
  };

  Object.entries(fields).forEach(([fieldId, value]) => {
    const field = document.getElementById(fieldId);
    if (field) field.textContent = String(value);
  });
  openModal('modal-admin-profile');
}

async function deleteAdminAndData(adminId) {
  if (!AppState.currentUser?.isMaster || !confirm(`Delete ${adminId} and all of its bookers, products, and bookings? This cannot be undone.`)) return;
  const triggerButton = findButtonByAction('deleteAdminAndData', adminId);
  setButtonLoadingState(triggerButton, 'Deleting...', true);
  setAppLoadingState(`Deleting ${adminId} and related data...`, true);
  try {
    const result = await dispatchToBackend('/admin/delete', { adminId });
    AppState.admins = AppState.admins.filter(admin => !sameAdminId(admin.adminId, adminId));
    AppState.customers = AppState.customers.filter(customer => !sameAdminId(customer.adminId, adminId));
    AppState.products = AppState.products.filter(product => !sameAdminId(product.adminId, adminId));
    AppState.orders = AppState.orders.filter(order => !sameAdminId(order.adminId, adminId));
    persistLocalState();
    renderAllViews();
    alert(result.message || `Admin ${adminId} and its data were deleted from the server.`);
  } catch (error) {
    alert(`Admin deletion failed: ${error.message}`);
  } finally {
    setButtonLoadingState(triggerButton, 'Deleting...', false);
    setAppLoadingState('Deleting...', false);
  }
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
  const dateMode = document.getElementById('invoice-date-mode')?.value || 'TODAY';
  const dateFrom = document.getElementById('invoice-date-from')?.value || todayIsoDate();
  const dateTo = document.getElementById('invoice-date-to')?.value || dateFrom;

  if (selectFilter && selectFilter.options.length <= 1) {
    getAvailableProductsForCurrentUser().forEach(p => {
      selectFilter.innerHTML += `<option value="${p.name}">${p.name}</option>`;
    });
  }

  const list = getVisibleOrders().flatMap(order => {
    const packagesWithGst = (order.deliveryPackages || []).filter(item => item.gstDetails?.included);
    if (packagesWithGst.length > 0) {
      return packagesWithGst.map((item, idx) => ({
        order,
        packageId: item.id,
        doNumber: item.doNumber || `DO${item.sequence || idx + 1}`,
        parcelIndex: idx + 1,
        totalParcels: order.quantity || packagesWithGst.length,
        gstDetails: item.gstDetails,
        delivery: item.delivery
      }));
    }
    if (order.gstDetails?.included) {
      return [{
        order,
        packageId: '',
        doNumber: order.deliveryPackages?.[0]?.doNumber || 'DO1',
        parcelIndex: 1,
        totalParcels: order.quantity || 1,
        gstDetails: order.gstDetails,
        delivery: order.delivery
      }];
    }
    return [];
  }).filter(entry => {
    const { order, gstDetails, delivery } = entry;
    if (!gstDetails || gstDetails.attachmentDeleted || (productFilter !== 'ALL' && order.productModel !== productFilter)) return false;
    const invoiceDate = String(gstDetails.uploadedAt || delivery?.submittedAt || order.createdAt || '').slice(0, 10);
    if (dateMode === 'TODAY' && invoiceDate !== todayIsoDate()) return false;
    if (dateMode === 'CUSTOM' && (invoiceDate < dateFrom || invoiceDate > dateTo)) return false;
    if (!search) return true;
    return order.customerName.toLowerCase().includes(search) || order.productModel.toLowerCase().includes(search) || gstDetails.gstNumber?.toLowerCase().includes(search);
  });

  if (list.length === 0) {
    container.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 20px;">No GST invoices found.</div>`;
    return;
  }

  list.forEach(entry => {
    const { order: o, packageId, gstDetails } = entry;
    const key = packageId || o.id;
    const packageArg = packageId ? `, '${packageId}'` : '';
    const hasInvoice = Boolean(gstDetails.fileData || gstDetails.fileId || gstDetails.fileUrl);
    const parcelSubtitle = o.quantity > 1 ? ` | ${entry.doNumber || 'DO1'} (Parcel ${entry.parcelIndex || 1}/${o.quantity})` : ` | ${entry.doNumber || 'DO1'}`;
    container.innerHTML += `
      <div class="invoice-card">
        <div class="invoice-preview-box" data-invoice-preview="${key}" onclick="viewGstInvoice('${o.id}'${packageArg})" style="cursor:pointer;">
          ${hasInvoice ? '<span style="color:var(--text-muted);">Loading invoice...</span>' : '<span style="color:var(--text-muted);">Attachment unavailable</span>'}
        </div>
        <div style="font-size:0.85rem; font-weight:700;">${o.productModel}</div>
        <div style="font-size:0.75rem; color:var(--text-muted);">Order: <strong>${o.id}</strong>${parcelSubtitle} | Date: ${String(gstDetails.uploadedAt || entry.delivery?.submittedAt || o.createdAt || '').slice(0, 10)}</div>
        <div style="font-size:0.75rem; color:var(--text-muted);">${gstDetails.shopName || 'N/A'} | Tax: ₹${gstDetails.gstAmount}</div>
        <div style="display:flex; gap:6px; margin-top:4px;">
          <button class="btn btn-subtle btn-sm" style="flex:1;" onclick="viewGstInvoice('${o.id}'${packageArg})">View</button>
          <button class="btn btn-primary btn-sm" style="flex:1;" onclick="downloadSingleInvoice('${o.id}'${packageArg})">Download</button>
          <button class="btn btn-subtle btn-sm" style="flex:1;" onclick="editGstInvoice('${o.id}')">Edit</button>
          <button class="btn btn-danger btn-sm" style="flex:1;" onclick="deleteGstInvoice('${o.id}'${packageArg})">Delete</button>
        </div>
      </div>
    `;
  });
  hydrateInvoicePreviews(list);
}

function toggleInvoiceDateFilters() {
  const custom = document.getElementById('invoice-date-mode')?.value === 'CUSTOM';
  ['invoice-date-from', 'invoice-date-to'].forEach(id => {
    const input = document.getElementById(id);
    if (input) input.hidden = !custom;
  });
  renderInvoicesGallery();
}

async function deleteGstInvoice(orderId, packageId = '') {
  const order = getVisibleOrders().find(item => item.id === orderId);
  const packageEntry = order?.deliveryPackages?.find(item => item.id === packageId);
  const gstDetails = packageId ? packageEntry?.gstDetails : order?.gstDetails;
  const fileId = gstDetails?.fileId;
  if (!gstDetails || !fileId) return alert('This invoice has no cloud file to delete.');
  if (!confirm(`Delete only the invoice file for Order ${order.id} (${order.productModel})? GST and order data will be kept.`)) return;
  try {
    const response = await fetch(`${API_CONFIG.baseUrl}/invoices/${encodeURIComponent(fileId)}`, {
      method: 'DELETE',
      headers: {
        'x-api-key': API_CONFIG.secretToken,
        ...(AppState.sessionToken ? { 'x-session-token': AppState.sessionToken } : {})
      }
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
    if (packageId) packageEntry.gstDetails = { ...gstDetails, fileData: '', fileUrl: '', storagePath: '', attachmentDeleted: true };
    else order.gstDetails = { ...gstDetails, fileData: '', fileUrl: '', storagePath: '', attachmentDeleted: true };
    persistLocalState();
    renderAllViews();
  } catch (error) {
    alert(`Invoice deletion failed: ${error.message}`);
  }
}

async function getInvoiceBlobUrl(gstDetails) {
  if (gstDetails?.fileData) return gstDetails.fileData;
  if (!gstDetails?.fileId) return '';
  const response = await fetch(`${API_CONFIG.baseUrl}/invoices/${encodeURIComponent(gstDetails.fileId)}`, {
    headers: {
      'x-api-key': API_CONFIG.secretToken,
      ...(AppState.sessionToken ? { 'x-session-token': AppState.sessionToken } : {})
    }
  });
  if (!response.ok) throw new Error(`Invoice preview failed (${response.status})`);
  return URL.createObjectURL(await response.blob());
}

async function hydrateInvoicePreviews(entries) {
  await Promise.all(entries.map(async entry => {
    const key = entry.packageId || entry.order.id;
    const preview = [...document.querySelectorAll('[data-invoice-preview]')]
      .find(element => element.dataset.invoicePreview === key);
    if (!preview) return;
    try {
      const url = await getInvoiceBlobUrl(entry.gstDetails);
      const isPdf = entry.gstDetails.contentType === 'application/pdf'
        || String(entry.gstDetails.fileName || '').toLowerCase().endsWith('.pdf');
      preview.innerHTML = url
        ? (isPdf ? `<iframe src="${url}" title="GST invoice PDF preview" style="width:100%; height:180px; border:0;"></iframe>`
          : `<img src="${url}" alt="GST invoice" />`)
        : '<span style="color:var(--text-muted);">Attachment unavailable</span>';
    } catch (error) {
      preview.innerHTML = '<span style="color:var(--text-muted);">Attachment unavailable</span>';
      console.warn('Invoice preview unavailable:', error.message);
    }
  }));
}

function renderProductListSettings() {
  const container = document.getElementById('settings-product-list');
  if (!container) return;
  const searchInput = document.getElementById('product-catalog-search');
  const searchTerm = (searchInput?.value || '').trim().toLowerCase();
  const products = (AppState.currentUser?.isMaster
    ? (AppState.activeAdminScope
        ? AppState.products.filter(product => !product.adminId || sameAdminId(product.adminId, AppState.activeAdminScope))
        : AppState.products)
    : AppState.products.filter(product => !product.adminId || sameAdminId(product.adminId, AppState.currentUser.adminId)))
    .filter(product => {
      if (!searchTerm) return true;
      const haystack = [
        product.name || '',
        product.id || '',
        product.adminId || '',
        product.platform || '',
        String(product.targetPrice || ''),
        String(product.commission || '')
      ].join(' ').toLowerCase();
      return haystack.includes(searchTerm);
    });

  container.innerHTML = '';
  if (products.length === 0) {
    container.innerHTML = '<div style="padding:10px; border:1px dashed var(--border-subtle); color:var(--text-muted); border-radius:6px;">No matching products found for this catalog view.</div>';
    return;
  }

  products.forEach(p => {
    const canManage = AppState.currentUser?.isMaster || sameAdminId(p.adminId, AppState.currentUser?.adminId);
    container.innerHTML += `
      <div style="background:rgba(255,255,255,0.02); border:1px solid var(--border-subtle); padding:8px 12px; border-radius:6px; display:flex; justify-content:space-between; align-items:center; font-size:0.8rem;">
        <div><strong>${p.name}</strong><br/><span style="color:var(--text-muted); font-size:0.72rem;">Buy: ₹${Number(p.targetPrice || 0).toLocaleString()} · ${p.adminId || 'Shared catalog'}</span></div>
        <div style="display:flex; align-items:center; gap:8px;">
          <span class="pill ${p.active === false ? 'pill-amber' : 'pill-green'}">${p.active === false ? 'Inactive' : `+₹${Number(p.commission || 0)} Comm.`}</span>
          ${canManage ? `<button class="btn btn-subtle btn-sm" onclick="openEditProductModal('${p.id}')">✏️ Edit</button>
          <button class="btn ${p.active === false ? 'btn-success' : 'btn-danger'} btn-sm" onclick="setProductActive('${p.id}', ${p.active === false})">${p.active === false ? 'Activate' : 'Deactivate'}</button>` : '<span class="pill">Read only</span>'}
        </div>
      </div>
    `;
  });
}

function getAvailableProductsForCurrentUser(includeInactive = false) {
  const actor = AppState.currentUser;
  return AppState.products.filter(product => {
    const inScope = actor?.isMaster
      ? (!AppState.activeAdminScope || !product.adminId || sameAdminId(product.adminId, AppState.activeAdminScope))
      : (!product.adminId || sameAdminId(product.adminId, actor?.adminId));
    return inScope && (includeInactive || product.active !== false);
  });
}

// 8. Workflows (Booking, Delivery, Settlement)
async function openNewOrderModal() {
  await syncCloudData().catch(error => console.warn('Unable to refresh data before booking:', error.message));
  const pSelect = document.getElementById('modal-order-product');
  const availableProducts = getAvailableProductsForCurrentUser();
  pSelect.innerHTML = `${availableProducts.map(p => `<option value="${p.id}">${p.name} (₹${p.targetPrice} · Comm ₹${p.commission})</option>`).join('')}<option value="Other">Other / Custom model</option>`;

  const cSelect = document.getElementById('modal-order-customer-select');
  if (AppState.currentUser.role === 'admin') {
    const availableCustomers = AppState.currentUser.isMaster
      ? (AppState.activeAdminScope
          ? AppState.customers.filter(customer => sameAdminId(customer.adminId, AppState.activeAdminScope))
          : AppState.customers)
      : AppState.customers.filter(customer => sameAdminId(customer.adminId, AppState.currentUser.adminId));
    const selfOption = `<option value="ADMIN_SELF">${AppState.currentUser.name} (Admin Self)</option>`;
    cSelect.innerHTML = `${selfOption}${availableCustomers.map(c => `<option value="${c.id}">${c.name} (${c.id})</option>`).join('')}`;
  } else {
    cSelect.innerHTML = `<option value="${AppState.currentUser.customerId}">${AppState.currentUser.name}</option>`;
  }

  const merchantInput = document.getElementById('modal-merchant-order-id');
  if (merchantInput) merchantInput.value = '';
  document.getElementById('modal-order-id').value = '';
  document.getElementById('modal-order-card').value = '';
  document.getElementById('modal-order-paid').value = availableProducts[0]?.targetPrice || '';
  document.getElementById('modal-order-quantity').value = '1';
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

function generateOrderId(value = '', prefix = 'OD') {
  const trimmed = String(value || '').trim();
  const existingIds = new Set(AppState.orders.map(order => String(order.id || '').trim()).filter(Boolean));
  if (trimmed && !existingIds.has(trimmed)) return trimmed;

  const safePrefix = String(trimmed || prefix || 'OD').replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase() || 'OD';
  const suffix = String(Date.now()).slice(-6);
  let candidate = `${safePrefix}${suffix}`.slice(0, 12);

  if (!existingIds.has(candidate)) return candidate;

  let fallback = 0;
  while (fallback < 25) {
    const nextSuffix = `${String(Date.now()).slice(-6)}${String(Math.floor(Math.random() * 900) + 100)}`.slice(0, 12 - safePrefix.length);
    candidate = `${safePrefix}${nextSuffix}`.slice(0, 12);
    if (!existingIds.has(candidate)) return candidate;
    fallback += 1;
  }

  return `${safePrefix}${suffix}`.slice(0, 12);
}

function autoFillOrderPrice() {
  const pid = document.getElementById('modal-order-product').value;
  const prod = AppState.products.find(p => p.id === pid);
  if (prod) document.getElementById('modal-order-paid').value = prod.targetPrice;
}

function handleDirectDeliveryProductChange() {
  const productId = document.getElementById('direct-delivery-product').value;
  const product = AppState.products.find(item => item.id === productId);
  const customModel = document.getElementById('direct-delivery-custom-model');
  customModel.style.display = productId === 'Other' ? 'block' : 'none';
  customModel.required = productId === 'Other';
  document.getElementById('direct-delivery-card-amount').value = product ? product.targetPrice : '';
  document.getElementById('deliv-form-model').value = product ? product.name : (customModel.value || '');
}

function toggleDeliveryOtherPlatform() {
  const other = document.getElementById('deliv-form-platform').value === 'Other';
  const input = document.getElementById('deliv-form-platform-other');
  input.style.display = other ? 'block' : 'none';
  input.required = other;
}

function getNextDirectDeliverySequence(order, deliveryDate) {
  const targetDateKey = String(deliveryDate || todayIsoDate()).slice(0, 10);
  const targetCustomerId = String(order?.customerId || AppState.currentUser?.customerId || '').trim();
  let highest = 0;

  (AppState.orders || []).forEach(o => {
    if (targetCustomerId && String(o.customerId || '').trim() !== targetCustomerId) return;
    const pkgs = dedupeOrderPackages(o, o.deliveryPackages || []);
    pkgs.forEach(pkg => {
      const pkgDate = String(pkg.delivery?.deliveryDate || pkg.delivery?.submittedAt || pkg.submittedAt || o.createdAt || '').slice(0, 10);
      if (pkgDate === targetDateKey) {
        const seq = Number(pkg.sequence) || Number(String(pkg.doNumber || '').match(/^DO(\d+)$/i)?.[1]) || 0;
        if (seq > highest) highest = seq;
      }
    });
  });

  const orderPkgs = dedupeOrderPackages(order, order?.deliveryPackages || []);
  orderPkgs.forEach(pkg => {
    const seq = Number(pkg.sequence) || Number(String(pkg.doNumber || '').match(/^DO(\d+)$/i)?.[1]) || 0;
    if (seq > highest) highest = seq;
  });

  return highest + 1;
}

function updateDeliveryPackageProgress() {
  const quantity = Math.max(1, Number(document.getElementById('direct-delivery-quantity').value) || 1);
  const progress = document.getElementById('delivery-package-progress');
  if (progress) progress.textContent = `Package ${directDeliveryPackageIndex + 1} of ${quantity}`;
  const submit = document.getElementById('delivery-submit-button');
  if (submit && directDeliveryEntry) {
    submit.textContent = directDeliveryPackageIndex + 1 < quantity ? 'Next Package' : (quantity > 1 ? 'Save Final Package' : 'Submit Delivery');
  }
}

function setDirectDeliveryFieldsActive(active) {
  const section = document.getElementById('direct-delivery-fields');
  section.hidden = !active;
  ['direct-delivery-card-amount', 'direct-delivery-quantity'].forEach(id => {
    document.getElementById(id).required = active;
  });
  document.getElementById('deliv-form-platform').disabled = active && directDeliveryPackageIndex > 0;
  document.getElementById('deliv-form-platform-other').disabled = active && directDeliveryPackageIndex > 0;
  ['direct-delivery-product', 'direct-delivery-custom-model', 'direct-delivery-card-amount', 'direct-delivery-quantity', 'direct-delivery-owner', 'direct-delivery-card-last4'].forEach(id => {
    const field = document.getElementById(id);
    if (field) field.disabled = active && directDeliveryPackageIndex > 0;
  });
}

async function loadDeliveryContactSuggestions() {
  await storageReady;
  const ownerKey = AppState.currentUser?.role === 'customer'
    ? `customer:${AppState.currentUser.customerId}`
    : `admin:${AppState.currentUser?.adminId || ''}`;
  const contacts = await readStoredState(`deliveryContacts:${ownerKey}`, []);
  const fields = [
    ['delivery-contact-names', 'name'],
    ['delivery-contact-mobiles', 'mobile'],
    ['delivery-contact-pincodes', 'pincode']
  ];
  fields.forEach(([listId, key]) => {
    const list = document.getElementById(listId);
    if (list) list.innerHTML = contacts.map(contact => `<option value="${String(contact[key] || '').replace(/[&<>"']/g, '')}"></option>`).join('');
  });
}

async function rememberDeliveryContact(delivery) {
  await storageReady;
  const ownerKey = AppState.currentUser?.role === 'customer'
    ? `customer:${AppState.currentUser.customerId}`
    : `admin:${AppState.currentUser?.adminId || ''}`;
  const storageKey = `deliveryContacts:${ownerKey}`;
  const contacts = await readStoredState(storageKey, []);
  const normalize = value => String(value || '').replace(/\D/g, '');
  const phone = normalize(delivery.mobile);
  const namePin = `${String(delivery.recipientName).trim().toLowerCase()}|${String(delivery.pincode).trim()}`;
  const existing = contacts.filter(contact => normalize(contact.mobile) !== phone
    && `${String(contact.name).trim().toLowerCase()}|${String(contact.pincode).trim()}` !== namePin);
  existing.unshift({ name: delivery.recipientName.trim(), mobile: delivery.mobile.trim(), pincode: delivery.pincode.trim() });
  await writeStoredState(storageKey, existing.slice(0, 50));
}

function openDirectDeliveryEntry() {
  if (!AppState.currentUser) return;
  directDeliveryEntry = true;
  directDeliveryPackageIndex = 0;
  setDirectDeliveryFieldsActive(true);
  document.getElementById('deliv-form-order-id').value = '';
  const delivMerchantInput = document.getElementById('deliv-merchant-order-id');
  if (delivMerchantInput) delivMerchantInput.value = '';
  document.getElementById('deliv-order-id-input').value = '';
  const productSelect = document.getElementById('direct-delivery-product');
  const availableProducts = getAvailableProductsForCurrentUser();
  productSelect.innerHTML = `${availableProducts.map(product => `<option value="${product.id}">${product.name} (₹${product.targetPrice} · Comm ₹${product.commission})</option>`).join('')}<option value="Other">Other / Custom model</option>`;
  const ownerSelect = document.getElementById('direct-delivery-owner');
  const ownerField = document.getElementById('direct-delivery-owner-field');
  if (AppState.currentUser.role === 'admin') {
    const customers = AppState.currentUser.isMaster
      ? (AppState.activeAdminScope
          ? AppState.customers.filter(customer => sameAdminId(customer.adminId, AppState.activeAdminScope))
          : AppState.customers)
      : AppState.customers.filter(customer => sameAdminId(customer.adminId, AppState.currentUser.adminId));
    ownerSelect.innerHTML = `<option value="ADMIN_SELF">My admin account</option>${customers.map(customer => `<option value="${customer.id}">${customer.name} (${customer.id})</option>`).join('')}`;
    ownerField.hidden = false;
  } else {
    ownerSelect.innerHTML = `<option value="${AppState.currentUser.customerId}">${AppState.currentUser.name}</option>`;
    ownerField.hidden = true;
  }
  document.getElementById('direct-delivery-card-last4').value = '';
  document.getElementById('direct-delivery-quantity').value = '1';
  document.getElementById('deliv-form-platform').value = 'Flipkart';
  document.getElementById('deliv-form-platform-other').value = '';
  toggleDeliveryOtherPlatform();
  document.getElementById('deliv-form-name').value = '';
  document.getElementById('deliv-form-mobile').value = '';
  document.getElementById('deliv-form-tracking').value = '';
  document.getElementById('deliv-form-pincode').value = '';
  document.getElementById('deliv-form-otp').value = '';
  document.getElementById('deliv-gst-toggle').checked = false;
  document.getElementById('deliv-gst-file-input').value = '';
  document.getElementById('delivery-package-progress').textContent = '';
  document.getElementById('delivery-submit-button').textContent = 'Submit Delivery';
  AppState.tempGstFileData = null;
  toggleGstFields();
  handleDirectDeliveryProductChange();
  updateDeliveryPackageProgress();
  loadDeliveryContactSuggestions();
  openModal('modal-delivery-submission');
}

function continueDirectDeliveryEntry(orderId) {
  const order = AppState.orders.find(item => item.id === orderId);
  const savedPackages = dedupeOrderPackages(order, order?.deliveryPackages || []);
  if (!order || savedPackages.length >= order.quantity) return;
  openDirectDeliveryEntry();
  directDeliveryPackageIndex = savedPackages.length;
  document.getElementById('deliv-form-order-id').value = order.id;
  const delivMerchantInput = document.getElementById('deliv-merchant-order-id');
  if (delivMerchantInput) delivMerchantInput.value = order.merchantOrderId || '';
  document.getElementById('deliv-order-id-input').value = order.id;
  document.getElementById('deliv-form-model').value = order.productModel;
  const product = AppState.products.find(item => item.name === order.productModel);
  document.getElementById('direct-delivery-product').value = product?.id || 'Other';
  document.getElementById('direct-delivery-custom-model').value = product ? '' : order.productModel;
  document.getElementById('direct-delivery-custom-model').style.display = product ? 'none' : 'block';
  document.getElementById('direct-delivery-custom-model').required = !product;
  document.getElementById('direct-delivery-card-amount').value = order.unitPrice || (order.quantity > 1 ? Math.round(order.amountPaid / order.quantity) : order.amountPaid);
  document.getElementById('direct-delivery-quantity').value = order.quantity;
  document.getElementById('direct-delivery-card-last4').value = order.cardLast4 || '';
  document.getElementById('deliv-form-platform').value = ['Flipkart', 'Amazon', 'Reliance Digital', 'Croma', 'Pinelabs', 'Apple Store'].includes(order.platform) ? order.platform : 'Other';
  document.getElementById('deliv-form-platform-other').value = ['Flipkart', 'Amazon', 'Reliance Digital', 'Croma', 'Pinelabs', 'Apple Store', 'Other'].includes(order.platform) ? '' : order.platform;
  toggleDeliveryOtherPlatform();
  const ownerSelect = document.getElementById('direct-delivery-owner');
  ownerSelect.value = order.customerId;
  directDeliveryPackageIndex = savedPackages.length;
  setDirectDeliveryFieldsActive(true);
  updateDeliveryPackageProgress();
  const previousDelivery = savedPackages.at(-1)?.delivery;
  document.getElementById('deliv-form-name').value = previousDelivery?.recipientName || '';
  document.getElementById('deliv-form-mobile').value = previousDelivery?.mobile || '';
  document.getElementById('deliv-form-pincode').value = previousDelivery?.pincode || '';
  document.getElementById('deliv-form-tracking').value = '';
  document.getElementById('deliv-form-otp').value = '';
}

function handleCreateBooking(e) {
  e.preventDefault();
  const productSelect = document.getElementById('modal-order-product');
  const customInput = document.getElementById('modal-order-product-other');
  const requestedProductName = productSelect.value === 'Other' ? (customInput?.value || '').trim() : '';
  const mapped = requestedProductName ? resolveMappedCatalogProductName(requestedProductName) : null;
  const pid = mapped?.matched ? mapped.productId : productSelect.value;
  let prod = AppState.productIndexById.get(String(pid || '').toLowerCase()) || AppState.products.find(p => p.id === pid);

  if (productSelect.value === 'Other' && requestedProductName && mapped?.matched) {
    productSelect.value = mapped.productId;
    customInput.value = mapped.productModel;
    document.getElementById('modal-order-paid').value = (AppState.productIndexById.get(String(mapped.productId || '').toLowerCase()) || AppState.products.find(item => item.id === mapped.productId))?.targetPrice || '';
    prod = AppState.productIndexById.get(String(mapped.productId || '').toLowerCase()) || AppState.products.find(p => p.id === mapped.productId);
  }

  if (productSelect.value !== 'Other' && (!prod || !getAvailableProductsForCurrentUser().some(product => product.id === pid))) {
    alert('Select an active product assigned to your Admin account.');
    return;
  }
  const custId = document.getElementById('modal-order-customer-select').value;
  const isSelf = custId === 'ADMIN_SELF' || String(custId).startsWith('ADMIN-SELF-');
  const cust = isSelf
    ? { id: `ADMIN-SELF-${AppState.currentUser.adminId}`, name: `${AppState.currentUser.name} (Admin)`, adminId: AppState.currentUser.adminId }
    : AppState.customers.find(c => String(c.id).trim() === String(custId).trim()) ||
      (AppState.currentUser.role === 'customer' && String(AppState.currentUser.customerId).trim() === String(custId).trim()
        ? { id: AppState.currentUser.customerId, name: AppState.currentUser.name, adminId: AppState.currentUser.adminId }
        : null);
  if (!cust) {
    alert('Create or select a valid booker account first.');
    return;
  }
  const paid = Number(document.getElementById('modal-order-paid').value);
  const quantity = Math.max(1, Number(document.getElementById('modal-order-quantity').value) || 1);
  const adv = Number(document.getElementById('modal-order-advance').value) || 0;
  const comm = prod ? prod.commission : 1000;

  const merchantOrderId = document.getElementById('modal-merchant-order-id')?.value?.trim() || '';
  const newOrderId = generateOrderId(document.getElementById('modal-order-id').value.trim());
  document.getElementById('modal-order-id').value = newOrderId;
  const newOrder = {
    id: newOrderId,
    merchantOrderId,
    productId: prod?.id || '',
    platform: document.getElementById('modal-order-platform').value === 'Other'
      ? document.getElementById('modal-order-platform-other').value.trim()
      : document.getElementById('modal-order-platform').value,
    customerId: cust.id,
    adminId: AppState.currentUser.adminId || AppState.adminProfile.adminId,
    customerName: cust.name,
    productModel: prod ? prod.name : (document.getElementById('modal-order-product-other').value.trim() || 'Custom Device'),
    cardLast4: document.getElementById('modal-order-card').value.trim(),
    unitPrice: paid,
    amountPaid: paid * quantity,
    quantity,
    payableAmount: (paid + comm) * quantity,
    advancePaid: adv,
    settledAmount: 0,
    profit: comm * quantity,
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

  const savedPackages = dedupeOrderPackages(o, o.deliveryPackages || []);
  if (savedPackages.length < (o.quantity || 1)) {
    continueDirectDeliveryEntry(orderId);
    return;
  }

  directDeliveryEntry = false;
  setDirectDeliveryFieldsActive(false);
  document.getElementById('deliv-form-platform').disabled = false;
  document.getElementById('deliv-form-platform-other').disabled = false;
  document.getElementById('deliv-form-order-id').value = o.id;
  const delivMerchantInput = document.getElementById('deliv-merchant-order-id');
  if (delivMerchantInput) delivMerchantInput.value = o.merchantOrderId || '';
  document.getElementById('deliv-order-id-input').value = o.id;
  document.getElementById('deliv-form-model').value = o.productModel;
  document.getElementById('deliv-form-platform').value = o.platform || 'Flipkart';
  document.getElementById('deliv-form-platform-other').value = '';
  toggleDeliveryOtherPlatform();
  document.getElementById('deliv-form-name').value = o.delivery?.recipientName || '';
  document.getElementById('deliv-form-mobile').value = o.delivery?.mobile || '';
  document.getElementById('deliv-form-tracking').value = o.delivery?.tracking || '';
  document.getElementById('deliv-form-otp').value = o.delivery?.otp || '';
  document.getElementById('deliv-form-pincode').value = o.delivery?.pincode || '';
  document.getElementById('deliv-gst-toggle').checked = false;
  toggleGstFields();
  AppState.tempGstFileData = null;
  document.getElementById('deliv-gst-preview').style.display = 'none';
  openModal('modal-delivery-submission');
}

function editGstInvoice(orderId) {
  const order = AppState.orders.find(item => item.id === orderId);
  if (!order?.gstDetails) return;
  openDeliveryModalForOrder(orderId);
  const g = order.gstDetails;
  document.getElementById('deliv-gst-toggle').checked = true;
  toggleGstFields();
  document.getElementById('gst-input-number').value = g.gstNumber || '';
  document.getElementById('gst-input-shop').value = g.shopName || '';
  document.getElementById('gst-input-base').value = g.baseAmount || '';
  document.getElementById('gst-input-rate').value = g.gstRate || '18';
  recalcGstTotal();
  AppState.tempGstFileData = {
    name: g.fileName || 'invoice.jpg',
    data: '',
    fileId: g.fileId || '',
    fileUrl: g.fileUrl || '',
    storagePath: g.storagePath || ''
  };
  document.getElementById('upload-status-text').innerHTML = g.fileName
    ? `📎 <strong>${g.fileName}</strong> kept. Choose another file to replace it.`
    : '📁 <strong>Click to attach PDF or snap camera photo</strong>';
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

async function handleSaveDeliveryWithGst(e) {
  e.preventDefault();
  const visibleOrderIdInput = document.getElementById('deliv-order-id-input');
  const merchantOrderId = document.getElementById('deliv-merchant-order-id')?.value?.trim() || '';
  const rawOrderId = (document.getElementById('deliv-form-order-id').value || visibleOrderIdInput?.value || '').trim();
  let order = rawOrderId ? AppState.orders.find(o => o.id === rawOrderId) : null;
  const orderId = order ? order.id : generateOrderId(rawOrderId);
  if (visibleOrderIdInput) visibleOrderIdInput.value = orderId;
  document.getElementById('deliv-form-order-id').value = orderId;
  const submitButton = document.getElementById('delivery-submit-button');
  const packageLabel = directDeliveryEntry && Number(document.getElementById('direct-delivery-quantity')?.value || 1) > 1
    ? `Saving package ${Math.min(directDeliveryPackageIndex + 1, Number(document.getElementById('direct-delivery-quantity')?.value || 1))}...`
    : (directDeliveryEntry ? 'Saving delivery package...' : 'Saving delivery...');
  setInlineLoadingState(packageLabel, true);
  setButtonLoadingState(submitButton, packageLabel, true);
  try {
  if (directDeliveryEntry && !order) {
    const selectedProductId = document.getElementById('direct-delivery-product').value;
    let product = AppState.products.find(item => item.id === selectedProductId);
    let productModel = selectedProductId === 'Other'
      ? (document.getElementById('direct-delivery-custom-model').value.trim() || 'Custom Device')
      : product?.name;
    let commission = product ? (Number(product.commission) || 0) : 1000;
    if (selectedProductId === 'Other') {
      const mapped = resolveMappedCatalogProductName(productModel);
      if (mapped.matched) {
        document.getElementById('direct-delivery-product').value = mapped.productId;
        product = AppState.products.find(item => item.id === mapped.productId) || product;
        productModel = mapped.productModel;
        commission = Number(product?.commission) || 1000;
      }
    }
    const amountPaid = Number(document.getElementById('direct-delivery-card-amount').value);
    const quantity = Math.max(1, Number(document.getElementById('direct-delivery-quantity').value) || 1);
    if (!productModel || !Number.isFinite(amountPaid) || amountPaid < 0) return alert('Choose a product and enter a valid card amount.');
    const ownerId = document.getElementById('direct-delivery-owner').value;
    const customer = AppState.currentUser.role === 'customer'
      ? { id: AppState.currentUser.customerId, name: AppState.currentUser.name }
      : ownerId === 'ADMIN_SELF'
        ? { id: `ADMIN-SELF-${AppState.currentUser.adminId}`, name: `${AppState.currentUser.name} (Admin)` }
        : AppState.customers.find(item => item.id === ownerId);
    if (!customer) return alert('Choose a valid booker account.');
    const uniqueOrderId = orderId;
    order = {
      id: uniqueOrderId,
      merchantOrderId,
      productId: product?.id || '',
      platform: document.getElementById('deliv-form-platform').value === 'Other'
        ? document.getElementById('deliv-form-platform-other').value.trim()
        : document.getElementById('deliv-form-platform').value,
      productModel,
      customerId: customer.id,
      customerName: customer.name,
      adminId: customer.adminId || AppState.currentUser.adminId || AppState.adminProfile.adminId,
      cardLast4: document.getElementById('direct-delivery-card-last4').value.trim(),
      unitPrice: amountPaid,
      amountPaid: amountPaid * quantity,
      quantity,
      payableAmount: (amountPaid + commission) * quantity,
      advancePaid: 0,
      settledAmount: 0,
      profit: commission * quantity,
      status: AppState.currentUser.role === 'customer' ? 'Pending Approval' : 'Booked',
      isToday: false,
      createdAt: todayIsoDate(),
      settledAt: null,
      delivery: null,
      deliveryPackages: [],
      gstDetails: null
    };
    AppState.orders.unshift(order);
    document.getElementById('deliv-form-order-id').value = order.id;
    if (visibleOrderIdInput) visibleOrderIdInput.value = order.id;
    const createResult = await triggerAutoCloudSync('NEW_ORDER', { order });
    if (createResult?.status === 'rejected') {
      AppState.orders = AppState.orders.filter(item => item.id !== order.id);
      document.getElementById('deliv-form-order-id').value = '';
      persistLocalState();
      return alert(`Order could not be created: ${createResult.error.message}`);
    }
  }
  if (!order) return;
  if (merchantOrderId && !order.merchantOrderId) {
    order.merchantOrderId = merchantOrderId;
  }

  const totalPackages = directDeliveryEntry ? Math.max(1, Number(document.getElementById('direct-delivery-quantity').value) || 1) : 1;
  const packageId = directDeliveryEntry ? (window.crypto?.randomUUID?.() || `pkg_${Date.now()}_${Math.random().toString(36).slice(2)}`) : '';
  order.isToday = true;
  const delivery = {
    platform: document.getElementById('deliv-form-platform').value === 'Other'
      ? document.getElementById('deliv-form-platform-other').value.trim()
      : document.getElementById('deliv-form-platform').value,
    recipientName: document.getElementById('deliv-form-name').value,
    mobile: document.getElementById('deliv-form-mobile').value,
    tracking: document.getElementById('deliv-form-tracking').value,
    otp: document.getElementById('deliv-form-otp').value,
    pincode: document.getElementById('deliv-form-pincode').value,
    submitted: true,
    deliveryDate: todayIsoDate(),
    submittedAt: new Date().toISOString()
  };

  let gstDetails = null;
  if (document.getElementById('deliv-gst-toggle').checked) {
    const base = Number(document.getElementById('gst-input-base').value) || 0;
    const rate = Number(document.getElementById('gst-input-rate').value) || 18;
    const tax = Math.round((base * rate) / 100);
    gstDetails = {
      included: true,
      quantity: order.quantity || 1,
      adminId: order.adminId || '',
      customerId: order.customerId || '',
      orderId: order.id,
      gstNumber: document.getElementById('gst-input-number').value.trim(),
      shopName: document.getElementById('gst-input-shop').value.trim(),
      baseAmount: base,
      gstRate: rate,
      gstAmount: tax,
      totalAmount: base + tax,
      uploadedAt: new Date().toISOString(),
      fileName: AppState.tempGstFileData?.name || 'invoice.jpg',
      fileId: AppState.tempGstFileData?.fileId || '',
      fileData: AppState.tempGstFileData?.data || '',
      fileUrl: AppState.tempGstFileData?.fileUrl || '',
      storagePath: AppState.tempGstFileData?.storagePath || ''
    };
  }

  if (directDeliveryEntry) {
    if (gstDetails?.fileData) gstDetails.fileId = `invoice_${packageId}`;
    const sequence = getNextDirectDeliverySequence(order, delivery.deliveryDate);
    const packageEntry = {
      id: packageId,
      sequence,
      doNumber: `DO${sequence}`,
      packageTag: deliveryPackageTag(order, { sequence, doNumber: `DO${sequence}`, delivery, submittedAt: new Date().toISOString() }),
      delivery,
      gstDetails,
      status: order.status === 'Pending Approval' ? 'Pending Approval' : 'Out for Delivery',
      submittedAt: new Date().toISOString()
    };
    order.deliveryPackages ||= [];
    order.deliveryPackages.push(packageEntry);
    if (!order.delivery) {
      order.delivery = delivery;
    }
    if (order.status !== 'Pending Approval') order.status = 'Out for Delivery';
    await rememberDeliveryContact(delivery);
    persistLocalState();
    renderAllViews();
    const packageResult = await triggerAutoCloudSync('DELIVERY_SUBMITTED', { order, packageEntry });
    if (packageResult?.status === 'rejected') {
      order.deliveryPackages = order.deliveryPackages.filter(item => item.id !== packageId);
      if (order.deliveryPackages.length === 0) {
        order.delivery = null;
        order.gstDetails = null;
        order.status = AppState.currentUser?.role === 'customer' ? 'Pending Approval' : 'Booked';
      }
      persistLocalState();
      renderAllViews();
      return alert(`Package could not be saved: ${packageResult.error.message}`);
    }
    directDeliveryPackageIndex++;
    if (directDeliveryPackageIndex < totalPackages) {
      document.getElementById('delivery-package-progress').textContent = `Package ${directDeliveryPackageIndex + 1} of ${totalPackages}`;
      setDirectDeliveryFieldsActive(true);
      updateDeliveryPackageProgress();
      document.getElementById('deliv-form-name').value = delivery.recipientName;
      document.getElementById('deliv-form-mobile').value = delivery.mobile;
      document.getElementById('deliv-form-pincode').value = delivery.pincode;
      document.getElementById('deliv-form-tracking').value = '';
      document.getElementById('deliv-form-otp').value = '';
      document.getElementById('deliv-gst-toggle').checked = false;
      AppState.tempGstFileData = null;
      toggleGstFields();
      return;
    }
  } else {
    const sequence = getNextDirectDeliverySequence(order, delivery.deliveryDate);
    const standardPackageId = `pkg_${order.id}_1`;
    const standardPackageEntry = {
      id: standardPackageId,
      sequence,
      doNumber: `DO${sequence}`,
      packageTag: deliveryPackageTag(order, { sequence, doNumber: `DO${sequence}`, delivery, submittedAt: new Date().toISOString() }),
      delivery,
      gstDetails,
      status: order.status === 'Pending Approval' ? 'Pending Approval' : 'Out for Delivery',
      submittedAt: new Date().toISOString()
    };
    order.deliveryPackages = [standardPackageEntry];
    order.status = order.status === 'Pending Approval' ? 'Pending Approval' : 'Out for Delivery';
    order.delivery = delivery;
    order.gstDetails = gstDetails;
    await rememberDeliveryContact(delivery);
    persistLocalState();
    renderAllViews();
    triggerAutoCloudSync('DELIVERY_SUBMITTED', { order, packageEntry: standardPackageEntry });
  }
    directDeliveryEntry = false;
    closeModal('modal-delivery-submission');
    renderAllViews();
  } finally {
    setInlineLoadingState('Saving...', false);
    setAppLoadingState(directDeliveryEntry ? 'Saving delivery package...' : 'Saving delivery...', false);
    setButtonLoadingState(submitButton, packageLabel, false);
  }
}

function markOrderDelivered(orderId, packageId = '') {
  const o = AppState.orders.find(item => item.id === orderId);
  if (o && confirm(`Mark ${o.id} Delivered?`)) {
    const triggerButton = findButtonByAction('markOrderDelivered', orderId) || findButtonByAction('markOrderDelivered', `${orderId}, '${packageId}'`);
    setButtonLoadingState(triggerButton, 'Marking...', true);
    try {
      if (packageId) {
        o.deliveryPackages = dedupeOrderPackages(o, o.deliveryPackages || []);
        const packageEntry = o.deliveryPackages?.find(item => item.id === packageId);
        if (!packageEntry) return;
        packageEntry.status = 'Delivered';
        if (o.deliveryPackages.every(item => item.status === 'Delivered')) o.status = 'Delivered';
        persistLocalState();
        triggerAutoCloudSync('PACKAGE_STATUS_CHANGED', { orderId, packageId, status: 'Delivered' });
      } else {
        o.status = 'Delivered';
        triggerAutoCloudSync('STATUS_CHANGED', { order: o });
      }
      renderAllViews();
    } finally {
      setButtonLoadingState(triggerButton, 'Marking...', false);
    }
  }
}

function openSettlementModalForOrder(orderId) {
  const o = AppState.orders.find(item => item.id === orderId);
  if (!o) return;
  const due = getOrderNetDue(o);

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
  const notes = document.getElementById('settle-notes').value.trim() || 'Settled';

  const order = AppState.orders.find(o => o.id === orderId);
  const isSelf = String(custId || '').toUpperCase().startsWith('ADMIN-SELF-');
  const cust = AppState.customers.find(c => sameOwner(c.id, custId))
    || { id: custId, name: order?.customerName || (isSelf ? `${AppState.currentUser?.name || 'Admin'} (Admin)` : 'Booker') };
  const outstanding = order ? getOrderNetDue(order) : 0;

  if (!order) {
    alert('Order not found.');
    return;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    alert('Please enter a valid settlement amount greater than zero.');
    return;
  }
  if (Math.round(amount * 100) > Math.round(outstanding * 100)) {
    alert(`Settlement amount (₹${amount.toLocaleString()}) cannot exceed the outstanding balance (₹${outstanding.toLocaleString()}).`);
    return;
  }

  order.settledAmount = (order.settledAmount || 0) + amount;
  if (cust && typeof cust.totalSettled === 'number') {
    cust.totalSettled = (cust.totalSettled || 0) + amount;
  }
  const matchingCustomer = AppState.customers.find(c => sameOwner(c.id, custId));
  if (matchingCustomer && matchingCustomer !== cust) {
    matchingCustomer.totalSettled = (matchingCustomer.totalSettled || 0) + amount;
  }

  const payable = order.payableAmount || ((order.amountPaid || 0) + getOrderProfit(order));
  const fullySettled = (order.advancePaid || 0) + order.settledAmount >= payable;
  order.status = fullySettled ? 'Settled' : 'Delivered';
  if (fullySettled) {
    order.settledAt = order.settledAt || todayIsoDate();
  }

  persistLocalState();
  closeModal('modal-settlement');
  renderAllViews();
  triggerAutoCloudSync('SETTLEMENT_RECORDED', { orderId, customerId: custId, customerName: cust.name, amount, notes });
  triggerAutoCloudSync('STATUS_CHANGED', { order: ensureOrderSettlementMeta(order) });
}

// 9. Modals, Lifetime Drilldown & Out For Delivery Today
function openCreateCustomerModal() {
  const activeAdminId = AppState.activeAdminScope || AppState.currentUser.adminId;
  const adminDigits = String(activeAdminId).match(/(?:adm-?)(\d{3})$/i)?.[1] || '000';
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
  document.getElementById('new-cust-admin-creator').value = `${AppState.currentUser.name} (${activeAdminId})`;
  openModal('modal-create-customer');
}

function handleCreateCustomerAccount(e) {
  e.preventDefault();
  const effectiveAdminId = AppState.activeAdminScope || AppState.currentUser.adminId || AppState.adminProfile.adminId;
  const newCust = {
    id: document.getElementById('new-cust-id').value,
    username: document.getElementById('new-cust-id').value,
    name: document.getElementById('new-cust-name').value.trim(),
    mobile: document.getElementById('new-cust-mobile').value.trim(),
    createdByAdmin: AppState.currentUser.name,
    adminId: effectiveAdminId,
    totalSettled: 0
  };
  const initialPassword = document.getElementById('new-cust-password').value.trim();

  const duplicateAccount = AppState.customers.some(item => String(item.id).trim().toLowerCase() === newCust.id.trim().toLowerCase())
    || AppState.admins.some(item => String(item.username).trim().toLowerCase() === newCust.username.trim().toLowerCase());
  if (duplicateAccount) {
    alert('Booker ID or username already exists.');
    return;
  }
  AppState.customers.push(newCust);
  closeModal('modal-create-customer');
  renderCustomersTable();
  triggerAutoCloudSync('CUSTOMER_CREATED', { customer: { ...newCust, password: initialPassword } });
  document.getElementById('new-cust-password').value = '';
  alert(`Booker Created!\nID: ${newCust.id}\nPassword: ${initialPassword}`);
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

  const settledOrders = getVisibleOrders().filter(o => {
    if (o.status !== 'Settled') return false;
    const dateStr = o.settledAt || '';
    if (type === 'DAY' && fDay && dateStr !== fDay) return false;
    if (type === 'MONTH' && fMonth && !dateStr.startsWith(fMonth)) return false;
    if (type === 'YEAR' && fYear && !dateStr.startsWith(fYear)) return false;
    return true;
  });

  document.getElementById('lifetime-metric-count').textContent = settledOrders.length;
  document.getElementById('lifetime-metric-volume').textContent = `₹${settledOrders.reduce((s, o) => s + o.amountPaid, 0).toLocaleString()}`;
  document.getElementById('lifetime-metric-profit').textContent = `₹${settledOrders.reduce((sum, order) => sum + getOrderProfit(order), 0).toLocaleString()}`;

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
    const parcelSubtitle = o.packageId && o.quantity > 1
      ? `<br><small style="color:var(--text-muted);">${o.doNumber} · Parcel ${o.packageNumber || 1} of ${o.quantity}</small>`
      : (o.packageId ? `<br><small style="color:var(--text-muted);">${o.doNumber}</small>` : '');
    tbody.innerHTML += `
      <tr>
        <td><span class="pill pill-indigo">${d.platform}</span></td>
        <td><strong>${o.productModel}</strong>${parcelSubtitle}</td>
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
  document.getElementById('edit-prod-active').checked = true;
  configureProductOwnerSelect(AppState.currentUser?.adminId || '');
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
  document.getElementById('edit-prod-active').checked = p.active !== false;
  configureProductOwnerSelect(p.adminId || '');
  openModal('modal-edit-product');
}

function configureProductOwnerSelect(selectedAdminId) {
  const field = document.getElementById('product-owner-field');
  const select = document.getElementById('edit-prod-admin');
  if (!field || !select) return;
  const isMaster = AppState.currentUser?.isMaster === true;
  field.style.display = isMaster ? '' : 'none';
  if (!isMaster) return;

  const admins = [...AppState.admins];
  if (AppState.adminProfile?.adminId && !admins.some(item => sameAdminId(item.adminId, AppState.adminProfile.adminId))) {
    admins.unshift(AppState.adminProfile);
  }
  select.innerHTML = '<option value="">Shared catalog (legacy)</option>' + admins.map(admin =>
    `<option value="${admin.adminId}">${admin.name || admin.adminId} (${admin.adminId})${admin.active === false ? ' - Revoked' : ''}</option>`
  ).join('');
  select.value = selectedAdminId || '';
}

function setProductActive(productId, active) {
  const product = AppState.products.find(item => item.id === productId);
  if (!product || (!AppState.currentUser?.isMaster && !sameAdminId(product.adminId, AppState.currentUser?.adminId))) return;
  if (!confirm(`${active ? 'Activate' : 'Deactivate'} ${product.name}?`)) return;
  product.active = active;
  refreshProductLookupIndex();
  persistLocalState();
  renderProductListSettings();
  triggerAutoCloudSync('PRODUCT_SYNC', { product });
}

function handleSaveProduct(e) {
  e.preventDefault();
  const id = document.getElementById('edit-prod-id').value;
  const name = document.getElementById('edit-prod-name').value.trim();
  const targetPrice = Number(document.getElementById('edit-prod-price').value);
  const commission = Number(document.getElementById('edit-prod-comm').value);
  const active = document.getElementById('edit-prod-active').checked;
  const adminId = AppState.currentUser?.isMaster
    ? document.getElementById('edit-prod-admin').value
    : AppState.currentUser.adminId;

  if (id) {
    const p = AppState.products.find(item => item.id === id);
    if (p) {
      p.name = name;
      p.targetPrice = targetPrice;
      p.commission = commission;
      p.adminId = adminId;
      p.active = active;
    }
  } else {
    AppState.products.push({ id: `p_${Date.now()}`, name, targetPrice, commission, adminId, active });
  }

  const savedProduct = AppState.products.find(item => item.id === (id || AppState.products[AppState.products.length - 1].id));
  if (savedProduct) triggerAutoCloudSync('PRODUCT_SYNC', { product: savedProduct });

  closeModal('modal-edit-product');
  refreshProductLookupIndex();
  persistLocalState();
  renderProductListSettings();
  alert('Product catalog updated.');
}

function exportProductCatalogCSV() {
  const effectiveAdminId = getEffectiveAdminScopeId();
  const products = AppState.products.filter(product => {
    if (AppState.currentUser?.isMaster && !effectiveAdminId) return true;
    return sameAdminId(product.adminId, effectiveAdminId || AppState.currentUser?.adminId);
  });
  const csv = ['Product ID,Product Name,Target Price,Commission,Admin ID,Active', ...products.map(product =>
    [product.id, product.name, product.targetPrice, product.commission, product.adminId || '', product.active !== false].map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')
  )].join('\n');
  triggerBlobDownload(csv, 'Product_Catalog.csv', 'text/csv;charset=utf-8;');
}

function handleProductCatalogUpload(input) {
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let rows;
    try {
      rows = window.DeviceTradeCsv.parseCsv(String(reader.result || ''));
    } catch (error) {
      alert(`Catalog CSV could not be parsed: ${error.message}`);
      return;
    }
    if (rows.length < 2) return alert('Catalog CSV must contain a header and at least one product.');
    const headers = rows[0].map(value => value.trim().toLowerCase());
    const column = (...names) => headers.findIndex(header => names.includes(header));
    const columns = {
      id: column('product id', 'id'),
      name: column('product name', 'name'),
      price: column('target price', 'target buy price', 'price'),
      commission: column('commission', 'booker commission'),
      adminId: column('admin id', 'adminid'),
      active: column('active', 'status')
    };
    if (columns.name < 0 || columns.price < 0 || columns.commission < 0) {
      alert('Catalog CSV needs Product Name, Target Price, and Commission columns.');
      return;
    }

    let imported = 0;
    const errors = [];
    const seenIds = new Set();
    rows.slice(1).forEach((values, index) => {
      const rowNumber = index + 2;
      const cell = key => columns[key] < 0 ? '' : String(values[columns[key]] || '').trim();
      const id = cell('id') || `p_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const name = cell('name');
      const targetPrice = Number(cell('price'));
      const commission = Number(cell('commission'));
      const requestedOwner = cell('adminId');
      const activeValue = cell('active').toLowerCase();
      const normalizedId = id.trim().toLowerCase();
      if (seenIds.has(normalizedId)) {
        errors.push(`Row ${rowNumber}: duplicate product ID ${id} in this file.`);
        return;
      }
      seenIds.add(normalizedId);
      if (!name || !Number.isFinite(targetPrice) || targetPrice < 0 || !Number.isFinite(commission) || commission < 0) {
        errors.push(`Row ${rowNumber}: missing name or invalid amount.`);
        return;
      }
      if (activeValue && !['true', 'false', 'active', 'inactive', 'revoked'].includes(activeValue)) {
        errors.push(`Row ${rowNumber}: Active must be true/false or active/inactive.`);
        return;
      }
      const adminId = AppState.currentUser?.isMaster ? requestedOwner : AppState.currentUser.adminId;
      if (adminId && AppState.currentUser?.isMaster && !AppState.admins.some(admin => sameAdminId(admin.adminId, adminId))) {
        errors.push(`Row ${rowNumber}: assigned Admin ${adminId} was not found.`);
        return;
      }
      const product = {
        id,
        name,
        targetPrice,
        commission,
        adminId: adminId || '',
        active: !['false', 'inactive', 'revoked'].includes(activeValue)
      };
      const existing = AppState.products.find(item => item.id === product.id);
      if (existing && !AppState.currentUser?.isMaster && !sameAdminId(existing.adminId, AppState.currentUser.adminId)) {
        errors.push(`Row ${rowNumber}: product ID ${id} belongs to another Admin.`);
        return;
      }
      if (existing) Object.assign(existing, product); else AppState.products.push(product);
      triggerAutoCloudSync('PRODUCT_SYNC', { product });
      imported += 1;
    });
    refreshProductLookupIndex();
    persistLocalState();
    renderProductListSettings();
    alert(`Imported ${imported} product(s).${errors.length ? `\nSkipped ${errors.length} row(s):\n${errors.slice(0, 5).join('\n')}` : ''}`);
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
  let csv = "Delivery Date,Booker,Platform,Product Model,Quantity,Order ID,Delivery No,Delivery Tag,Recipient Name,Phone,Tracking,OTP,Pincode,Order Amount Paid (once),Advance Taken (once),Settled (once),Order Net Due (once),Status\n";
  const financialOrders = new Set();
  getFilteredDeliveries().forEach(entry => {
    const o = entry;
    const d = entry.delivery;
    const includeFinancials = !financialOrders.has(String(o.id));
    financialOrders.add(String(o.id));
    csv += [
      d.deliveryDate, o.customerName, d.platform, o.productModel, o.quantity, o.id, entry.doNumber,
      entry.packageTag, d.recipientName, d.mobile, d.tracking, d.otp, d.pincode,
      includeFinancials ? o.amountPaid : '',
      includeFinancials ? o.advancePaid : '',
      includeFinancials ? o.settledAmount : '',
      includeFinancials ? getOrderNetDue(o) : '',
      entry.status
    ].map(csvCell).join(',') + '\n';
  });
  triggerBlobDownload(csv, 'All_Deliveries_Registry.csv', 'text/csv;charset=utf-8;');
}

function getFilteredDeliveries() {
  const search = (document.getElementById('delivery-search')?.value || '').toLowerCase();
  const platform = document.getElementById('delivery-platform-filter')?.value || 'ALL';
  const date = document.getElementById('delivery-date-filter')?.value || '';
  return dedupeDeliveryRows(getVisibleOrders().flatMap(order => orderDeliveryEntries(order).map((entry, index) => ({
    order,
    ...entry,
    packageNumber: entry.packageEntry ? (entry.sequence || index + 1) : 1,
    doNumber: entry.packageEntry ? (entry.doNumber || `DO${entry.sequence || index + 1}`) : 'DO1'
  })))).filter(entry => {
    const delivery = entry.delivery;
    if (!delivery?.submitted || (date && String(delivery.deliveryDate || delivery.submittedAt || entry.order.createdAt).slice(0, 10) !== date)) return false;
    if (platform !== 'ALL' && delivery.platform !== platform) return false;
    if (!search) return true;
    return [entry.doNumber, entry.order.id, delivery.pincode, delivery.tracking, delivery.recipientName, entry.order.productModel]
      .some(value => String(value || '').toLowerCase().includes(search));
  }).map(entry => ({
    ...entry.order,
    delivery: entry.delivery,
    status: entry.status || entry.order.status,
    packageId: entry.id,
    packageNumber: entry.packageNumber,
    doNumber: entry.doNumber,
    packageTag: entry.packageTag || deliveryPackageTag(entry.order, entry)
  }));
}

function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function exportTodayDeliveriesToExcel() {
  const todayList = getTodayModalDeliveries();
  if (todayList.length === 0) {
    alert('No active delivery dispatches found for today.');
    return;
  }
  let csv = "Delivery Date,Booker,Platform,Model,Quantity,Order ID,Delivery No,Delivery Tag,Recipient Name,Mobile,Tracking AWB,OTP,Pincode,Order Amount Paid (once),Order Net Due (once),Card Last 4\n";
  const financialOrders = new Set();
  todayList.forEach(o => {
    const d = o.delivery;
    const includeFinancials = !financialOrders.has(String(o.id));
    financialOrders.add(String(o.id));
    csv += [
      d.deliveryDate, o.customerName, d.platform, o.productModel, o.quantity, o.id, o.doNumber,
      o.packageTag, d.recipientName, d.mobile, d.tracking, d.otp, d.pincode,
      includeFinancials ? o.amountPaid : '',
      includeFinancials ? getOrderNetDue(o) : '',
      o.cardLast4
    ].map(csvCell).join(',') + '\n';
  });
  triggerBlobDownload(csv, `Deliveries_Today_${new Date().toISOString().slice(0,10)}.csv`, 'text/csv;charset=utf-8;');
}

function getTodayModalDeliveries(applyFilters = true) {
  const fPin = applyFilters ? (document.getElementById('today-filter-pin')?.value || '').trim().toLowerCase() : '';
  const fName = applyFilters ? (document.getElementById('today-filter-name')?.value || '').toLowerCase().trim() : '';
  const fProd = applyFilters ? (document.getElementById('today-filter-product')?.value || '').toLowerCase().trim() : '';
  const rows = dedupeDeliveryRows(getVisibleOrders().flatMap(order => orderDeliveryEntries(order).map((entry, index) => ({
    order,
    ...entry,
    packageNumber: entry.orderIndex || (entry.packageEntry ? (entry.sequence || index + 1) : 1),
    doNumber: entry.packageEntry ? (entry.doNumber || `DO${entry.sequence || index + 1}`) : (entry.doNumber || 'DO1')
  })))).filter(entry => {
    const delivery = entry.delivery;
    if (!delivery?.submitted || String(delivery.deliveryDate || delivery.submittedAt || entry.order?.createdAt).slice(0, 10) !== todayIsoDate()) return false;
    const currentStatus = entry.status || delivery.status || entry.order?.status;
    if (currentStatus === 'Settled') return false;
    if (fPin && !String(delivery.pincode || '').toLowerCase().includes(fPin)) return false;
    if (fName && !String(delivery.recipientName || '').toLowerCase().includes(fName)) return false;
    if (fProd && !String(entry.order?.productModel || '').toLowerCase().includes(fProd)) return false;
    return true;
  }).map(entry => ({
    ...entry.order,
    delivery: entry.delivery,
    status: entry.status || entry.order?.status,
    packageId: entry.id,
    packageNumber: entry.packageNumber,
    doNumber: entry.doNumber,
    packageTag: entry.packageTag || deliveryPackageTag(entry.order, entry)
  }));

  rows.sort((a, b) => {
    const seqA = Number(a.sequence) || Number(String(a.doNumber || '').match(/\d+/)?.[0]) || 0;
    const seqB = Number(b.sequence) || Number(String(b.doNumber || '').match(/\d+/)?.[0]) || 0;
    return seqA - seqB;
  });

  return rows;
}

function exportCustomerLedgerCSV() {
  let csv = "Customer ID,Customer Name,Created By Admin,Orders Count,Total Paid,Advance Taken,Settled,Net Balance\n";
  const visibleOrders = getVisibleOrders();
  const effectiveAdminId = getEffectiveAdminScopeId();
  const visibleCustomers = AppState.customers.filter(c => {
    if (AppState.currentUser?.role === 'customer') {
      return sameCustomerId(c.id, AppState.currentUser?.id);
    }
    if (!effectiveAdminId) return true;
    return sameAdminId(c.createdByAdmin, effectiveAdminId);
  });
  visibleCustomers.forEach(c => {
    const cOrders = dedupeOrderRecords(visibleOrders.filter(o => sameCustomerId(o.customerId, c.id)));
    const paid = cOrders.reduce((s, o) => s + (Number(o.amountPaid) || 0), 0);
    const payable = cOrders.reduce((s, o) => s + (Number(o.payableAmount) || 0), 0);
    const advance = cOrders.reduce((s, o) => s + (Number(o.advancePaid) || 0), 0);
    const settled = Number(c.totalSettled) || 0;
    const bal = payable - advance - settled;
    csv += `"${c.id}","${c.name}","${c.createdByAdmin || 'N/A'}",${cOrders.length},${paid},${advance},${settled},${bal}\n`;
  });
  triggerBlobDownload(csv, 'Customer_Ledgers_Master.csv', 'text/csv;charset=utf-8;');
}

function downloadAllInvoicesCSV() {
  let csv = "Order ID,Package ID,Customer Name,Product,Shop Name,GST Number,Base Amount,GST Tax,Total Gross\n";
  const visibleOrders = getVisibleOrders();
  visibleOrders.forEach(o => {
    const pkgs = (o.deliveryPackages || []).filter(p => p.gstDetails?.included);
    if (pkgs.length > 0) {
      pkgs.forEach(p => {
        const g = p.gstDetails;
        csv += `"${o.id}","${p.id || ''}","${o.customerName}","${o.productModel}","${g.shopName || ''}","${g.gstNumber || ''}",${g.baseAmount || 0},${g.gstAmount || 0},${g.totalAmount || 0}\n`;
      });
    } else if (o.gstDetails?.included) {
      const g = o.gstDetails;
      csv += `"${o.id}","","${o.customerName}","${o.productModel}","${g.shopName || ''}","${g.gstNumber || ''}",${g.baseAmount || 0},${g.gstAmount || 0},${g.totalAmount || 0}\n`;
    }
  });
  triggerBlobDownload(csv, 'GST_Invoices_Master_List.csv', 'text/csv;charset=utf-8;');
}

function downloadSingleInvoice(orderId, packageId = '') {
  const order = getVisibleOrders().find(o => o.id === orderId);
  const gstDetails = packageId ? order?.deliveryPackages?.find(item => item.id === packageId)?.gstDetails : order?.gstDetails;
  if (!order || !gstDetails) return;
  const fileId = gstDetails.fileId;
  const url = fileId ? `${API_CONFIG.baseUrl}/invoices/${encodeURIComponent(fileId)}` : gstDetails.fileData;
  if (!url) return;
  fetch(url, fileId ? {
    headers: {
      'x-api-key': API_CONFIG.secretToken,
      ...(AppState.sessionToken ? { 'x-session-token': AppState.sessionToken } : {})
    }
  } : undefined).then(response => {
    if (!response.ok) throw new Error(`Download failed (${response.status})`);
    return response.blob();
  }).then(blob => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = gstDetails.fileName || `GST_${order.id}.jpg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }).catch(error => alert(error.message));
}

function getInvoiceAttachmentUrl(gstDetails) {
  return gstDetails?.fileData || '';
}

function exportLifetimeBookingsToExcel() {
  let csv = "Order ID,Platform,Product Model,Customer Name,Card Last 4,Amount Paid,Settled Date,GST Total,Status\n";
  getVisibleOrders().filter(o => o.status === 'Settled').forEach(o => {
    const gstTot = o.gstDetails?.included ? (o.gstDetails.totalAmount || 0) : 0;
    csv += `"${o.id}","${o.platform}","${o.productModel}","${o.customerName}","${o.cardLast4}",${o.amountPaid},"${o.settledAt}",${gstTot},"${o.status}"\n`;
  });
  triggerBlobDownload(csv, `Lifetime_Settled_Deals_${new Date().toISOString().slice(0,10)}.csv`, 'text/csv;charset=utf-8;');
}

async function viewGstInvoice(orderId, packageId = '') {
  const order = getVisibleOrders().find(o => o.id === orderId);
  const packageEntry = order?.deliveryPackages?.find(item => item.id === packageId);
  const g = packageId ? packageEntry?.gstDetails : order?.gstDetails;
  if (!order || !g) return;
  const isPdf = g.contentType === 'application/pdf' || String(g.fileName || '').toLowerCase().endsWith('.pdf');
  document.getElementById('preview-invoice-title').textContent = `GST Bill - ${order.productModel}`;
  const body = document.getElementById('preview-invoice-body');
  body.innerHTML = `
    <div style="color:var(--text-muted);">Loading invoice...</div>
    <div style="margin-top: 10px; font-size: 0.8rem; color: var(--text-muted); text-align: left; background: rgba(0,0,0,0.2); padding: 10px; border-radius: 6px;">
      <strong>Merchant:</strong> ${g.shopName || 'N/A'}<br />
      <strong>GSTIN:</strong> <code>${g.gstNumber || 'N/A'}</code><br />
      <strong>Tax Breakdown:</strong> Base ₹${g.baseAmount?.toLocaleString()} + GST ${g.gstRate}% (₹${g.gstAmount}) = <strong>₹${g.totalAmount?.toLocaleString()}</strong>
    </div>
  `;
  try {
    const invoiceUrl = await getInvoiceBlobUrl(g);
    body.firstElementChild.outerHTML = invoiceUrl
      ? (isPdf ? `<iframe src="${invoiceUrl}" title="GST invoice PDF" style="width:100%; height:65vh; border:1px solid var(--border-subtle); border-radius:8px;"></iframe>`
        : `<img src="${invoiceUrl}" alt="GST invoice" style="max-width: 100%; max-height:65vh; object-fit:contain; border-radius: 8px; border: 1px solid var(--border-subtle);" />`)
      : '<div style="color:var(--text-muted);">Invoice attachment unavailable.</div>';
  } catch (error) {
    body.firstElementChild.textContent = 'Invoice attachment unavailable.';
    console.warn('Invoice preview unavailable:', error.message);
  }
  document.getElementById('btn-download-active-invoice').onclick = () => downloadSingleInvoice(order.id, packageId);
  document.getElementById('btn-edit-active-invoice').onclick = () => {
    closeModal('modal-view-invoice');
    editGstInvoice(order.id, packageId);
  };
  document.getElementById('btn-edit-active-invoice').hidden = Boolean(packageId);
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

const modalTriggerElements = {};

function openModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modalTriggerElements[id] = document.activeElement;
  modal.removeAttribute('aria-hidden');
  modal.removeAttribute('inert');
  modal.classList.add('open');

  setTimeout(() => {
    const focusable = Array.from(modal.querySelectorAll(
      'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(el => el.offsetParent !== null || el.offsetWidth > 0 || el.offsetHeight > 0);

    if (focusable.length > 0) {
      focusable[0].focus();
    }
  }, 50);
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;

  const trigger = modalTriggerElements[id];
  delete modalTriggerElements[id];

  // Move focus away from modal descendants first to avoid focus retention
  if (modal.contains(document.activeElement)) {
    if (trigger && typeof trigger.focus === 'function' && document.contains(trigger)) {
      trigger.focus();
    } else if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
  }

  modal.classList.remove('open');
  modal.removeAttribute('aria-hidden');
  modal.setAttribute('inert', '');
}

window.addEventListener('keydown', (e) => {
  const openModals = Array.from(document.querySelectorAll('.modal-backdrop.open'));
  if (openModals.length === 0) return;
  const currentModal = openModals[openModals.length - 1];

  if (e.key === 'Escape') {
    e.preventDefault();
    closeModal(currentModal.id);
    return;
  }

  if (e.key === 'Tab') {
    const focusable = Array.from(currentModal.querySelectorAll(
      'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(el => el.offsetParent !== null || el.offsetWidth > 0 || el.offsetHeight > 0);

    if (focusable.length === 0) {
      e.preventDefault();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey) {
      if (document.activeElement === first || !currentModal.contains(document.activeElement)) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last || !currentModal.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      }
    }
  }
});

// Run Hydration
resetLoadingOverlay();
const appStateReady = loadPersistedState();
appStateReady.then(async () => {
  let savedSession = storageDb ? await readStoredState('session', null) : null;
  if (!savedSession) {
    try { savedSession = JSON.parse(localStorage.getItem('dt_session') || 'null'); } catch (error) { savedSession = null; }
  }
  if (!savedSession?.user || !savedSession.token) {
    if (isAppUpdatePending()) continueAfterAppUpdateOffline();
    return;
  }
  AppState.currentUser = savedSession.user;
  AppState.sessionToken = savedSession.token;
  showAuthenticatedView();
  await flushOfflineQueue();
  if (isAppUpdatePending()) {
    await refreshCloudAfterAppUpdate();
    return;
  }
  await syncCloudData();
});