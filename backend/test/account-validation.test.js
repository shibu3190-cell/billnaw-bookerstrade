const test = require('node:test');
const assert = require('node:assert/strict');
const { findAccountConflict, normalizeAccountValue } = require('../account-validation');

test('normalizes usernames and IDs without regard to casing or surrounding whitespace', () => {
  assert.equal(normalizeAccountValue(' Admin.User '), 'admin.user');
  assert.equal(findAccountConflict({ id: 'BOOKER-1' }, [{ id: ' booker-1 ' }]).field, 'id');
  assert.equal(findAccountConflict({ username: 'User.Name' }, [{ username: 'user.name' }]).field, 'username');
});

test('allows profile updates to exclude the account being edited', () => {
  assert.equal(findAccountConflict(
    { id: 'adm-1', excludeId: 'ADM-1', username: 'new-name' },
    [{ id: 'adm-1', username: 'old-name' }]
  ), null);
});

test('detects username conflicts across arbitrary account roles', () => {
  const conflict = findAccountConflict(
    { id: 'cust-2', username: 'team.login' },
    [{ id: 'adm-1', username: 'Team.Login', role: 'admin' }]
  );
  assert.equal(conflict.field, 'username');
});