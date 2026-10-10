const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequireSession, isMasterAdminIdAlias, isMasterAdminSession } = require('../account-access');

function invokeGuard({ session, account, accountError, masterAdminId = '' }) {
  const response = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
  let nextCalled = false;
  const guard = createRequireSession({
    getSession: () => session,
    masterAdminId,
    getAccountState: async () => {
      if (accountError) throw accountError;
      return account;
    }
  });

  return guard({}, response, () => { nextCalled = true; }).then(() => ({ response, nextCalled }));
}

test('rejects requests without a session', async () => {
  const { response, nextCalled } = await invokeGuard({ session: null });
  assert.equal(response.statusCode, 401);
  assert.equal(nextCalled, false);
});

test('allows active account sessions with the current version', async () => {
  const { response, nextCalled } = await invokeGuard({
    session: { user: { role: 'admin', adminId: 'adm-001', sessionVersion: 3 } },
    account: { exists: true, active: true, sessionVersion: 3 }
  });
  assert.equal(response.statusCode, 200);
  assert.equal(nextCalled, true);
});

test('rejects revoked accounts and sessions from before reactivation', async () => {
  const revoked = await invokeGuard({
    session: { user: { role: 'customer', customerId: 'booker-1', sessionVersion: 0 } },
    account: { exists: true, active: false, sessionVersion: 1 }
  });
  assert.equal(revoked.response.statusCode, 401);
  assert.equal(revoked.nextCalled, false);

  const stale = await invokeGuard({
    session: { user: { role: 'admin', adminId: 'adm-001', sessionVersion: 0 } },
    account: { exists: true, active: true, sessionVersion: 1 }
  });
  assert.equal(stale.response.statusCode, 401);
  assert.equal(stale.nextCalled, false);
});

test('rejects deleted accounts and fails closed when status cannot be checked', async () => {
  const deleted = await invokeGuard({
    session: { user: { role: 'customer', customerId: 'booker-1', sessionVersion: 0 } },
    account: { exists: false }
  });
  assert.equal(deleted.response.statusCode, 401);
  assert.equal(deleted.nextCalled, false);

  const unavailable = await invokeGuard({
    session: { user: { role: 'admin', adminId: 'adm-001', sessionVersion: 0 } },
    accountError: new Error('storage unavailable')
  });
  assert.equal(unavailable.response.statusCode, 503);
  assert.equal(unavailable.nextCalled, false);
});

test('allows the configured master session without a subordinate account lookup', async () => {
  const guard = createRequireSession({
    getSession: () => ({ user: { role: 'admin', isMaster: true } }),
    getAccountState: async () => { throw new Error('must not load account'); }
  });
  let nextCalled = false;
  const response = { status() { return this; }, json() { return this; } };
  await guard({}, response, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('identifies only the signed Master Admin session with the configured owner ID', () => {
  assert.equal(isMasterAdminSession({ role: 'admin', isMaster: true, adminId: 'ADM-001' }, 'adm001'), true);
  assert.equal(isMasterAdminSession({ role: 'admin', isMaster: false, adminId: 'adm001' }, 'adm001'), false);
  assert.equal(isMasterAdminSession({ role: 'admin', isMaster: true, adminId: 'adm002' }, 'adm001'), false);
});

test('rejects a non-Master account that aliases the configured Master ID', async () => {
  assert.equal(isMasterAdminIdAlias({ role: 'admin', isMaster: false, adminId: 'ADM-001' }, 'adm001'), true);
  const { response, nextCalled } = await invokeGuard({
    session: { user: { role: 'admin', isMaster: false, adminId: 'ADM-001', sessionVersion: 0 } },
    account: { exists: true, active: true, sessionVersion: 0 },
    masterAdminId: 'adm001'
  });
  assert.equal(response.statusCode, 401);
  assert.equal(nextCalled, false);
});