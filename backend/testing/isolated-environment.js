const { Readable } = require('node:stream');

const credentials = Object.freeze({
  apiToken: 'local-isolated-test-token',
  master: Object.freeze({ id: 'test-master-01', username: 'test-master', password: 'test-master-password' }),
  admin: Object.freeze({ id: 'test-admin-01', username: 'test-admin', password: 'test-admin-password' }),
  secondAdmin: Object.freeze({ id: 'test-admin-02', username: 'test-admin-2', password: 'test-admin-2-password' }),
  booker: Object.freeze({ id: 'test-booker-01', username: 'test-booker', password: 'test-booker-password' })
});

const serviceAccount = Object.freeze({
  project_id: 'device-trade-isolated-test',
  client_email: 'isolated-test@example.invalid',
  private_key: 'isolated-test-signing-key'
});

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function createFirestore() {
  const collections = new Map();
  const seed = {
    admins: [
      { adminId: credentials.admin.id, name: 'Test Admin', username: credentials.admin.username, password: credentials.admin.password, active: true, sessionVersion: 0 },
      { adminId: credentials.secondAdmin.id, name: 'Test Admin Two', username: credentials.secondAdmin.username, password: credentials.secondAdmin.password, active: true, sessionVersion: 0 }
    ],
    customers: [{ id: credentials.booker.id, username: credentials.booker.username, name: 'Test Booker', password: credentials.booker.password, mobile: '0000000000', adminId: credentials.admin.id, active: true, sessionVersion: 0, totalSettled: 0 }],
    products: [{ id: 'test-product-01', name: 'Test Phone Pro', targetPrice: 1000, commission: 100, adminId: credentials.admin.id, active: true }],
    orders: [],
    invoiceFiles: []
  };

  for (const [name, records] of Object.entries(seed)) {
    collections.set(name, new Map(records.map(record => {
      const id = name === 'admins' ? record.adminId : record.id;
      return [String(id), clone(record)];
    })));
  }

  class DocumentSnapshot {
    constructor(ref, value) {
      this.ref = ref;
      this.id = ref.id;
      this.exists = value !== undefined;
      this._value = value;
    }
    data() { return clone(this._value); }
  }

  class QuerySnapshot {
    constructor(docs) {
      this.docs = docs;
      this.size = docs.length;
      this.empty = docs.length === 0;
    }
  }

  class DocumentReference {
    constructor(collectionName, id) {
      this.collectionName = collectionName;
      this.id = String(id);
    }
    get map() {
      if (!collections.has(this.collectionName)) collections.set(this.collectionName, new Map());
      return collections.get(this.collectionName);
    }
    async get() { return new DocumentSnapshot(this, this.map.get(this.id)); }
    async set(value, options = {}) {
      const saved = options.merge ? { ...(this.map.get(this.id) || {}), ...clone(value) } : clone(value);
      this.map.set(this.id, saved);
    }
    async create(value) {
      if (this.map.has(this.id)) {
        const error = new Error('Document already exists.');
        error.code = 6;
        throw error;
      }
      this.map.set(this.id, clone(value));
    }
    async update(value) {
      if (!this.map.has(this.id)) {
        const error = new Error('Document does not exist.');
        error.code = 5;
        throw error;
      }
      this.map.set(this.id, { ...this.map.get(this.id), ...clone(value) });
    }
    async delete() { this.map.delete(this.id); }
  }

  class Query {
    constructor(collectionName, filters = [], maxResults = Infinity, sortField = '') {
      this.collectionName = collectionName;
      this.filters = filters;
      this.maxResults = maxResults;
      this.sortField = sortField;
    }
    where(field, operator, value) {
      if (operator !== '==') throw new Error(`Isolated test adapter does not support ${operator}.`);
      return new Query(this.collectionName, [...this.filters, [field, value]], this.maxResults, this.sortField);
    }
    limit(value) { return new Query(this.collectionName, this.filters, value, this.sortField); }
    orderBy(field) { return new Query(this.collectionName, this.filters, this.maxResults, field); }
    async get() {
      const values = [...(collections.get(this.collectionName) || new Map()).entries()]
        .filter(([, record]) => this.filters.every(([field, value]) => record[field] === value));
      if (this.sortField) values.sort((left, right) => Number(left[1][this.sortField] || 0) - Number(right[1][this.sortField] || 0));
      const docs = values.slice(0, this.maxResults).map(([id, value]) => new DocumentSnapshot(new DocumentReference(this.collectionName, id), value));
      return new QuerySnapshot(docs);
    }
  }

  class CollectionReference extends Query {
    constructor(collectionName) { super(collectionName); }
    doc(id) { return new DocumentReference(this.collectionName, id); }
  }

  return {
    collection(name) { return new CollectionReference(name); },
    batch() {
      const refs = [];
      return {
        delete(ref) { refs.push(ref); },
        async commit() { await Promise.all(refs.map(ref => ref.delete())); }
      };
    },
    async runTransaction(callback) {
      const updates = [];
      const result = await callback({
        get: ref => ref.get(),
        update: (ref, value) => updates.push([ref, value])
      });
      for (const [ref, value] of updates) await ref.update(value);
      return result;
    },
    async listCollections() { return [...collections.keys()].map(id => ({ id })); }
  };
}

function columnIndex(letters) {
  return [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function parseRange(range) {
  const separator = range.indexOf('!');
  const sheetName = range.slice(0, separator);
  const cells = range.slice(separator + 1);
  const match = /^([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/i.exec(cells);
  if (!match) throw new Error(`Unsupported isolated Sheets range: ${range}`);
  return {
    sheetName,
    startColumn: columnIndex(match[1].toUpperCase()),
    startRow: Math.max(0, Number(match[2] || 1) - 1),
    endColumn: match[3] ? columnIndex(match[3].toUpperCase()) : columnIndex(match[1].toUpperCase()),
    endRow: match[4] ? Number(match[4]) : Infinity
  };
}

function createSheets() {
  const tables = new Map([
    ['Admins', [
      ['Admin ID', 'Admin Name', 'Username', 'Password', 'Active', 'Last Synced', 'Session Version'],
      [credentials.admin.id, 'Test Admin', credentials.admin.username, credentials.admin.password, true, '', 0],
      [credentials.secondAdmin.id, 'Test Admin Two', credentials.secondAdmin.username, credentials.secondAdmin.password, true, '', 0]
    ]],
    ['Customers', [
      ['Customer ID', 'Full Name', 'Mobile', 'Password', 'Created By Admin', 'Admin ID', 'Active', 'Timestamp', 'Session Version'],
      [credentials.booker.id, 'Test Booker', '0000000000', credentials.booker.password, 'Test Admin', credentials.admin.id, true, '', 0]
    ]],
    ['Products', [
      ['Product ID', 'Product Name', 'Target Price', 'Commission', 'Admin ID', 'Active', 'Last Synced'],
      ['test-product-01', 'Test Phone Pro', 1000, 100, credentials.admin.id, true, '']
    ]],
    ['Orders', [[
      'Order ID', 'Platform', 'Product Model', 'Quantity', 'Customer Name', 'Customer ID', 'Card Last 4',
      'Amount Paid', 'Payable Due', 'Advance Paid', 'Status', 'Date', 'Admin ID', 'Product ID'
    ]]],
    ['Delivery_Packages', [['Package ID', 'Order ID']]],
    ['Settlements', [['Order ID', 'Customer ID', 'Customer Name', 'Settled Amount', 'Payment Note', 'Timestamp']]]
  ]);

  return {
    spreadsheets: {
      async get() {
        return { data: { sheets: [...tables.keys()].map((title, index) => ({ properties: { title, sheetId: index + 1 } })) } };
      },
      async batchUpdate({ resource }) {
        for (const request of resource.requests || []) {
          if (request.addSheet) tables.set(request.addSheet.properties.title, []);
          if (request.deleteDimension) {
            const sheet = [...tables.keys()].find(name => [...tables.keys()].indexOf(name) + 1 === request.deleteDimension.range.sheetId);
            const rows = tables.get(sheet) || [];
            rows.splice(request.deleteDimension.range.startIndex, request.deleteDimension.range.endIndex - request.deleteDimension.range.startIndex);
          }
        }
        return { data: {} };
      },
      values: {
        async get({ range }) {
          const bounds = parseRange(range);
          const rows = tables.get(bounds.sheetName) || [];
          const selected = rows.slice(bounds.startRow, bounds.endRow).map(row => row.slice(bounds.startColumn, bounds.endColumn + 1));
          return { data: { values: selected } };
        },
        async update({ range, resource }) {
          const bounds = parseRange(range);
          if (!tables.has(bounds.sheetName)) tables.set(bounds.sheetName, []);
          const rows = tables.get(bounds.sheetName);
          (resource.values || []).forEach((values, rowOffset) => {
            const rowIndex = bounds.startRow + rowOffset;
            while (rows.length <= rowIndex) rows.push([]);
            values.forEach((value, columnOffset) => { rows[rowIndex][bounds.startColumn + columnOffset] = value; });
          });
          return { data: {} };
        },
        async append({ range, resource }) {
          const bounds = parseRange(range);
          if (!tables.has(bounds.sheetName)) tables.set(bounds.sheetName, []);
          const rows = tables.get(bounds.sheetName);
          (resource.values || []).forEach(values => {
            const row = [];
            values.forEach((value, columnOffset) => { row[bounds.startColumn + columnOffset] = value; });
            rows.push(row);
          });
          return { data: { updates: { updatedRows: (resource.values || []).length } } };
        }
      }
    }
  };
}

function createStorageBucket() {
  const files = new Map();
  return {
    async getMetadata() { return [{ name: 'isolated-test-bucket' }]; },
    file(path) {
      return {
        async save(contents) { files.set(path, Buffer.from(contents)); },
        async delete() { files.delete(path); },
        createReadStream() { return Readable.from(files.get(path) || Buffer.alloc(0)); }
      };
    }
  };
}

module.exports = {
  credentials,
  serviceAccount,
  sessionSecret: 'isolated-test-session-signing-key',
  db: createFirestore(),
  sheets: createSheets(),
  storageBucket: createStorageBucket()
};