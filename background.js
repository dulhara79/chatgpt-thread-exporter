(() => {
  'use strict';

  const OFFSCREEN_URL = 'pdf-worker.html';
  const PREPARE_MESSAGE = 'CGX_PREPARE_PDF_WORKER';
  const RESET_MESSAGE = 'CGX_RESET_PDF_WORKER';
  const DOWNLOAD_MESSAGE = 'CGX_DOWNLOAD_PDF';
  const RENDER_FINISHED_MESSAGE = 'CGX_PDF_RENDER_FINISHED';
  const DOWNLOAD_STATE_MESSAGE = 'CGX_OFFSCREEN_DOWNLOAD_STATE';
  const WATCHDOG_ALARM = 'cgx-pdf-render-watchdog';
  const WATCHDOG_MS = 45000;

  let creatingOffscreen = null;
  let resettingOffscreen = null;

  function sanitizeFilename(name) {
    const cleaned = String(name || 'Conversation')
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    const base = (cleaned || 'Conversation').replace(/\.pdf$/i, '');
    return base + '.pdf';
  }

  async function hasOffscreenDocument() {
    const url = chrome.runtime.getURL(OFFSCREEN_URL);
    if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [url]
      });
      return contexts.length > 0;
    }
    // chrome.runtime.getContexts is the only working path for offscreen
    // documents and is available in every Chrome the manifest supports (116+).
    return false;
  }

  async function closeOffscreenDocument() {
    creatingOffscreen = null;
    try {
      if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument();
    } catch (error) {
      if (!/No current offscreen document/i.test(String(error?.message || error))) throw error;
    }
  }

  async function resetOffscreenDocument() {
    if (resettingOffscreen) return resettingOffscreen;
    resettingOffscreen = (async () => {
      await chrome.alarms.clear(WATCHDOG_ALARM).catch(() => {});
      await closeOffscreenDocument();
    })();
    try {
      await resettingOffscreen;
    } finally {
      resettingOffscreen = null;
    }
  }

  async function ensureOffscreenDocument() {
    if (resettingOffscreen) await resettingOffscreen;
    if (await hasOffscreenDocument()) return;
    if (creatingOffscreen) return creatingOffscreen;

    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['BLOBS', 'DOM_PARSER'],
      justification: 'Generate a local vector PDF and own its Blob URL without opening a tab.'
    });

    try {
      await creatingOffscreen;
    } catch (error) {
      // The service worker may restart while the offscreen page survives.
      // Re-check the browser-owned context before treating "already exists" as fatal.
      if (!(await hasOffscreenDocument())) throw error;
    } finally {
      creatingOffscreen = null;
    }
  }

  async function armWatchdog({ replace = false } = {}) {
    const existing = await chrome.alarms.get(WATCHDOG_ALARM).catch(() => null);
    if (existing && !replace) return existing;
    if (replace) await chrome.alarms.clear(WATCHDOG_ALARM).catch(() => {});
    chrome.alarms.create(WATCHDOG_ALARM, { when: Date.now() + WATCHDOG_MS });
    return { name: WATCHDOG_ALARM };
  }

  async function prepareRenderer() {
    const existed = await hasOffscreenDocument();
    const existingWatchdog = await chrome.alarms.get(WATCHDOG_ALARM).catch(() => null);
    if (existed && existingWatchdog) {
      return {
        ok: false,
        busy: true,
        watchdogMs: WATCHDOG_MS,
        error: 'Another PDF export is still rendering. Please let it finish or retry after the renderer resets.'
      };
    }

    await ensureOffscreenDocument();
    // A stale alarm with no offscreen document must never kill a newly-created
    // renderer. An idle reused renderer gets a fresh deadline for this job.
    await armWatchdog({ replace: true });
    return { ok: true, watchdogMs: WATCHDOG_MS, reused: existed };
  }

  async function startDownload(request) {
    const url = String(request?.url || '');
    if (!url.startsWith('blob:')) throw new Error('PDF Blob URL is missing.');
    const filename = sanitizeFilename(request.filename);
    const downloadId = await chrome.downloads.download({
      url,
      filename,
      conflictAction: 'uniquify',
      saveAs: true
    });
    if (!Number.isInteger(downloadId)) throw new Error('Chrome could not open the Save As dialog.');
    return {
      ok: true,
      jobId: request.jobId,
      downloadId,
      filename
    };
  }

  async function forwardDownloadState(delta) {
    const state = delta?.state?.current;
    if (!Number.isInteger(delta?.id) || (state !== 'complete' && state !== 'interrupted')) return;
    try {
      await chrome.runtime.sendMessage({
        target: 'cgx-offscreen-pdf',
        type: DOWNLOAD_STATE_MESSAGE,
        downloadId: delta.id,
        state,
        error: delta?.error?.current || ''
      });
    } catch {}
  }

  chrome.downloads.onChanged.addListener(delta => {
    forwardDownloadState(delta);
  });

  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm?.name !== WATCHDOG_ALARM) return;
    // Tell the renderer why it is about to disappear, so the polling caller
    // sees a real error rather than only a client-side deadline.
    chrome.runtime.sendMessage({
      target: 'cgx-offscreen-pdf',
      type: 'CGX_OFFSCREEN_WATCHDOG_FIRED'
    }).catch(() => {});
    // The offscreen page is the render owner. If it has not cleared the
    // watchdog after producing a Blob, destroy the whole context. This is the
    // only reliable cancellation boundary for synchronous/non-interruptible
    // pdfmake work and survives service-worker restarts.
    closeOffscreenDocument().catch(() => {});
  });

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request?.target === 'cgx-offscreen-pdf') return;

    if (request?.type === PREPARE_MESSAGE) {
      prepareRenderer()
        .then(sendResponse)
        .catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return true;
    }

    if (request?.type === RESET_MESSAGE) {
      resetOffscreenDocument()
        .then(() => sendResponse({ ok: true, reset: true }))
        .catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return true;
    }

    if (request?.type === RENDER_FINISHED_MESSAGE) {
      chrome.alarms.clear(WATCHDOG_ALARM)
        .then(cleared => sendResponse({ ok: true, cleared }))
        .catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return true;
    }

    if (request?.type === DOWNLOAD_MESSAGE) {
      startDownload(request)
        .then(sendResponse)
        .catch(error => sendResponse({
          ok: false,
          jobId: request.jobId,
          error: error instanceof Error ? error.message : String(error)
        }));
      return true;
    }
  });
})();