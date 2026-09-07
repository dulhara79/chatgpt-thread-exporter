/**
 * Glyph coverage of the bundled fonts.
 *
 * A character routed to a font that has no glyph for it renders as an empty
 * rectangle and nothing anywhere else fails — no exception, no test failure,
 * just a broken PDF. That is how box-drawing diagrams ended up as rows of
 * blank boxes. These tests read the actual cmap tables so the routing table in
 * pdf-worker.js cannot drift away from what the fonts really contain.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, readSource } = require('./helpers/harness.js');

/** Minimal TrueType cmap reader: formats 4 and 12 cover every bundled font. */
function codepointsOf(relativePath) {
  const buffer = fs.readFileSync(path.join(ROOT, relativePath));
  const tableCount = buffer.readUInt16BE(4);

  let cmapOffset = 0;
  for (let i = 0; i < tableCount; i++) {
    const record = 12 + i * 16;
    if (buffer.toString('ascii', record, record + 4) === 'cmap') {
      cmapOffset = buffer.readUInt32BE(record + 8);
      break;
    }
  }
  assert.ok(cmapOffset, relativePath + ' has no cmap table');

  const subtableCount = buffer.readUInt16BE(cmapOffset + 2);
  const covered = new Set();

  for (let i = 0; i < subtableCount; i++) {
    const record = cmapOffset + 4 + i * 8;
    const subtable = cmapOffset + buffer.readUInt32BE(record + 4);
    const format = buffer.readUInt16BE(subtable);

    if (format === 4) {
      const segCountX2 = buffer.readUInt16BE(subtable + 6);
      const segCount = segCountX2 / 2;
      const endBase = subtable + 14;
      const startBase = endBase + segCountX2 + 2;
      for (let seg = 0; seg < segCount; seg++) {
        const end = buffer.readUInt16BE(endBase + seg * 2);
        const start = buffer.readUInt16BE(startBase + seg * 2);
        if (start === 0xFFFF) continue;
        for (let cp = start; cp <= end && cp !== 0xFFFF; cp++) covered.add(cp);
      }
    } else if (format === 12) {
      const groups = buffer.readUInt32BE(subtable + 12);
      for (let g = 0; g < groups; g++) {
        const base = subtable + 16 + g * 12;
        const start = buffer.readUInt32BE(base);
        const end = buffer.readUInt32BE(base + 4);
        // Guard against pathological ranges in malformed fonts.
        for (let cp = start; cp <= end && cp - start < 0x10000; cp++) covered.add(cp);
      }
    }
  }

  return covered;
}

const MONO = 'vendor/fonts/NotoSansMono-Regular.ttf';
const SYMBOLS = 'vendor/fonts/NotoSansSymbols2-Regular.ttf';

/** Mirrors preformattedFontKey() in pdf-worker.js for the BMP ranges it routes. */
function routedFont(codePoint) {
  if (codePoint >= 0x0D80 && codePoint <= 0x0DFF) return 'sinhala';
  if (codePoint >= 0x0B80 && codePoint <= 0x0BFF) return 'tamil';
  if (codePoint >= 0xAC00 && codePoint <= 0xD7AF) return 'korean';
  if (codePoint >= 0x2600 && codePoint <= 0x27BF) return 'symbols';
  if (codePoint >= 0x2B00 && codePoint <= 0x2BFF) return 'symbols';
  return 'mono';
}

test('the mono font covers every character routed to it in diagrams', () => {
  const mono = codepointsOf(MONO);

  // Exactly the characters ChatGPT and Claude use to draw tree diagrams.
  const diagram = 'Browser\n ├── displays local 30 FPS camera\n │\n └── samples selected frames\n       ↓\n     WebSocket\n ┌┐┘┤┬┴┼━▼▲│─';

  const missing = [];
  for (const char of Array.from(diagram)) {
    const cp = char.codePointAt(0);
    // Line breaks are structural: the renderer splits on them, so they never
    // have to resolve to a glyph.
    if (cp < 0x20) continue;
    if (routedFont(cp) !== 'mono') continue;
    if (!mono.has(cp)) missing.push(char + ' U+' + cp.toString(16).toUpperCase());
  }

  assert.deepEqual(missing, [],
    'these characters would render as empty rectangles: ' + missing.join(', '));
});

test('box drawing and arrows are NOT routed to the symbol font', () => {
  const symbols = codepointsOf(SYMBOLS);

  // The regression: these were sent to NotoSansSymbols2, which has no glyphs
  // for them, so every diagram came out as blank boxes.
  for (const char of ['├', '│', '└', '─', '↓', '→']) {
    const cp = char.codePointAt(0);
    assert.equal(routedFont(cp), 'mono', char + ' must render in the mono font');
    assert.ok(!symbols.has(cp),
      char + ' is absent from the symbol font, which is exactly why it must not be routed there');
  }
});

test('characters routed to the symbol font are actually present in it', () => {
  const symbols = codepointsOf(SYMBOLS);
  for (const char of ['✓', '✗', '★']) {
    const cp = char.codePointAt(0);
    if (routedFont(cp) !== 'symbols') continue;
    assert.ok(symbols.has(cp), char + ' is routed to the symbol font but missing from it');
  }
});

test('the worker routing table matches this test', () => {
  const worker = readSource('pdf-worker.js');
  // Guard against someone "tidying" the ranges back to the Unicode block names.
  assert.ok(!/0x2500 && codePoint <= 0x257F\) *\|\|[\s\S]{0,80}return 'symbols'/.test(worker),
    'box drawing must not be routed to the symbol font');
  assert.match(worker, /codePoint >= 0x2600 && codePoint <= 0x27BF/);
  assert.match(worker, /MEASURED glyph coverage/);
});

test('preformatted text is emitted line by line, never as one noWrap string', () => {
  const worker = readSource('pdf-worker.js');
  // pdfmake's noWrap puts a whole string on one line, so a multi-line diagram
  // collapsed into a single clipped row.
  assert.ok(worker.includes("text.split('\\n')"), 'preformatted text is split into lines');
  assert.ok(!/const out = \{\s*text,\s*font: 'NotoMono'/.test(worker),
    'the single-string noWrap node is what collapsed diagrams');
});
