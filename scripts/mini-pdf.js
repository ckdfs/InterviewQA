/**
 * 手写最小 PDF（ASCII 正文），供自检脚本在 CI 里也能覆盖 PDF 提取路径。
 * 不引第三方库，输出单页、Helvetica、若干行文本。
 *
 * 用法：node scripts/mini-pdf.js [输出路径]
 */
const fs = require('fs');

function buildPdf(lines) {
  const content =
    'BT /F1 12 Tf 50 780 Td 16 TL\n' +
    lines.map((l) => `(${l.replace(/([()\\])/g, '\\$1')}) Tj T*`).join('\n') +
    '\nET\n';

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefStart = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

if (require.main === module) {
  const out = process.argv[2] || path.join(require('os').tmpdir(), 'mini.pdf');
  fs.writeFileSync(
    out,
    buildPdf([
      'Education',
      'M.S. in Electronic Information, expected 2027-06',
      'B.S. in Electronic Engineering, 2021-09 to 2025-06, GPA 3.8/4.0',
      'Projects',
      'High speed link eye diagram tool: cut analysis time from 15min to 2min',
    ])
  );
  console.log(`已生成 ${out}`);
}

module.exports = { buildPdf };
