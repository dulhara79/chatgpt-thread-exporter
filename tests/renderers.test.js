const test = require('node:test');
const assert = require('node:assert/strict');
const { unzipSync, strFromU8 } = require('fflate');
const { loadPure, findNode, findAll } = require('./helpers/harness.js');

const { IR, exporter } = loadPure();

const DATA = {
  title: 'My Chat',
  url: 'https://claude.ai/chat/abc',
  platform: 'claude',
  platformLabel: 'Claude'
};

function turn(markdown, index = 0) {
  return {
    id: 'turn-' + (index + 1),
    index,
    question: { role: 'user', markdown: 'Question ' + (index + 1) + '?' },
    answers: [{ role: 'assistant', markdown }]
  };
}

async function docxParts(turns, options = {}) {
  const blob = await exporter.createDocxBlob(DATA, turns, { embedImages: false, ...options });
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  const parts = {};
  for (const [name, bytes] of Object.entries(files)) {
    parts[name] = /\.(xml|rels)$/.test(name) ? strFromU8(bytes) : bytes;
  }
  return parts;
}

// ---------------------------------------------------------------- naming

test('F-02: a single-Q&A export is named separately from the whole thread', () => {
  const single = [turn('answer', 2)];
  const whole = [turn('a', 0), turn('b', 1)];

  assert.equal(exporter.exportFilename(DATA, single, 'pdf'), 'My Chat - QA 3.pdf');
  assert.equal(exporter.exportFilename(DATA, single, 'docx'), 'My Chat - QA 3.docx');
  assert.equal(exporter.exportFilename(DATA, whole, 'pdf'), 'My Chat.pdf');

  // The PDF path must use the same helper as Word and Markdown, or two
  // separate answers both download as "My Chat.pdf".
  assert.notEqual(
    exporter.exportFilename(DATA, single, ''),
    exporter.exportFilename(DATA, whole, '')
  );
});

test('document metadata names the originating platform', () => {
  const definition = exporter.buildPdfDefinition(DATA, [turn('hi')]);
  assert.equal(definition.info.creator, 'Claude Thread Exporter');
  assert.equal(definition.info.subject, 'Claude conversation export');
  assert.equal(definition.cgxFooterLabel, 'Claude Thread Exporter');

  const chatgpt = exporter.buildPdfDefinition(
    { ...DATA, platform: 'chatgpt', platformLabel: 'ChatGPT' }, [turn('hi')]
  );
  assert.equal(chatgpt.info.creator, 'ChatGPT Thread Exporter');
});

// ---------------------------------------------------------------- PDF

test('F-05: nested lists reach the PDF as nested pdfmake lists', () => {
  const definition = exporter.buildPdfDefinition(DATA, [turn('- Parent\n  - Child A\n  - Child B\n- Second')]);

  const lists = findAll(definition.content, node => node.ul);
  const top = lists.find(node => node.ul.length === 2);
  assert.ok(top, 'exactly one two-item top-level list, not four single-item lists');
  assert.ok(findNode(top.ul[0], node => node.ul), 'the first item owns a nested list');
});

test('F-07: a code block inside a numbered step renders inside that step', () => {
  const definition = exporter.buildPdfDefinition(DATA, [turn('1. Step\n   ```js\n   const a = 1;\n   ```\n2. Next')]);

  const ol = findNode(definition.content, node => node.ol);
  assert.equal(ol.ol.length, 2);
  assert.ok(findNode(ol.ol[0], node => node.cgxPreformatted), 'the code stays inside step 1');
});

test('F-08: long code lines stay exact and wrap only at PDF layout time', () => {
  const long = 'const x = ' + '"abcdefghij"'.repeat(30) + ';';
  const definition = exporter.buildPdfDefinition(DATA, [turn('```js\n' + long + '\n```')]);

  const code = findNode(definition.content, node => node.cgxPreformatted);
  assert.ok(code.cgxPreformatted.fontSize >= 8, 'never shrinks below print-legible size');
  assert.equal(code.cgxPreformatted.diagram, false);
  assert.equal(code.cgxPreformatted.text, long, 'the exported selectable code must equal the source exactly');
  assert.ok(!/[↴↳]/u.test(code.cgxPreformatted.text), 'no synthetic continuation glyphs are inserted');
});

test('F-08: character diagrams keep exact columns', () => {
  const definition = exporter.buildPdfDefinition(DATA, [turn('```\nA\n│\n▼\nB\n```')]);
  const code = findNode(definition.content, node => node.cgxPreformatted);
  assert.equal(code.cgxPreformatted.diagram, true);
});

test('F-09: PDF tables repeat their header row and honour alignment', () => {
  const definition = exporter.buildPdfDefinition(DATA, [turn('| L | R |\n|:--|--:|\n| a | b |')]);
  const table = findNode(definition.content, node => node.table?.headerRows === 1 && node.table.body.length === 2);

  assert.equal(table.table.keepWithHeaderRows, 1);
  assert.equal(table.table.dontBreakRows, true);
  assert.equal(table.table.body[0][0].alignment, 'left');
  assert.equal(table.table.body[0][1].alignment, 'right');
});

test('F-10: question labels stay intact while long question bodies may paginate', () => {
  const definition = exporter.buildPdfDefinition(DATA, [turn('answer')]);
  const question = definition.content.find(node =>
    Array.isArray(node.stack) && node.stack.some(child => child?.tocText)
  );
  assert.ok(question, 'question container exists');
  assert.notEqual(question.unbreakable, true, 'the whole question must not be forced onto one page');
  assert.equal(question.stack[0].unbreakable, undefined, 'label is a short single text node already');
});

test('F-11: a table of contents appears once the thread is long enough', () => {
  const many = Array.from({ length: 5 }, (_, i) => turn('answer ' + i, i));
  assert.ok(findNode(exporter.buildPdfDefinition(DATA, many).content, node => node.toc), 'TOC for 5 turns');
  assert.equal(findNode(exporter.buildPdfDefinition(DATA, [turn('a')]).content, node => node.toc), null,
    'no TOC for a single-turn export');
});

test('script runs are split so each alphabet gets its bundled font', () => {
  const definition = exporter.buildPdfDefinition(DATA, [turn('English සිංහල தமிழ் 한국어 😀')]);
  const fonts = new Set(findAll(definition.content, node => node.cgxFont).map(node => node.cgxFont));
  for (const font of ['latin', 'sinhala', 'tamil', 'korean', 'emoji']) {
    assert.ok(fonts.has(font), 'expected a ' + font + ' run');
  }
});

test('emoji shaping controls never reach pdfmake as visible glyphs', () => {
  const definition = exporter.buildPdfDefinition(DATA, [turn('Emoji ❤️ family 👨‍👩‍👧‍👦 and 😀')]);
  const raw = JSON.stringify(definition);
  assert.ok(!raw.includes('\u200d'), 'ZWJ must not become a blank PDF glyph');
  assert.ok(!raw.includes('\ufe0f'), 'variation selector must not become a blank PDF glyph');
  assert.ok(raw.includes('😀'), 'base emoji remains in the document');
});

test('the PDF definition survives a JSON round-trip through extension messaging', () => {
  const definition = exporter.buildPdfDefinition(DATA, [turn('- a\n  - b\n\n| x |\n|---|\n| y |')]);
  assert.deepEqual(JSON.parse(JSON.stringify(definition)), definition);
});

// ---------------------------------------------------------------- DOCX

test('F-06: one numbering definition per list, not per list item', async () => {
  const parts = await docxParts([turn('- a\n- b\n- c\n- d\n- e\n- f')]);
  const numbering = parts['word/numbering.xml'];

  assert.equal((numbering.match(/<w:abstractNum /g) || []).length, 2,
    'exactly two abstract definitions: bullet and decimal');
  assert.equal((numbering.match(/<w:num /g) || []).length, 1,
    'a six-item list is ONE list instance, not six');
});

test('F-06: numbering definitions are multi-level so nesting works in Word', async () => {
  const parts = await docxParts([turn('- Parent\n  - Child\n    - Deep')]);
  const numbering = parts['word/numbering.xml'];

  assert.ok(!numbering.includes('singleLevel'), 'must not be a single-level definition');
  assert.equal((numbering.match(/<w:lvl w:ilvl=/g) || []).length, 18, 'nine levels for each of two definitions');

  const document = parts['word/document.xml'];
  for (const level of ['0', '1', '2']) {
    assert.ok(document.includes(`<w:ilvl w:val="${level}"/>`), 'level ' + level + ' is used');
  }
});

test('F-06: startOverride is used only when a list does not start at 1', async () => {
  const withStart = await docxParts([turn('5. five\n6. six')]);
  assert.ok(withStart['word/numbering.xml'].includes('startOverride w:val="5"'));

  const normal = await docxParts([turn('1. one\n2. two')]);
  assert.ok(!normal['word/numbering.xml'].includes('startOverride'));
});

test('F-07: block content inside a list item is indented, not orphaned', async () => {
  const parts = await docxParts([turn('1. Step\n   ```js\n   const a = 1;\n   ```')]);
  const document = parts['word/document.xml'];
  assert.ok(document.includes('const a = 1;'));
  assert.ok(document.includes('<w:ind w:left="720"/>'), 'the code sits at the list item indent');
});

test('F-09: Word tables repeat headers, use fixed layout and do not split rows', async () => {
  const parts = await docxParts([turn('| H1 | H2 |\n|:--|--:|\n| a | b |')]);
  const document = parts['word/document.xml'];

  assert.ok(document.includes('<w:tblHeader/>'), 'header repeats across pages');
  assert.ok(document.includes('<w:cantSplit/>'), 'rows are not torn across a page seam');
  assert.ok(document.includes('w:tblLayout w:type="fixed"'), 'column widths are respected');
});

test('F-11: a TOC field and outline levels are present', async () => {
  const many = Array.from({ length: 5 }, (_, i) => turn('answer ' + i, i));
  const parts = await docxParts(many);

  assert.ok(parts['word/document.xml'].includes('TOC \\o "1-3"'), 'TOC field is inserted');
  assert.ok(parts['word/settings.xml'].includes('updateFields'), 'Word populates it on open');
  assert.ok((parts['word/styles.xml'].match(/outlineLvl/g) || []).length >= 4,
    'headings declare outline levels so the TOC and Navigation Pane find them');
});

test('F-12: the package is complete and actually deflate-compressed', async () => {
  const parts = await docxParts([turn('Hello '.repeat(500))]);
  const names = Object.keys(parts);

  for (const required of [
    '[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'docProps/app.xml',
    'word/document.xml', 'word/styles.xml', 'word/numbering.xml',
    'word/settings.xml', 'word/fontTable.xml', 'word/_rels/document.xml.rels'
  ]) {
    assert.ok(names.includes(required), 'missing part: ' + required);
  }

  // Read the compression method straight out of the first local file header:
  // 0 = stored, 8 = deflate. The old writer was stored-only.
  const blob = await exporter.createDocxBlob(DATA, [turn('Hello '.repeat(500))], { embedImages: false });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.equal(bytes[0], 0x50, 'ZIP local header signature');
  const method = bytes[8] | (bytes[9] << 8);
  assert.equal(method, 8, 'text parts must be deflated, not stored');

  // And the compressed size must beat the uncompressed size recorded beside it.
  const compressedSize = bytes[18] | (bytes[19] << 8) | (bytes[20] << 16) | (bytes[21] << 24);
  const uncompressedSize = bytes[22] | (bytes[23] << 8) | (bytes[24] << 16) | (bytes[25] << 24);
  assert.ok(compressedSize < uncompressedSize, 'deflate must shrink the part');
});

test('DOCX is a valid ZIP with UTF-8 filenames and correct CRCs', async () => {
  const parts = await docxParts([turn('සිංහල 한국어 emoji 😀')]);
  assert.ok(parts['word/document.xml'].includes('සිංහල'), 'unzip verified CRC and content');
});

test('hyperlinks get real relationships rather than bare text', async () => {
  const parts = await docxParts([turn('See [the docs](https://example.com/docs).')]);
  assert.ok(parts['word/_rels/document.xml.rels'].includes('https://example.com/docs'));
  assert.ok(parts['word/_rels/document.xml.rels'].includes('TargetMode="External"'));
  assert.ok(parts['word/document.xml'].includes('<w:hyperlink'));
});

test('control characters are stripped so Word does not report corruption', async () => {
  const parts = await docxParts([turn('before\u0007after')]);
  assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(parts['word/document.xml']));
  assert.ok(parts['word/document.xml'].includes('beforeafter'));
});

test('XML special characters in content are escaped', async () => {
  const parts = await docxParts([turn('a < b & c > d "quoted"')]);
  assert.ok(parts['word/document.xml'].includes('a &lt; b &amp; c &gt; d'));
});

// ---------------------------------------------------------------- Markdown

test('exported Markdown preserves nesting and alignment', () => {
  const markdown = exporter.createMarkdown(DATA, [turn('- Parent\n  - Child\n\n| L | R |\n|:--|--:|\n| a | b |')]);

  assert.match(markdown, /^ {2}- Child$/m, 'the child item stays indented');
  assert.match(markdown, /\|\s*:---\s*\|\s*---:\s*\|/, 'alignment markers are re-emitted');

  const reparsed = IR.parseBlocks(markdown);
  assert.ok(findNode(reparsed, node => node.type === 'list' && node.items?.some(
    item => item.blocks.some(block => block.type === 'list')
  )));
});

test('turns already carrying IR skip the Markdown fallback entirely', () => {
  const blocks = IR.parseBlocks('- a\n  - b');
  const prepared = exporter.normalizeTurns([{
    index: 0,
    question: { blocks: IR.parseBlocks('Q?') },
    answers: [{ blocks }]
  }]);
  assert.equal(prepared[0].answers[0].blocks, blocks, 'pre-extracted IR is passed through by reference');
});

test('preflight rejects a payload too large for extension messaging', () => {
  const huge = [turn('x'.repeat(25 * 1024 * 1024))];
  assert.throws(() => exporter.preflightPdfSource(DATA, huge), /too large/i);
});
