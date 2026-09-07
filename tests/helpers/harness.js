'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');

/** Load order must mirror manifest.json `content_scripts.js`. */
const CONTENT_SCRIPTS = [
  'math.js',
  'src/platforms/adapter.js',
  'src/platforms/chatgpt.js',
  'src/platforms/claude.js',
  'src/platforms/registry.js',
  'src/ir/parse.js',
  'src/ir/extract.js',
  'src/ir/markdown.js',
  'src/ir/pdf.js',
  'src/ir/docx.js',
  'exporter.js'
];

/** Modules that need no DOM — loaded straight into this realm. */
function loadPure() {
  for (const file of ['math.js', 'src/ir/parse.js', 'src/ir/markdown.js', 'src/ir/pdf.js', 'src/ir/docx.js', 'exporter.js']) {
    delete require.cache[require.resolve(path.join(ROOT, file))];
    require(path.join(ROOT, file));
  }
  return {
    IR: globalThis.ThreadExporterIR,
    MD: globalThis.ThreadExporterMarkdown,
    PDF: globalThis.ThreadExporterPdfIR,
    DOCX: globalThis.ThreadExporterDocxIR,
    exporter: globalThis.ThreadExporter
  };
}

/**
 * Boot a jsdom page with the extension's content-script modules loaded, so
 * adapters and the DOM extractor run against real DOM APIs.
 *
 * @param {string} html
 * @param {string} url
 */
function loadPage(html, url) {
  // `outside-only` gives us window.eval without executing any script the
  // fixture itself contains.
  const dom = new JSDOM(html, { url, pretendToBeVisual: true, runScripts: 'outside-only' });
  const { window } = dom;

  // jsdom has no layout engine, so every element reports a zero box. The
  // adapters use size only as a visibility signal, so give them a plausible
  // one unless the fixture explicitly hides the element.
  window.Element.prototype.getBoundingClientRect = function () {
    const style = window.getComputedStyle(this);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
    }
    return { width: 200, height: 40, top: 50, left: 20, right: 220, bottom: 90 };
  };

  for (const file of CONTENT_SCRIPTS) {
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
    try {
      window.eval(code);
    } catch (error) {
      throw new Error(`Failed loading ${file}: ${error.message}`);
    }
  }

  return {
    dom,
    window,
    document: window.document,
    adapter: window.ThreadExporterRegistry.detect(url),
    extract: window.ThreadExporterExtract,
    IR: window.ThreadExporterIR,
    exporter: window.ThreadExporter
  };
}

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8');
}

/** Depth-first search over a pdfmake definition. */
function findNode(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findNode(item, predicate);
      if (hit) return hit;
    }
    return null;
  }
  if (predicate(node)) return node;
  for (const value of Object.values(node)) {
    const hit = findNode(value, predicate);
    if (hit) return hit;
  }
  return null;
}

function findAll(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    node.forEach(item => findAll(item, predicate, out));
    return out;
  }
  if (predicate(node)) out.push(node);
  Object.values(node).forEach(value => findAll(value, predicate, out));
  return out;
}

/**
 * jsdom values carry that realm's prototypes, so deepStrictEqual rejects them
 * even when the structure matches. Round-trip through JSON to compare.
 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function readSource(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

module.exports = { ROOT, loadPure, loadPage, fixture, findNode, findAll, plain, readSource, CONTENT_SCRIPTS };
