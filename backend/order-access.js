function sameOwner(left, right) {
  const normalize = value => String(value || '').replace(/[-_\s]/g, '').toLowerCase();
  return normalize(left) === normalize(right);
}

function canAccessOrder(actor, order) {
  if (!actor || !order) return false;
  if (actor.isMaster) return true;
  if (actor.role === 'admin') return sameOwner(order.adminId, actor.adminId);
  if (actor.role !== 'customer' || !sameOwner(order.customerId, actor.customerId)) return false;
  return !order.adminId || sameOwner(order.adminId, actor.adminId);
}

function canUseProduct(actor, product, orderAdminId) {
  if (!actor || !product || product.active === false) return false;
  if (!actor.isMaster && !sameOwner(actor.adminId, orderAdminId)) return false;
  return !product.adminId || sameOwner(product.adminId, orderAdminId);
}

module.exports = { canAccessOrder, canUseProduct };