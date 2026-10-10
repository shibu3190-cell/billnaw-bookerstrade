function normalizePageNumber(value, fallback = 1) {
  const page = Number.parseInt(value, 10);
  if (!Number.isFinite(page) || page < 1) return fallback;
  return page;
}

function normalizePageSize(value, fallback = 100, maxSize = 500) {
  const pageSize = Number.parseInt(value, 10);
  if (!Number.isFinite(pageSize) || pageSize < 1) return fallback;
  return Math.min(pageSize, maxSize);
}

function paginateRecords(records, page, pageSize, options = {}) {
  const items = Array.isArray(records) ? records : [];
  const defaultPageSize = Number.isInteger(options.defaultPageSize) ? options.defaultPageSize : 100;
  const maxPageSize = Number.isInteger(options.maxPageSize) ? options.maxPageSize : 500;
  const safePage = normalizePageNumber(page, 1);
  const safePageSize = normalizePageSize(pageSize, defaultPageSize, maxPageSize);
  const totalCount = items.length;
  const totalPages = totalCount === 0 ? 1 : Math.max(1, Math.ceil(totalCount / safePageSize));
  const currentPage = Math.min(safePage, totalPages);
  const startIndex = (currentPage - 1) * safePageSize;
  const endIndex = startIndex + safePageSize;

  return {
    page: currentPage,
    pageSize: safePageSize,
    totalCount,
    totalPages,
    hasPreviousPage: currentPage > 1,
    hasNextPage: currentPage < totalPages,
    items: items.slice(startIndex, endIndex)
  };
}

module.exports = {
  normalizePageNumber,
  normalizePageSize,
  paginateRecords
};
