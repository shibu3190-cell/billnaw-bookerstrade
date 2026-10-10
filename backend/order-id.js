function generateOrderId(value = '', prefix = 'OD', existingIds = []) {
  const trimmed = String(value || '').trim();
  if (trimmed && !existingIds.includes(trimmed)) return trimmed;
  const base = trimmed || prefix;
  const suffix = Date.now().toString().slice(-6);
  const random = Math.floor(Math.random() * 1000);
  let candidate = `${base}${suffix}${random}`;

  if (trimmed && !existingIds.includes(candidate)) return candidate;
  while (existingIds.includes(candidate)) {
    candidate = `${base}${Date.now()}${Math.floor(Math.random() * 1000)}`;
  }
  return candidate;
}

module.exports = { generateOrderId };
