(() => {
  'use strict';

  const EXPORT_MESSAGE = 'CGX_EXPORT_PDF';
  const OFFSCREEN_URL = 'pdf-worker.html';
  const RENDER_MESSAGE = 'CGX_OFFSCREEN_RENDER_PDF';
  const CLEANUP_MESSAGE = 'CGX_OFFSCREEN_RELEASE_PDF';

  let creatingOffscreen = null;
  let renderQueue = Promise.resolve();
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

  async function hasOffscreenDocument() {
    if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
      });
      return contexts.length > 0;
    }
    return false;
  }

  async function ensureOffscreenDocument() {
    if (await hasOffscreenDocument()) return;
    if (creatingOffscreen) return creatingOffscreen;

    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['DOM_PARSER'],
      justification: 'Generate a local vector PDF without opening a tab or using debugger access.'
    });

    try {
      await creatingOffscreen;
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

  async function renderAndSavePdf(request) {
    await ensureOffscreenDocument();

    const rendered = await chrome.runtime.sendMessage({
      target: 'cgx-offscreen-pdf',
      type: RENDER_MESSAGE,
      definition: request.definition || {},
      pageSize: String(request.pageSize || 'A4')
    });

    if (!rendered?.ok || !rendered.url) {
      throw new Error(rendered?.error || 'The local vector PDF renderer failed.');
    }

    const filename = sanitizeFilename(request.filename);
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

  function enqueueRender(request) {
    const run = renderQueue
      .catch(() => {})
      .then(() => renderAndSavePdf(request));
    renderQueue = run.catch(() => {});
    return run;
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
    if (request?.type !== EXPORT_MESSAGE || request?.target === 'cgx-offscreen-pdf') return;

    enqueueRender(request)
      .then(sendResponse)
      .catch(error => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }));

    return true;
  });
})();