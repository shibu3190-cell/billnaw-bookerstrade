(function (root) {
  function parseCsv(text) {
    const source = String(text || '').replace(/^\uFEFF/, '');
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    for (let index = 0; index < source.length; index += 1) {
      const character = source[index];
      if (character === '"') {
        if (inQuotes && source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else if (inQuotes) {
          inQuotes = false;
        } else if (field.length === 0) {
          inQuotes = true;
        } else {
          field += character;
        }
      } else if (character === ',' && !inQuotes) {
        row.push(field);
        field = '';
      } else if ((character === '\n' || character === '\r') && !inQuotes) {
        if (character === '\r' && source[index + 1] === '\n') index += 1;
        row.push(field);
        if (row.some(value => value.trim() !== '')) rows.push(row);
        row = [];
        field = '';
      } else {
        field += character;
      }
    }

    if (inQuotes) throw new Error('CSV contains an unterminated quoted field.');
    row.push(field);
    if (row.some(value => value.trim() !== '')) rows.push(row);
    return rows;
  }

  root.DeviceTradeCsv = { parseCsv };
  if (typeof module !== 'undefined' && module.exports) module.exports = { parseCsv };
})(globalThis);