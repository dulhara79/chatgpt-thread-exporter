const fs = require('node:fs');
const path = require('node:path');

const pdfMake = require('../vendor/pdfmake.min.js');
globalThis.pdfMake = pdfMake;
require('../vendor/vfs_fonts.js');
require('../vendor/vfs_extra_fonts.js');

if (!globalThis.CGX_PDF_EXTRA_FONTS) throw new Error('Multilingual PDF fonts did not load.');
pdfMake.fonts = Object.assign({}, pdfMake.fonts || {}, globalThis.CGX_PDF_EXTRA_FONTS);

require('../math.js');
require('../exporter.js');
const exporter = globalThis.ChatGPTExporter;

const diagram = [
  'Clinician Flutter App',
  '        │',
  '        │ HTTPS',
  '        ▼',
  'Central Backend',
  '        │',
  '        ├── C1 Physiological',
  '        ├── C2 Behavioural',
  '        ├── C3 Clinical NLP → TC-WPN',
  '        └── C4 Demographic',
  '                │',
  '                ▼',
  '          RAGF Fusion',
  '                │',
  '                ▼',
  '        Composite Risk',
  '                │',
  '                ▼',
  '       Central Backend',
  '                │',
  '                ▼',
  '        Clinician App'
].join('\n');

const fence = String.fromCharCode(96).repeat(3);
const data = { title: 'V039 Selectable PDF Fixture' };
const turns = [{
  id: 'fixture',
  index: 0,
  question: { role: 'user', text: 'English සිංහල தமிழ் 한국어 😀 🚀 ✅', markdown: 'English සිංහල தமிழ் 한국어 😀 🚀 ✅' },
  answers: [{
    role: 'assistant',
    text: diagram,
    markdown: ['Selectable multilingual content:', '', 'English සිංහල தமிழ் 한국어 😀 🚀 ✅', '', fence + 'text', diagram, fence].join('\n')
  }]
}];

const definition = exporter.buildPdfDefinition(data, turns, { pageSize: 'A4' });
definition.footer = (currentPage, pageCount) => ({
  columns: [
    { text: 'ChatGPT Thread Exporter', alignment: 'left' },
    { text: 'Page ' + currentPage + ' of ' + pageCount, alignment: 'right' }
  ],
  margin: [51, 10, 51, 0],
  fontSize: 8,
  color: '#64748B'
});

const output = path.join(__dirname, 'v039-selectable-fixture.pdf');
pdfMake.createPdf(definition).getBuffer(buffer => {
  fs.writeFileSync(output, Buffer.from(buffer));
  process.stdout.write(output + '\n');
});
