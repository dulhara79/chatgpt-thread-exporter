(() => {
  'use strict';

  const OFFSCREEN_URL = 'pdf-renderer.html';
  const EXPORT_MESSAGE = 'CGX_EXPORT_PDF';
  const RENDER_MESSAGE = 'CGX_OFFSCREEN_RENDER_PDF';
  const CLEANUP_MESSAGE = 'CGX_OFFSCREEN_RELEASE_PDF';

  let creatingOffscreen = null;
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
    const url = chrome.runtime.getURL(OFFSCREEN_URL);

    if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [url]
      });
      return contexts.length > 0;
    }

    const matchedClients = await self.clients.matchAll();
    return matchedClients.some(client => client.url === url);
  }

  async function ensureOffscreenDocument() {
    if (await hasOffscreenDocument()) return;
    if (creatingOffscreen) return creatingOffscreen;

    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['DOM_PARSER'],
      justification: 'Render ChatGPT conversation HTML into a local PDF without opening a tab or print preview.'
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
        target: 'cgx-offscreen',
        type: CLEANUP_MESSAGE,
        url
      });
    } catch {}
  }

  async function renderAndSavePdf(request) {
    await ensureOffscreenDocument();

    const rendered = await chrome.runtime.sendMessage({
      target: 'cgx-offscreen',
      type: RENDER_MESSAGE,
      html: String(request.html || ''),
      filename: String(request.filename || 'ChatGPT Conversation'),
      pageSize: String(request.pageSize || 'A4')
    });

    if (!rendered?.ok || !rendered.url) {
      throw new Error(rendered?.error || 'The local PDF renderer failed.');
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
        bytes: rendered.bytes || 0
      };
    } catch (error) {
      await releasePdfUrl(rendered.url);
      throw error;
    }
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
    if (request?.type !== EXPORT_MESSAGE || request?.target === 'cgx-offscreen') return;

    renderAndSavePdf(request)
      .then(sendResponse)
      .catch(error => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }));

    return true;
  });
})();
