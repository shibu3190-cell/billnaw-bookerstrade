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

function dedupeDeliveryPackages(packages) {
  const seen = new Map();
  for (const packageEntry of Array.isArray(packages) ? packages : []) {
    const key = buildDeliveryPackageTag({
      customerId: packageEntry.customerId || packageEntry.delivery?.customerId,
      deliveryDate: packageEntry.delivery?.deliveryDate || packageEntry.delivery?.submittedAt || packageEntry.submittedAt,
      orderId: packageEntry.orderId || packageEntry.id,
      sequence: packageEntry.sequence,
      doNumber: packageEntry.doNumber
    });
    if (!seen.has(key)) seen.set(key, packageEntry);
  }
  return [...seen.values()];
}

function allocateDeliveryPackageIdentity(packages, packageId, quantity) {
  const currentPackages = dedupeDeliveryPackages(packages);
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