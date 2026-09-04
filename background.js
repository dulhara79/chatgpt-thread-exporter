(() => {
  'use strict';

  const DEBUGGER_VERSION = '1.3';

  function sanitizeFilename(name) {
    const cleaned = String(name || 'ChatGPT Conversation')
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    return (cleaned || 'ChatGPT Conversation') + '.pdf';
  }

  async function waitForDocument(debuggee) {
    await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
      expression: `(async () => {
        try {
          if (document.fonts && document.fonts.ready) await document.fonts.ready;
          const images = Array.from(document.images || []);
          await Promise.all(images.map(img => {
            if (img.complete) return Promise.resolve();
            return new Promise(resolve => {
              const done = () => resolve();
              img.addEventListener('load', done, { once: true });
              img.addEventListener('error', done, { once: true });
              setTimeout(done, 5000);
            });
          }));
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        } catch {}
        return true;
      })()`,
      awaitPromise: true,
      returnByValue: true
    });
  }

  async function renderPdf(html, filename) {
    let tab = null;
    let attached = false;
    try {
      tab = await chrome.tabs.create({ url: 'about:blank', active: false });
      if (!tab?.id) throw new Error('Could not create the PDF render tab.');

      const debuggee = { tabId: tab.id };
      await chrome.debugger.attach(debuggee, DEBUGGER_VERSION);
      attached = true;

      await chrome.debugger.sendCommand(debuggee, 'Page.enable');
      await chrome.debugger.sendCommand(debuggee, 'Runtime.enable');

      await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
        expression: 'document.open();document.write(' + JSON.stringify(String(html || '')) + ');document.close();true;',
        returnByValue: true
      });

      await waitForDocument(debuggee);

      const result = await chrome.debugger.sendCommand(debuggee, 'Page.printToPDF', {
        printBackground: true,
        preferCSSPageSize: true,
        displayHeaderFooter: false,
        generateTaggedPDF: true,
        generateDocumentOutline: true,
        transferMode: 'ReturnAsBase64'
      });

      if (!result?.data) throw new Error('Chrome did not return PDF data.');

      const downloadId = await chrome.downloads.download({
        url: 'data:application/pdf;base64,' + result.data,
        filename: sanitizeFilename(filename),
        conflictAction: 'uniquify',
        saveAs: false
      });

      if (!Number.isInteger(downloadId)) throw new Error('Chrome could not start the PDF download.');
      return { ok: true, downloadId, filename: sanitizeFilename(filename) };
    } finally {
      if (tab?.id) {
        if (attached) {
          try { await chrome.debugger.detach({ tabId: tab.id }); } catch {}
        }
        try { await chrome.tabs.remove(tab.id); } catch {}
      }
    }
  }

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request?.type !== 'CGX_EXPORT_PDF') return;
    renderPdf(request.html, request.filename)
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  });
})();
