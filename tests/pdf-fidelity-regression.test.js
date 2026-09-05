const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

require('../math.js');
require('../exporter.js');
const exporter = globalThis.ChatGPTExporter;

const data = { title: 'PDF Fidelity', url: 'https://chatgpt.com/c/pdf-fidelity' };

function visit(node, predicate, found = []) {
  if (predicate(node)) found.push(node);
  if (Array.isArray(node)) {
    node.forEach(item => visit(item, predicate, found));
  } else if (node && typeof node === 'object') {
    Object.values(node).forEach(value => visit(value, predicate, found));
  }
  return found;
}

test('multilingual and emoji PDF content stays text instead of cgxRasterText images', () => {
  const turns = [{
    id: 'unicode',
    index: 0,
    question: {
      role: 'user',
      text: 'English සිංහල தமிழ் 한국어 😀 ∑ α β → ✓',
      markdown: 'English සිංහල தமிழ் 한국어 😀 ∑ α β → ✓'
    },
    answers: [{ role: 'assistant', text: 'Done ✅', markdown: 'Done ✅' }]
  }];

  const definition = exporter.buildPdfDefinition(data, turns);
  const raw = JSON.stringify(definition);

  assert.doesNotMatch(raw, /cgxRasterText/);
  assert.match(raw, /සිංහල/);
  assert.match(raw, /தமிழ்/);
  assert.match(raw, /한국어/);
  assert.match(raw, /😀/);

  const fontRuns = visit(definition, node => node && typeof node === 'object' && typeof node.cgxFont === 'string');
  assert.ok(fontRuns.some(run => run.cgxFont === 'sinhala'));
  assert.ok(fontRuns.some(run => run.cgxFont === 'tamil'));
  assert.ok(fontRuns.some(run => run.cgxFont === 'korean'));
  assert.ok(fontRuns.some(run => run.cgxFont === 'emoji'));
  assert.ok(fontRuns.some(run => run.cgxFont === 'symbols'));
});

test('exact clinician architecture diagram is preserved as one selectable preformatted node', () => {
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

  const turns = [{
    id: 'diagram',
    index: 0,
    question: { role: 'user', text: 'Show architecture', markdown: 'Show architecture' },
    answers: [{ role: 'assistant', text: diagram, markdown: '~~~text\n' + diagram + '\n~~~' }]
  }];

  // Parser uses backtick fences, so replace the neutral fixture delimiters before export.
  turns[0].answers[0].markdown = turns[0].answers[0].markdown.replace(/~~~/g, String.fromCharCode(96).repeat(3));

  const definition = exporter.buildPdfDefinition(data, turns);
  const nodes = visit(definition, node => node && typeof node === 'object' && node.cgxPreformatted);

  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].cgxPreformatted.text, diagram);
  assert.equal(nodes[0].cgxPreformatted.diagram, true);
  assert.equal(nodes[0].cgxPreformatted.language, 'text');
});

test('PDF worker has no textual canvas raster fallback', () => {
  const workerSource = fs.readFileSync(require.resolve('../pdf-worker.js'), 'utf8');
  const exporterSource = fs.readFileSync(require.resolve('../exporter.js'), 'utf8');

  assert.doesNotMatch(exporterSource, /cgxRasterText/);
  assert.doesNotMatch(workerSource, /function rasterText/);
  assert.doesNotMatch(workerSource, /cgxRasterText/);
});

test('HTTPS Markdown image remains an image asset for offscreen resolution', () => {
  const turns = [{
    id: 'image',
    index: 0,
    question: { role: 'user', text: 'Image', markdown: 'Image' },
    answers: [{
      role: 'assistant',
      text: 'Architecture',
      markdown: '![Architecture diagram](https://example.com/architecture.png)'
    }]
  }];

  const definition = exporter.buildPdfDefinition(data, turns);
  const imageNodes = visit(definition, node => node && typeof node === 'object' && node.cgxImage);

  assert.equal(imageNodes.length, 1);
  assert.equal(imageNodes[0].cgxImage.src, 'https://example.com/architecture.png');
});
