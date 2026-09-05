const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('cancelling a running PDF hard-resets the worker and the next queued export succeeds', async () => {
  const source = fs.readFileSync(require.resolve('../background.js'), 'utf8');

  let offscreenExists = false;
  let closeCount = 0;
  let workerCall = 0;
  let rejectPendingWorker = null;
  let runtimeListener = null;

  const chrome = {
    runtime: {
      getURL: path => 'chrome-extension://test/' + path,
      getContexts: async () => offscreenExists ? [{ contextType:'OFFSCREEN_DOCUMENT' }] : [],
      sendMessage: async request => {
        if (request?.target !== 'cgx-offscreen-pdf') throw new Error('unexpected internal message');
        if (request.type === 'CGX_OFFSCREEN_RELEASE_PDF') return { ok:true };
        workerCall += 1;
        if (workerCall === 1) {
          return new Promise((_, reject) => { rejectPendingWorker = reject; });
        }
        return {
          ok:true,
          jobId:request.jobId,
          url:'blob:test-' + request.jobId,
          bytes:2048,
          engine:'test'
        };
      },
      onMessage: {
        addListener(listener) { runtimeListener = listener; }
      }
    },
    offscreen: {
      async createDocument() { offscreenExists = true; },
      async closeDocument() {
        closeCount += 1;
        offscreenExists = false;
        rejectPendingWorker?.(new Error('offscreen closed'));
        rejectPendingWorker = null;
      }
    },
    downloads: {
      async download() { return 17; },
      onChanged: { addListener() {} }
    }
  };

  vm.runInNewContext(source, {
    chrome,
    globalThis: {},
    setTimeout,
    clearTimeout,
    queueMicrotask,
    Promise,
    Error,
    String,
    Number,
    Math,
    Map,
    Array
  });

  assert.equal(typeof runtimeListener, 'function');

  const dispatch = request => new Promise(resolve => {
    const keepOpen = runtimeListener(request, {}, resolve);
    if (keepOpen !== true) resolve(undefined);
  });

  const first = dispatch({
    type:'CGX_EXPORT_PDF',
    jobId:'job-1',
    definition:{ pageSize:'A4', content:[] },
    filename:'first',
    pageSize:'A4'
  });

  await new Promise(resolve => setTimeout(resolve, 0));

  const cancelled = await dispatch({
    type:'CGX_CANCEL_PDF',
    jobId:'job-1',
    reason:'test cancellation'
  });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.cancelled, true);

  const firstResult = await first;
  assert.equal(firstResult.ok, false);
  assert.equal(firstResult.cancelled, true);
  assert.match(firstResult.error, /test cancellation/);
  assert.ok(closeCount >= 1);

  const secondResult = await dispatch({
    type:'CGX_EXPORT_PDF',
    jobId:'job-2',
    definition:{ pageSize:'A4', content:[] },
    filename:'second',
    pageSize:'A4'
  });

  assert.equal(secondResult.ok, true);
  assert.equal(secondResult.jobId, 'job-2');
  assert.equal(secondResult.downloadId, 17);
});
