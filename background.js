(() => {
  'use strict';

  const EXPORT_MESSAGE = 'CGX_EXPORT_PDF';
  const CANCEL_MESSAGE = 'CGX_CANCEL_PDF';
  const OFFSCREEN_URL = 'pdf-worker.html';
  const RENDER_MESSAGE = 'CGX_OFFSCREEN_RENDER_PDF';
  const CLEANUP_MESSAGE = 'CGX_OFFSCREEN_RELEASE_PDF';
  const RENDER_DEADLINE_MS = 45000;

  let creatingOffscreen = null;
  let resettingOffscreen = null;
  let runningJob = null;
  let draining = false;
  const jobQueue = [];
  const jobs = new Map();
  const pendingPdfUrls = new Map();

  function sanitizeFilename(name) {
    const cleaned = String(name || 'ChatGPT Conversation')
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    const base = (cleaned || 'ChatGPT Conversation').replace(/\.pdf$/i, '');
    return base + '.pdf';
  }

  function cancelledError(reason = 'PDF export was cancelled.') {
    const error = new Error(reason);
    error.name = 'AbortError';
    return error;
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
    if (globalThis.clients?.matchAll) {
      const clients = await globalThis.clients.matchAll({ includeUncontrolled: true, type: 'window' });
      return clients.some(client => client.url === url);
    }
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
      reasons: ['DOM_PARSER'],
      justification: 'Generate a local vector PDF without opening a tab or using debugger access.'
    });

    try {
      await creatingOffscreen;
    } catch (error) {
      // A service-worker restart can lose local state while the offscreen
      // document survives. Re-check before treating "already exists" as fatal.
      if (!(await hasOffscreenDocument())) throw error;
    } finally {
      creatingOffscreen = null;
    }
  }

  async function releasePdfUrl(url) {
    if (!url) return;
    try {
      await chrome.runtime.sendMessage({
        target: 'cgx-offscreen-pdf',
        type: CLEANUP_MESSAGE,
        url
      });
    } catch {}
  }

  function withDeadline(promise, ms, message) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  async function renderInWorker(job) {
    if (job.cancelled) throw cancelledError(job.cancelReason);
    await ensureOffscreenDocument();
    if (job.cancelled) throw cancelledError(job.cancelReason);

    try {
      return await withDeadline(
        chrome.runtime.sendMessage({
          target: 'cgx-offscreen-pdf',
          type: RENDER_MESSAGE,
          jobId: job.id,
          definition: job.request.definition || {},
          pageSize: String(job.request.pageSize || 'A4')
        }),
        RENDER_DEADLINE_MS,
        'PDF rendering exceeded the safety deadline.'
      );
    } catch (error) {
      // pdfmake cannot be safely interrupted from inside its synchronous
      // layout phase. Destroying the offscreen context is the hard-cancel
      // boundary and guarantees the next job starts with a clean renderer.
      await resetOffscreenDocument().catch(() => {});
      throw error;
    }
  }

  async function renderAndSavePdf(job) {
    const rendered = await renderInWorker(job);
    if (job.cancelled) {
      if (rendered?.url) await releasePdfUrl(rendered.url);
      throw cancelledError(job.cancelReason);
    }
    if (!rendered?.ok || !rendered.url) {
      throw new Error(rendered?.error || 'The local vector PDF renderer failed.');
    }

    const filename = sanitizeFilename(job.request.filename);
    try {
      const downloadId = await chrome.downloads.download({
        url: rendered.url,
        filename,
        conflictAction: 'uniquify',
        saveAs: true
      });

      if (!Number.isInteger(downloadId)) {
        throw new Error('Chrome could not open the Save As dialog.');
      }

      pendingPdfUrls.set(downloadId, rendered.url);
      setTimeout(async () => {
        if (pendingPdfUrls.get(downloadId) !== rendered.url) return;
        pendingPdfUrls.delete(downloadId);
        await releasePdfUrl(rendered.url);
      }, 5 * 60 * 1000);

      return {
        ok: true,
        jobId: job.id,
        downloadId,
        filename,
        bytes: Number(rendered.bytes || 0),
        engine: rendered.engine || 'pdfmake-vector'
      };
    } catch (error) {
      await releasePdfUrl(rendered.url);
      throw error;
    }
  }

  async function drainQueue() {
    if (draining) return;
    draining = true;
    try {
      while (jobQueue.length) {
        const job = jobQueue.shift();
        if (!job || job.settled) continue;
        if (job.cancelled) {
          job.settled = true;
          jobs.delete(job.id);
          job.reject(cancelledError(job.cancelReason));
          continue;
        }

        runningJob = job;
        try {
          const result = await renderAndSavePdf(job);
          if (job.cancelled) throw cancelledError(job.cancelReason);
          job.settled = true;
          job.resolve(result);
        } catch (error) {
          job.settled = true;
          job.reject(job.cancelled ? cancelledError(job.cancelReason) : error);
        } finally {
          jobs.delete(job.id);
          if (runningJob === job) runningJob = null;
        }
      }
    } finally {
      draining = false;
      if (jobQueue.some(job => !job.settled)) queueMicrotask(drainQueue);
    }
  }

  function enqueueRender(request) {
    const id = String(request.jobId || '').trim();
    if (!id) return Promise.reject(new Error('PDF export job id is missing.'));
    if (jobs.has(id)) return Promise.reject(new Error('Duplicate PDF export job id.'));

    return new Promise((resolve, reject) => {
      const job = {
        id,
        request,
        resolve,
        reject,
        cancelled: false,
        cancelReason: '',
        settled: false
      };
      jobs.set(id, job);
      jobQueue.push(job);
      drainQueue();
    });
  }

  async function cancelJob(jobId, reason = 'PDF export was cancelled.') {
    const job = jobs.get(String(jobId || ''));
    if (!job || job.settled) return { ok: true, cancelled: false };

    job.cancelled = true;
    job.cancelReason = reason;
    if (runningJob === job) {
      // This terminates a worker even if pdfmake is stuck in layout/getBlob.
      await resetOffscreenDocument().catch(() => {});
    }
    return { ok: true, cancelled: true };
  }

  chrome.downloads.onChanged.addListener(delta => {
    if (!delta?.id || !delta.state?.current) return;
    if (delta.state.current !== 'complete' && delta.state.current !== 'interrupted') return;

    const url = pendingPdfUrls.get(delta.id);
    if (!url) return;
    pendingPdfUrls.delete(delta.id);
    releasePdfUrl(url);
  });

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request?.target === 'cgx-offscreen-pdf') return;

    if (request?.type === CANCEL_MESSAGE) {
      cancelJob(request.jobId, request.reason)
        .then(sendResponse)
        .catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return true;
    }

    if (request?.type !== EXPORT_MESSAGE) return;

    enqueueRender(request)
      .then(sendResponse)
      .catch(error => sendResponse({
        ok: false,
        jobId: request.jobId,
        cancelled: error?.name === 'AbortError',
        error: error instanceof Error ? error.message : String(error)
      }));

    return true;
  });
})();