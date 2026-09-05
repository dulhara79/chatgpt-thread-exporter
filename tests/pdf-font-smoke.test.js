const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('bundled Unicode PDF fonts generate a real selectable-font PDF', async () => {
  const pdfMake = require('../vendor/pdfmake.min.js');
  const files = {
    'NotoSansSinhala-Regular.ttf': 'vendor/fonts/NotoSansSinhala-Regular.ttf',
    'NotoSansTamil-Regular.ttf': 'vendor/fonts/NotoSansTamil-Regular.ttf',
    'NotoSansMono-Regular.ttf': 'vendor/fonts/NotoSansMono-Regular.ttf',
    'NotoSansSymbols2-Regular.ttf': 'vendor/fonts/NotoSansSymbols2-Regular.ttf',
    'NotoSansKR-Regular.woff2': 'vendor/fonts/NotoSansKR-Regular.woff2',
    'NotoEmoji-Regular.woff2': 'vendor/fonts/NotoEmoji-Regular.woff2'
  };

  const vfs = {};
  for (const [name, relative] of Object.entries(files)) {
    const bytes = fs.readFileSync(path.join(__dirname, '..', relative));
    assert.ok(bytes.length > 1000, name + ' should not be empty');
    vfs[name] = bytes.toString('base64');
  }
  pdfMake.addVirtualFileSystem(vfs);

  const one = name => ({ normal:name, bold:name, italics:name, bolditalics:name });
  pdfMake.fonts = {
    NotoSinhala: one('NotoSansSinhala-Regular.ttf'),
    NotoTamil: one('NotoSansTamil-Regular.ttf'),
    NotoKorean: one('NotoSansKR-Regular.woff2'),
    NotoSymbols: one('NotoSansSymbols2-Regular.ttf'),
    NotoEmoji: one('NotoEmoji-Regular.woff2'),
    NotoMono: one('NotoSansMono-Regular.ttf')
  };

  const doc = {
    defaultStyle: { font: 'NotoMono' },
    content: [{
      text: [
        { text:'English ', font:'NotoMono' },
        { text:'සිංහල ', font:'NotoSinhala' },
        { text:'தமிழ் ', font:'NotoTamil' },
        { text:'한국어 ', font:'NotoKorean' },
        { text:'→ ✓ ', font:'NotoSymbols' },
        { text:'😀', font:'NotoEmoji' }
      ]
    }, {
      text: 'Clinician Flutter App\n        │\n        ▼\nCentral Backend',
      font: 'NotoMono',
      noWrap: true,
      preserveLeadingSpaces: true
    }]
  };

  const buffer = await new Promise((resolve, reject) => {
    try {
      pdfMake.createPdf(doc).getBuffer(resolve);
    } catch (error) {
      reject(error);
    }
  });

  assert.ok(Buffer.isBuffer(buffer) || buffer instanceof Uint8Array);
  assert.equal(Buffer.from(buffer).subarray(0, 4).toString('ascii'), '%PDF');
  assert.ok(Buffer.from(buffer).length > 1000);
});
