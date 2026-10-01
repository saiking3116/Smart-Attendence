// Minimal RFC4180-ish CSV parser: handles quoted fields, embedded commas,
// embedded quotes ("") and both \n and \r\n line endings. No external
// dependency needed for a format this simple.
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      pushField();
    } else if (c === '\r') {
      // ignore — the following \n (if present) triggers the row push
    } else if (c === '\n') {
      pushRow();
    } else {
      field += c;
    }
  }
  if (field.length || row.length) pushRow();
  // drop fully-blank lines (common trailing newline, or blank rows in the middle)
  return rows.filter(r => r.some(cell => cell.trim() !== ''));
}

// First row is the header; every following row becomes a lowercase-keyed object.
function rowsToObjects(rows) {
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim().toLowerCase());
  return rows.slice(1).map(r => {
    const obj = {};
    header.forEach((h, i) => { obj[h] = (r[i] || '').trim(); });
    return obj;
  });
}

module.exports = { parseCSV, rowsToObjects };
