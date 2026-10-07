function packageSequence(packageEntry) {
  return Number(packageEntry.sequence)
    || Number(String(packageEntry.doNumber || '').match(/^DO(\d+)$/i)?.[1])
    || 0;
}

function allocateDeliveryPackageIdentity(packages, packageId, quantity) {
  const currentPackages = Array.isArray(packages) ? packages : [];
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

module.exports = { allocateDeliveryPackageIdentity };