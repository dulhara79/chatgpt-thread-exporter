/**
 * Architecture guards.
 *
 * These are deliberately NOT behaviour tests — they assert invariants that
 * cannot be observed from output, such as "we never ask for the debugger
 * permission". Behaviour belongs in ir-parse / adapters / renderers.
 *
 * Keep this file small. A grep assertion that duplicates something a behaviour
 * test already covers is a refactor tax with no safety benefit, which is what
 * the previous suite had become.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, readSource, CONTENT_SCRIPTS } = require('./helpers/harness.js');

const manifest = JSON.parse(readSource('manifest.json'));

test('manifest declares no high-risk permission', () => {
  const forbidden = ['debugger', 'tabCapture', 'management', 'proxy', 'nativeMessaging', '<all_urls>'];
  const requested = [...(manifest.permissions || []), ...(manifest.host_permissions || [])];
  for (const permission of forbidden) {
    assert.ok(!requested.includes(permission), 'must not request ' + permission);
  }
});

test('manifest matches both platforms and nothing broader', () => {
  const matches = manifest.content_scripts[0].matches;
  assert.ok(matches.includes('https://chatgpt.com/*'));
  assert.ok(matches.includes('https://claude.ai/*'));
  for (const pattern of matches) {
    assert.match(pattern, /^https:\/\/[a-z.*]+\/\*$/, 'no broad or http match patterns');
  }
  for (const pattern of matches) {
    assert.ok((manifest.host_permissions || []).includes(pattern),
      pattern + ' must also be granted as a host permission');
  }
});

test('every declared content script exists and parses', () => {
  const declared = manifest.content_scripts[0].js;
  assert.deepEqual(declared, CONTENT_SCRIPTS.concat('content.js'),
    'the test harness load order must mirror the manifest');
  for (const file of declared) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), 'missing: ' + file);
  }
});

test('offscreen worker loads every module it depends on', () => {
  const html = readSource('pdf-worker.html');
  for (const file of ['vendor/pdfmake.min.js', 'vendor/vfs_fonts.js', 'math.js', 'src/ir/parse.js', 'pdf-worker.js']) {
    assert.ok(html.includes(file), 'pdf-worker.html must load ' + file);
  }
});

test('no site-specific selector leaks outside src/platforms/', () => {
  // The whole point of the adapter layer: adding a third platform must not
  // require touching the renderers, the extractor, or the content script.
  const patterns = [/data-message-author-role/, /font-claude-response/, /data-test-render-count/, /conversation-turn/];
  const files = ['content.js', 'exporter.js', 'popup.js', 'options.js',
    'src/ir/parse.js', 'src/ir/extract.js', 'src/ir/markdown.js', 'src/ir/pdf.js', 'src/ir/docx.js'];

  for (const file of files) {
    const source = readSource(file);
    for (const pattern of patterns) {
      assert.ok(!pattern.test(source), file + ' must not contain the site selector ' + pattern);
    }
  }
});

test('no hard-coded platform branding outside the adapters', () => {
  for (const file of ['exporter.js', 'src/ir/pdf.js', 'src/ir/docx.js', 'pdf-worker.js']) {
    const source = readSource(file);
    assert.ok(!/ChatGPT Thread Exporter|ChatGPT Conversation/.test(source),
      file + ' must derive its product name from the adapter label');
  }
});

test('PDF rendering never uses a screenshot or remote pipeline', () => {
  const worker = readSource('pdf-worker.js');
  assert.ok(!/html2canvas|dom-to-image/.test(worker),
    'PDF text must stay selectable, not rasterised');
  assert.ok(worker.includes('pdfMake.createPdf'), 'rendering goes through the bundled pdfmake');

  // Fonts and the renderer must be local; a CDN would break offline use and
  // leak which conversations are exported.
  const html = readSource('pdf-worker.html');
  assert.ok(!/src="https?:/.test(html), 'the worker must not load remote scripts');
});

test('the service worker is the only holder of the download permission path', () => {
  const background = readSource('background.js');
  assert.ok(background.includes('chrome.downloads.download'), 'downloads happen in the service worker');
  assert.ok(background.includes('saveAs: true'), 'the user always picks the location');
  assert.ok(!readSource('content.js').includes('chrome.downloads'),
    'the content script must not touch the downloads API directly');
});

test('the watchdog fires before the client deadline gives up', () => {
  // If the client timed out first, a stuck renderer would be torn down by a
  // racing reset instead of by the browser-owned alarm (F-23).
  const watchdog = Number(/WATCHDOG_MS = (\d+)/.exec(readSource('background.js'))[1]);
  const client = Number(/options\.timeoutMs \|\| (\d+)/.exec(readSource('exporter.js'))[1]);
  assert.ok(watchdog < client, `watchdog (${watchdog}ms) must fire before the client deadline (${client}ms)`);
});

test('injected UI is isolated in a shadow root rather than by !important', () => {
  const content = readSource('content.js');
  assert.ok(content.includes('attachShadow'), 'controls live in a shadow root');
  assert.ok(!fs.existsSync(path.join(ROOT, 'content.css')),
    'the global stylesheet is obsolete now that the UI is shadow-scoped');
  assert.ok(!manifest.content_scripts[0].css, 'no page-level stylesheet is injected');
});

test('the MutationObserver is scoped and excludes style churn', () => {
  const content = readSource('content.js');
  assert.ok(!content.includes("observer.observe(document.documentElement"),
    'observing the whole document fires on every streamed token (F-26)');
  const filter = /attributeFilter: \[([^\]]*)\]/.exec(content)[1];
  assert.ok(!filter.includes("'style'"), 'style attributes churn constantly during streaming');
  assert.ok(!filter.includes("'class'"), 'class attributes churn constantly during streaming');
});

test('every adapter exposes a flat message list', () => {
  // Turn grouping is shared in the kit and driven by messages(); an adapter
  // that only exposes containers cannot pair answers on Claude's DOM.
  for (const file of ['src/platforms/chatgpt.js', 'src/platforms/claude.js']) {
    assert.match(readSource(file), /\n    messages\(\) \{/, file + ' must implement messages()');
  }
});

test('turn pairing does not assume a shared container', () => {
  const content = readSource('content.js');
  assert.ok(content.includes('kit.groupTurns'), 'content.js pairs via the shared grouper');
  assert.ok(!content.includes('turnsFromContainers'),
    'container-based pairing dropped answers on Claude');
});

test('version is consistent across manifest, package and popup', () => {
  const pkg = JSON.parse(readSource('package.json'));
  assert.equal(manifest.version, pkg.version, 'manifest and package.json versions must match');
  assert.ok(!/V0\.\d/.test(readSource('popup.html')),
    'popup must read its version from the manifest, not hard-code it');
});


test('settings diagnostics surface effective export settings and artifact capture state', () => {
  const options = readSource('options.js');
  assert.match(options, /effectiveSettings/,
    'Settings diagnostics must show whether artifact export is effectively enabled');
  assert.match(options, /artifactDiagnostics/,
    'Settings diagnostics must show artifact capture counts and failure reasons');
});


test('attachment capture failures are rendered into the exported conversation', () => {
  const content = readSource('content.js');
  assert.match(content, /__cgxAttachmentFailure/,
    'attachment failure metadata must reach the generic attachment-to-IR boundary');
  assert.match(content, /could not be read/i,
    'the exported document must explain an unreadable text attachment instead of emitting a blank label');
});
