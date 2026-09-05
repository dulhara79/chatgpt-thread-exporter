const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('service worker is a stateless offscreen/download bridge with durable watchdog', async () => {
  const source = fs.readFileSync(require.resolve('../background.js'), 'utf8');

  let offscreenExists = false;
  let closeCount = 0;
  let runtimeListener = null;
  let alarmListener = null;
  let downloadListener = null;
  let alarm = null;
  let forwardedDownloadState = null;

  const chrome = {
    runtime: {
      getURL: path => 'chrome-extension://test/' + path,
      getContexts: async () => offscreenExists ? [{ contextType:'OFFSCREEN_DOCUMENT' }] : [],
      sendMessage: async request => {
        if (request?.target === 'cgx-offscreen-pdf') {
          forwardedDownloadState = request;
          return { ok:true };
        }
        throw new Error('unexpected runtime message');
      },
      onMessage: { addListener(listener) { runtimeListener = listener; } }
    },
    offscreen: {
      async createDocument() { offscreenExists = true; },
      async closeDocument() { closeCount += 1; offscreenExists = false; }
    },
    alarms: {
      async get(name) {
        return alarm?.name === name ? alarm : undefined;
      },
      async clear(name) {
        const existed = alarm?.name === name;
        if (existed) alarm = null;
        return existed;
      },
      create(name, info) { alarm = { name, ...info }; },
      onAlarm: { addListener(listener) { alarmListener = listener; } }
    },
    downloads: {
      async download(options) {
        assert.equal(options.saveAs, true);
        assert.match(options.url, /^blob:/);
        return 42;
      },
      onChanged: { addListener(listener) { downloadListener = listener; } }
    }
  };

  vm.runInNewContext(source, {
    chrome,
    globalThis: {},
    Date,
    Promise,
    Error,
    String,
    Number,
    Map,
    Array
  });

  assert.equal(typeof runtimeListener, 'function');
  assert.equal(typeof alarmListener, 'function');
  assert.equal(typeof downloadListener, 'function');

  const dispatch = request => new Promise(resolve => {
    const keepOpen = runtimeListener(request, {}, resolve);
    if (keepOpen !== true) resolve(undefined);
  });

  const prepared = await dispatch({ type:'CGX_PREPARE_PDF_WORKER', jobId:'job-1' });
  assert.equal(prepared.ok, true);
  assert.equal(offscreenExists, true);
  assert.equal(alarm.name, 'cgx-pdf-render-watchdog');

  const started = await dispatch({
    type:'CGX_DOWNLOAD_PDF',
    jobId:'job-1',
    url:'blob:chrome-extension://test/pdf',
    filename:'Conversation'
  });
  assert.equal(started.ok, true);
  assert.equal(started.downloadId, 42);
  assert.equal(started.filename, 'Conversation.pdf');

  downloadListener({ id:42, state:{ current:'complete' } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(forwardedDownloadState.type, 'CGX_OFFSCREEN_DOWNLOAD_STATE');
  assert.equal(forwardedDownloadState.downloadId, 42);

  alarmListener({ name:'cgx-pdf-render-watchdog' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(closeCount, 1);
});

test('background no longer owns volatile PDF queue or retransmits document definition', () => {
  const source = fs.readFileSync(require.resolve('../background.js'), 'utf8');
  assert.doesNotMatch(source, /jobQueue|runningJob|draining|jobs\s*=\s*new Map/);
  assert.doesNotMatch(source, /definition:\s*job|CGX_OFFSCREEN_RENDER_PDF/);
  assert.match(source, /CGX_PREPARE_PDF_WORKER/);
  assert.match(source, /CGX_DOWNLOAD_PDF/);
  assert.match(source, /chrome\.alarms/);
  assert.match(source, /reasons:\s*\['BLOBS', 'DOM_PARSER'\]/);
});

test('offscreen renderer owns exclusivity and has no fake pdfmake callback timeout', () => {
  const source = fs.readFileSync(require.resolve('../pdf-worker.js'), 'utf8');
  assert.match(source, /let currentJobId = null/);
  assert.match(source, /Another PDF export is already rendering/);
  assert.match(source, /currentJobId = jobId/);
  assert.match(source, /currentJobId = null/);
  assert.doesNotMatch(source, /PDF_CALLBACK_TIMEOUT_MS|callback deadline/);
  assert.match(source, /CGX_PDF_RENDER_FINISHED/);
  assert.match(source, /CGX_DOWNLOAD_PDF/);
});
