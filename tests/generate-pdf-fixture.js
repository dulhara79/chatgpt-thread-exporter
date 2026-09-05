const fs = require('node:fs');
const path = require('node:path');

function fail(stage, error) {
  const name = error?.name || 'Error';
  const message = error?.message || String(error);
  process.stderr.write('CGX_FIXTURE_ERROR [' + stage + '] ' + name + ': ' + message + '\n');
  process.exit(1);
}

process.on('uncaughtException', error => fail('uncaughtException', error));
process.on('unhandledRejection', error => fail('unhandledRejection', error));

let pdfMake;
try {
  process.stderr.write('CGX_FIXTURE_STAGE require-pdfmake\n');
  pdfMake = require('../vendor/pdfmake.min.js');
  process.stderr.write('CGX_FIXTURE_STAGE pdfmake-loaded\n');
} catch (error) { fail('require-pdfmake', error); }

try {
  globalThis.pdfMake = pdfMake;
  require('../vendor/vfs_fonts.js');
  process.stderr.write('CGX_FIXTURE_STAGE roboto-vfs-loaded\n');
  require('../vendor/vfs_extra_fonts.js');
  process.stderr.write('CGX_FIXTURE_STAGE extra-vfs-loaded\n');
} catch (error) { fail('load-vfs', error); }

if (!globalThis.CGX_PDF_EXTRA_FONTS) fail('extra-fonts', new Error('Multilingual PDF fonts did not load.'));
pdfMake.fonts = Object.assign({
  Roboto: {
    normal: 'Roboto-Regular.ttf',
    bold: 'Roboto-Medium.ttf',
    italics: 'Roboto-Italic.ttf',
    bolditalics: 'Roboto-MediumItalic.ttf'
  }
}, pdfMake.fonts || {}, globalThis.CGX_PDF_EXTRA_FONTS);

try {
  require('../math.js');
  require('../exporter.js');
  process.stderr.write('CGX_FIXTURE_STAGE exporter-loaded\n');
} catch (error) { fail('load-exporter', error); }
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

let definition;
try {
  definition = exporter.buildPdfDefinition(data, turns, { pageSize: 'A4' });
  process.stderr.write('CGX_FIXTURE_STAGE definition-built\n');
} catch (error) { fail('build-definition', error); }

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
try {
  process.stderr.write('CGX_FIXTURE_STAGE create-pdf\n');
  pdfMake.createPdf(definition).getBuffer(buffer => {
    try {
      fs.writeFileSync(output, Buffer.from(buffer));
      process.stderr.write('CGX_FIXTURE_STAGE pdf-written\n');
      process.stdout.write(output + '\n');
    } catch (error) { fail('write-pdf', error); }
  });
} catch (error) { fail('create-pdf', error); }
