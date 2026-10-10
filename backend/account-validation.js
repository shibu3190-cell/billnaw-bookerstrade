function normalizeAccountValue(value) {
  return String(value || '').trim().toLowerCase();
}

function findAccountConflict(candidate, accounts = []) {
  const candidateId = normalizeAccountValue(candidate.id);
  const candidateUsername = normalizeAccountValue(candidate.username);
  const excludedId = normalizeAccountValue(candidate.excludeId);

  for (const account of accounts) {
    const accountId = normalizeAccountValue(account.id);
    if (excludedId && accountId === excludedId) continue;
    if (candidateId && accountId === candidateId) return { field: 'id', account };
    if (candidateUsername && normalizeAccountValue(account.username) === candidateUsername) return { field: 'username', account };
  }

  return null;
}

module.exports = { findAccountConflict, normalizeAccountValue };