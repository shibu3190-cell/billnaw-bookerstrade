function packageSequence(packageEntry) {
  return Number(packageEntry.sequence)
    || Number(String(packageEntry.doNumber || '').match(/^DO(\d+)$/i)?.[1])
    || 0;
}

function normalizeDayKey(value) {
  return String(value || '').slice(0, 10);
}

function buildDeliveryPackageTag({ customerId, deliveryDate, orderId, sequence, doNumber }) {
  const normalizedCustomer = String(customerId || '').trim() || 'shared';
  const normalizedDate = normalizeDayKey(deliveryDate || new Date().toISOString());
  const normalizedOrder = String(orderId || '').trim() || 'order';
  const resolvedSequence = Number(sequence) || Number(String(doNumber || '').match(/^DO(\d+)$/i)?.[1]) || 0;
  return `day-${normalizedDate}|booker-${normalizedCustomer}|order-${normalizedOrder}|do-${resolvedSequence}`;
}

function dedupeDeliveryPackages(packages, context = {}) {
  const seen = new Map();
  const seenIds = new Set();
  const seenTags = new Set();
  for (const packageEntry of Array.isArray(packages) ? packages : []) {
    const packageId = String(packageEntry.id || packageEntry.packageId || '').trim();
    const sequence = packageSequence(packageEntry);
    const tag = buildDeliveryPackageTag({
      customerId: packageEntry.customerId || packageEntry.delivery?.customerId || context.customerId,
      deliveryDate: packageEntry.delivery?.deliveryDate || packageEntry.delivery?.submittedAt || packageEntry.submittedAt,
      orderId: packageEntry.orderId || context.orderId || packageId,
      sequence,
      doNumber: packageEntry.doNumber
    });
    if ((packageId && seenIds.has(packageId)) || (sequence > 0 && seenTags.has(tag))) continue;
    if (packageId) seenIds.add(packageId);
    if (sequence > 0) seenTags.add(tag);
    const key = packageId || tag;
    if (!seen.has(key)) seen.set(key, { ...packageEntry, ...(sequence > 0 ? { packageTag: tag } : {}) });
  }
  return [...seen.values()];
}

function allocateDeliveryPackageIdentity(packages, packageId, quantity, context) {
  const currentPackages = dedupeDeliveryPackages(packages, context);
  const existingIndex = currentPackages.findIndex(packageEntry => packageEntry.id === packageId);

  if (existingIndex >= 0) {
    const existing = currentPackages[existingIndex];
    const highestOtherSequence = currentPackages.reduce((highest, packageEntry, index) =>
      index === existingIndex ? highest : Math.max(highest, packageSequence(packageEntry)), 0);
    const sequence = packageSequence(existing) || highestOtherSequence + 1;
    return { sequence, doNumber: existing.doNumber || `DO${sequence}`, existingIndex };
  }

  const packageLimit = Math.max(1, Math.floor(Number(quantity) || 1));
  if (currentPackages.length >= packageLimit) {
    const error = new Error('All packages for this order already have delivery details.');
    error.status = 409;
    throw error;
  }

  const sequence = currentPackages.reduce((highest, packageEntry) => Math.max(highest, packageSequence(packageEntry)), 0) + 1;
  return { sequence, doNumber: `DO${sequence}`, existingIndex: -1 };
}

module.exports = { allocateDeliveryPackageIdentity, buildDeliveryPackageTag, dedupeDeliveryPackages };