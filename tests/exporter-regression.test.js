const test = require('node:test');
const assert = require('node:assert/strict');

require('../math.js');
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

const fs = require('node:fs');

test('content script keeps both export controls self-healing and independent of ChatGPT button state', () => {
  const source = fs.readFileSync(require.resolve('../content.js'), 'utf8');
  assert.match(source, /createOwnedButton/);
  assert.match(source, /Export this question and answer/);
  assert.match(source, /Export entire conversation/);
  assert.match(source, /insertBefore\(button, unit\)/);
  assert.doesNotMatch(source, /cgxExportDecorated === '1'/);
  assert.doesNotMatch(source, /shareButton\.cloneNode\(true\)/);
});

test('content extractor preserves meaningful rendered SVG diagrams', () => {
  const source = fs.readFileSync(require.resolve('../content.js'), 'utf8');
  assert.match(source, /XMLSerializer/);
  assert.match(source, /data:image\/svg\+xml;base64/);
  assert.match(source, /shapeCount >= 8/);
});

test('PDF renderer accepts data-image diagrams and uses diagram-aware code formatting', () => {
  const diagram = [{
    id: 'turn-diagram',
    index: 0,
    question: { role: 'user', text: 'Show architecture', markdown: 'Show architecture' },
    answers: [{
      role: 'assistant',
      text: 'Diagram',
      markdown: '![Diagram](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)\n\n\`\`\`text\nA ──→ B\n     │\n     ▼\n     C\n\`\`\`'
    }]
  }];
  const html = exporter.buildPrintHtml(data, diagram);
  assert.match(html, /data:image\/svg\+xml;base64/);
  assert.match(html, /diagram-wrap/);
  assert.match(html, /diagram-code/);
});

test('professional PDF typography uses restrained document palette and standard point sizes', () => {
  const html = exporter.buildPrintHtml(data, turns);
  assert.match(html, /font-size: 10\.5pt/);
  assert.match(html, /h1 \{ font-size: 23pt/);
  assert.match(html, /#183B56/);
  assert.match(html, /#F7F9FC/);
  assert.match(html, /Cascadia Mono/);
});

test('equations render as structural MathML instead of raw LaTeX text', () => {
  const equationTurns = [{
    id: 'turn-equation',
    index: 0,
    question: { role: 'user', text: 'Show equation', markdown: 'Show equation' },
    answers: [{
      role: 'assistant',
      text: 'Equation',
      markdown: '$$\\frac{x^2+1}{\\sqrt{y}} = \\sum_{i=1}^{n} i$$'
    }]
  }];
  const html = exporter.buildPrintHtml(data, equationTurns);
  assert.match(html, /<math xmlns="http:\/\/www\.w3\.org\/1998\/Math\/MathML"/);
  assert.match(html, /<mfrac>/);
  assert.match(html, /<msqrt>/);
  assert.match(html, /<msubsup>/);
  assert.doesNotMatch(html, />\\frac\{/);
});

test('DOCX equations use native OMML structures', async () => {
  const equationTurns = [{
    id: 'turn-equation',
    index: 0,
    question: { role: 'user', text: 'Show equation', markdown: 'Show equation' },
    answers: [{
      role: 'assistant',
      text: 'Equation',
      markdown: '$$\\frac{x^2+1}{\\sqrt{y}}$$'
    }]
  }];
  const blob = await exporter.createDocxBlob(data, equationTurns, { pageSize: 'A4' });
  const raw = new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()));
  assert.match(raw, /xmlns:m="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/math"/);
  assert.match(raw, /<m:oMathPara>/);
  assert.match(raw, /<m:f>/);
  assert.match(raw, /<m:rad>/);
  assert.match(raw, /<m:sSup>/);
});

test('PDF export uses background direct download with conversation-title filename', () => {
  const exporterSource = fs.readFileSync(require.resolve('../exporter.js'), 'utf8');
  const backgroundSource = fs.readFileSync(require.resolve('../background.js'), 'utf8');
  assert.match(exporterSource, /CGX_EXPORT_PDF/);
  assert.doesNotMatch(exporterSource, /window\.open\(url/);
  assert.doesNotMatch(exporterSource, /win\.print\(\)/);
  assert.match(backgroundSource, /Page\.printToPDF/);
  assert.match(backgroundSource, /chrome\.downloads\.download/);
  assert.match(backgroundSource, /saveAs: false/);
});

test('A4 remains the default PDF page size', () => {
  assert.equal(exporter.normalizePageSize(), 'A4');
  assert.match(exporter.buildPrintHtml(data, turns), /size: A4/);
});
