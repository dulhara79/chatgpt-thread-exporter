(() => {
  'use strict';

  const DEBUGGER_VERSION = '1.3';
  const EXPORT_MESSAGE = 'CGX_EXPORT_PDF';
  const RENDER_PAGE = 'native-pdf-renderer.html';
  const TAB_READY_TIMEOUT_MS = 8000;
  const ASSET_WAIT_TIMEOUT_MS = 3500;
  const PRINT_TIMEOUT_MS = 45000;

  let renderQueue = Promise.resolve();

  function sanitizeFilename(name) {
    const cleaned = String(name || 'ChatGPT Conversation')
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    const base = (cleaned || 'ChatGPT Conversation').replace(/\.pdf$/i, '');
    return base + '.pdf';
  }

  function withTimeout(promise, timeoutMs, message) {
    let timer;
    return Promise.race([
      Promise.resolve(promise).finally(() => clearTimeout(timer)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  }

  async function waitForTabReady(tabId) {
    const initial = await chrome.tabs.get(tabId);
    if (initial?.status === 'complete') return;

    await withTimeout(new Promise((resolve, reject) => {
      const onUpdated = (updatedTabId, info) => {
        if (updatedTabId !== tabId || info.status !== 'complete') return;
        cleanup();
        resolve();
      };
      const onRemoved = removedTabId => {
        if (removedTabId !== tabId) return;
        cleanup();
        reject(new Error('The native PDF render tab closed unexpectedly.'));
      };
      const cleanup = () => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.onRemoved.removeListener(onRemoved);
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.onRemoved.addListener(onRemoved);
    }), TAB_READY_TIMEOUT_MS, 'The native PDF render tab did not become ready.');
  }

  async function waitForDocumentAssets(debuggee) {
    const expression = `(async () => {
      const deadline = 3500;
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

      try {
        if (document.fonts && document.fonts.ready) {
          await Promise.race([document.fonts.ready, sleep(deadline)]);
        }
      } catch {}

      try {
        const pending = Array.from(document.images || []).filter(img => !img.complete);
        if (pending.length) {
          await Promise.race([
            Promise.all(pending.map(img => new Promise(resolve => {
              let done = false;
              const finish = () => {
                if (done) return;
                done = true;
                resolve();
              };
              img.addEventListener('load', finish, { once: true });
              img.addEventListener('error', finish, { once: true });
            }))),
            sleep(deadline)
          ]);
        }
      } catch {}

      const style = document.createElement('style');
      style.setAttribute('data-cgx-native-print', 'true');
      style.textContent = '*{animation:none!important;transition:none!important;}html{scroll-behavior:auto!important;}';
      document.head.appendChild(style);

      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {
        images: (document.images || []).length,
        incompleteImages: Array.from(document.images || []).filter(img => !img.complete).length,
        height: Math.ceil(document.documentElement.scrollHeight || document.body?.scrollHeight || 0)
      };
    })()`;

    const result = await withTimeout(
      chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true
      }),
      ASSET_WAIT_TIMEOUT_MS + 2500,
      'The PDF document assets took too long to prepare.'
    );

    return result?.result?.value || {};
  }

  async function setDocumentHtml(debuggee, html) {
    await chrome.debugger.sendCommand(debuggee, 'Page.enable');
    await chrome.debugger.sendCommand(debuggee, 'Runtime.enable');

    const tree = await chrome.debugger.sendCommand(debuggee, 'Page.getFrameTree');
    const frameId = tree?.frameTree?.frame?.id;
    if (!frameId) throw new Error('Chrome could not identify the native PDF render frame.');

    await chrome.debugger.sendCommand(debuggee, 'Page.setDocumentContent', {
      frameId,
      html: String(html || '')
    });
  }

  async function renderNativePdf(html, filename) {
    let tab = null;
    let attached = false;
    const startedAt = Date.now();

    try {
      tab = await chrome.tabs.create({
        url: chrome.runtime.getURL(RENDER_PAGE),
        active: false
      });
      if (!tab?.id) throw new Error('Could not create the native PDF render tab.');

      await waitForTabReady(tab.id);

      const debuggee = { tabId: tab.id };
      await chrome.debugger.attach(debuggee, DEBUGGER_VERSION);
      attached = true;

      await setDocumentHtml(debuggee, html);
      const documentStats = await waitForDocumentAssets(debuggee);

      const pdf = await withTimeout(
        chrome.debugger.sendCommand(debuggee, 'Page.printToPDF', {
          printBackground: true,
          preferCSSPageSize: true,
          displayHeaderFooter: false,
          generateTaggedPDF: true,
          generateDocumentOutline: true,
          transferMode: 'ReturnAsBase64'
        }),
        PRINT_TIMEOUT_MS,
        'Chrome native PDF generation took too long.'
      );

      if (!pdf?.data) throw new Error('Chrome did not return PDF data.');

      const outputFilename = sanitizeFilename(filename);
      const downloadId = await chrome.downloads.download({
        url: 'data:application/pdf;base64,' + pdf.data,
        filename: outputFilename,
        conflictAction: 'uniquify',
        saveAs: true
      });

      if (!Number.isInteger(downloadId)) {
        throw new Error('Chrome could not open the PDF Save As dialog.');
      }

      return {
        ok: true,
        downloadId,
        filename: outputFilename,
        bytes: Math.floor(pdf.data.length * 0.75),
        renderMs: Date.now() - startedAt,
        documentHeight: Number(documentStats.height || 0),
        imageCount: Number(documentStats.images || 0),
        incompleteImages: Number(documentStats.incompleteImages || 0),
        engine: 'chrome-native-print'
      };
    } finally {
      if (tab?.id) {
        if (attached) {
          try { await chrome.debugger.detach({ tabId: tab.id }); } catch {}
        }
        try { await chrome.tabs.remove(tab.id); } catch {}
      }
    }
  }

  function enqueueRender(request) {
    const run = renderQueue
      .catch(() => {})
      .then(() => renderNativePdf(
        String(request.html || ''),
        String(request.filename || 'ChatGPT Conversation')
      ));

    renderQueue = run.catch(() => {});
    return run;
  }

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request?.type !== EXPORT_MESSAGE) return;

    enqueueRender(request)
      .then(sendResponse)
      .catch(error => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }));

    return true;
  });
})();