function generateOrderId(value = '', prefix = 'OD', existingIds = []) {
  const trimmed = String(value || '').trim();
  if (trimmed && !existingIds.includes(trimmed)) return trimmed;

  const safePrefix = String(trimmed || prefix || 'OD').replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase() || 'OD';
  const suffix = String(Date.now()).slice(-6);
  let candidate = `${safePrefix}${suffix}`.slice(0, 12);

  if (!existingIds.includes(candidate)) return candidate;

  let fallback = 0;
  while (fallback < 25) {
    const nextSuffix = `${String(Date.now()).slice(-6)}${String(Math.floor(Math.random() * 900) + 100)}`.slice(0, 12 - safePrefix.length);
    candidate = `${safePrefix}${nextSuffix}`.slice(0, 12);
    if (!existingIds.includes(candidate)) return candidate;
    fallback += 1;
  }

  return `${safePrefix}${suffix}`.slice(0, 12);
}

module.exports = { generateOrderId };
