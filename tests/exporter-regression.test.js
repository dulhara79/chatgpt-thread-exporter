const test = require('node:test');
const assert = require('node:assert/strict');

require('../exporter.js');
const exporter = globalThis.ChatGPTExporter;

const data = { title: 'Professional Export', url: 'https://chatgpt.com/c/example' };
const turns = [{
  id: 'turn-1',
  index: 0,
  question: { role: 'user', text: 'සිංහල English தமிழ் 한국어 😀', markdown: 'සිංහල English தமிழ் 한국어 😀' },
  answers: [{
    role: 'assistant',
    text: 'Answer',
    markdown: '1. One\n2. Two\n3. Three\n4. Four\n\n$$E = mc^2$$\n\nUnicode: ∑ α β → ✓'
  }]
}];

test('Markdown omits visible export metadata and preserves sequence, math, and Unicode', () => {
  const md = exporter.createMarkdown(data, turns);
  assert.doesNotMatch(md, /\*\*Scope:\*\*|\*\*Source:\*\*|\*\*Exported:\*\*/);
  assert.match(md, /1\. One/);
  assert.match(md, /2\. Two/);
  assert.match(md, /3\. Three/);
  assert.match(md, /4\. Four/);
  assert.match(md, /E = mc\^2/);
  assert.match(md, /සිංහල English தமிழ் 한국어 😀/);
});

test('PDF defaults to A4 and preserves semantic ordered list values', () => {
  const html = exporter.buildPrintHtml(data, turns);
  assert.match(html, /size: A4/);
  assert.match(html, /<li value="1">One<\/li>/);
  assert.match(html, /<li value="4">Four<\/li>/);
  assert.doesNotMatch(html, />Scope<|>Exported<|class="meta-grid" role=/);
});

test('PDF supports Letter and Legal page sizes', () => {
  assert.match(exporter.buildPrintHtml(data, turns, { pageSize: 'Letter' }), /size: Letter/);
  assert.match(exporter.buildPrintHtml(data, turns, { pageSize: 'Legal' }), /size: Legal/);
});

test('image filter rejects citation favicons and keeps meaningful images', () => {
  assert.equal(exporter.shouldIncludeImage({ src: 'https://www.google.com/s2/favicons?domain=https://icscds.com&sz=128', alt: 'Image', width: 128, height: 128 }), false);
  assert.equal(exporter.shouldIncludeImage({ src: 'https://example.com/diagram.png', alt: 'Architecture diagram', width: 1200, height: 800 }), true);
});

test('DOCX contains native numbering, Unicode, and A4 geometry', async () => {
  const blob = await exporter.createDocxBlob(data, turns, { pageSize: 'A4' });
  assert.equal(blob.type, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const raw = new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()));
  assert.match(raw, /word\/numbering\.xml/);
  assert.match(raw, /<w:numPr>/);
  assert.match(raw, /<w:numFmt w:val="decimal"\/>/);
  assert.match(raw, /w:pgSz w:w="11906" w:h="16838"/);
  assert.match(raw, /සිංහල English தமிழ் 한국어 😀/);
});
