function toCSV(rows, columns) {
  const header = columns.join(',');
  const lines = rows.map(r => columns.map(c => {
    let v = r[c];
    if (v === null || v === undefined) v = '';
    v = String(v).replace(/"/g, '""');
    if (v.includes(',') || v.includes('"') || v.includes('\n')) v = `"${v}"`;
    return v;
  }).join(','));
  return [header, ...lines].join('\n');
}

async function toExcelBuffer(rows, columns, sheetName = 'Report') {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.columns = columns.map(c => ({ header: c.header || c.key, key: c.key, width: c.width || 20 }));
  ws.getRow(1).font = { bold: true };
  rows.forEach(r => ws.addRow(r));
  return wb.xlsx.writeBuffer();
}

function pdfReport(res, title, subtitle, sections) {
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ margin: 40 });
  doc.pipe(res);

  doc.fontSize(18).fillColor('#12172B').text(title, { align: 'left' });
  if (subtitle) doc.fontSize(10).fillColor('#5B6478').text(subtitle);
  doc.moveDown(1);

  sections.forEach(section => {
    doc.fontSize(13).fillColor('#12172B').text(section.heading);
    doc.moveDown(0.3);
    if (section.rows && section.rows.length) {
      const colWidths = section.columns.map(c => c.width || 100);
      let y = doc.y;
      doc.fontSize(9).fillColor('#5B6478');
      let x = doc.x;
      section.columns.forEach((c, i) => { doc.text(c.header, x, y, { width: colWidths[i] }); x += colWidths[i]; });
      y += 16;
      doc.fillColor('#12172B');
      section.rows.forEach(row => {
        x = doc.x;
        section.columns.forEach((c, i) => {
          doc.fontSize(9).text(String(row[c.key] ?? ''), x, y, { width: colWidths[i] });
          x += colWidths[i];
        });
        y += 15;
        if (y > 760) { doc.addPage(); y = 40; }
      });
      doc.y = y + 10;
    } else {
      doc.fontSize(10).fillColor('#959CAC').text('No data available.');
    }
    doc.moveDown(1);
  });

  doc.end();
}

module.exports = { toCSV, toExcelBuffer, pdfReport };
