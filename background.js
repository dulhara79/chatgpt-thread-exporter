(() => {
  'use strict';

  const SAVE_MESSAGE = 'CGX_SAVE_PDF';

  function sanitizeFilename(name) {
    const cleaned = String(name || 'ChatGPT Conversation')
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    const base = (cleaned || 'ChatGPT Conversation').replace(/\.pdf$/i, '');
    return base + '.pdf';
  }

  function trustedRenderer(sender) {
    const expected = chrome.runtime.getURL('pdf-renderer.html');
    return sender?.url === expected;
  }

  function trustedBlobUrl(url) {
    const extensionOrigin = chrome.runtime.getURL('').replace(/\/$/, '');
    return typeof url === 'string' && url.startsWith('blob:' + extensionOrigin + '/');
  }

  async function savePdf(request, sender) {
    if (!trustedRenderer(sender)) throw new Error('Untrusted PDF save request.');
    if (!trustedBlobUrl(request?.url)) throw new Error('Invalid generated PDF URL.');

    const filename = sanitizeFilename(request.filename);
    const downloadId = await chrome.downloads.download({
      url: request.url,
      filename,
      conflictAction: 'uniquify',
      saveAs: true
    });

    if (!Number.isInteger(downloadId)) throw new Error('Chrome could not open the Save As dialog.');
    return { ok: true, downloadId, filename };
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request?.type !== SAVE_MESSAGE) return;
    savePdf(request, sender)
      .then(sendResponse)
      .catch(error => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }));
    return true;
  });
})();
