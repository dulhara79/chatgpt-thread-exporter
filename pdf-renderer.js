(() => {
  'use strict';

  const APP_NAME = 'ChatGPT Thread Exporter';
  const MESSAGE_RENDER = 'CGX_RENDER_PDF';
  const MESSAGE_RESULT = 'CGX_RENDER_PDF_RESULT';
  const SAVE_MESSAGE = 'CGX_SAVE_PDF';
  const root = document.getElementById('render-root');

  function extensionOrigin() {
    try { return new URL(chrome.runtime.getURL('/')).origin; }
    catch { return ''; }
  }

  function allowedParent(origin) {
    return origin === extensionOrigin() ||
      origin === 'https://chatgpt.com' ||
      origin === 'https://chat.openai.com';
  }

  function normalizePageSize(value) {
    const key = String(value || 'A4').toLowerCase();
    if (key === 'letter') return 'Letter';
    if (key === 'legal') return 'Legal';
    return 'A4';
  }

  function jsPdfFormat(pageSize) {
    if (pageSize === 'Letter') return 'letter';
    if (pageSize === 'Legal') return 'legal';
    return 'a4';
  }

  function cleanRenderDocument(html) {
    const parsed = new DOMParser().parseFromString(String(html || ''), 'text/html');
    parsed.querySelectorAll('script, iframe, object, embed, meta[http-equiv]').forEach(node => node.remove());

    document.querySelectorAll('style[data-cgx-pdf-style]').forEach(node => node.remove());
    for (const sourceStyle of parsed.head.querySelectorAll('style')) {
      const style = document.createElement('style');
      style.dataset.cgxPdfStyle = 'true';
      style.textContent = sourceStyle.textContent || '';
      document.head.appendChild(style);
    }

    const main = parsed.querySelector('main.document');
    if (!main) throw new Error('The PDF document could not be prepared.');

    root.replaceChildren(document.importNode(main, true));
    return root.querySelector('main.document');
  }

  async function waitForAssets(container) {
    try {
      if (document.fonts?.ready) await document.fonts.ready;
    } catch {}

    const images = Array.from(container.querySelectorAll('img'));
    await Promise.all(images.map(image => {
      if (image.complete) return Promise.resolve();
      return new Promise(resolve => {
        let finished = false;
        const done = () => {
          if (finished) return;
          finished = true;
          resolve();
        };
        image.addEventListener('load', done, { once: true });
        image.addEventListener('error', done, { once: true });
        setTimeout(done, 12000);
      });
    }));

    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  function addProfessionalFooter(pdf) {
    const pageCount = pdf.internal.getNumberOfPages();
    for (let page = 1; page <= pageCount; page += 1) {
      pdf.setPage(page);
      const width = pdf.internal.pageSize.getWidth();
      const height = pdf.internal.pageSize.getHeight();

      pdf.setDrawColor(226, 232, 240);
      pdf.setLineWidth(0.2);
      pdf.line(18, height - 12, width - 18, height - 12);

      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8);
      pdf.setTextColor(100, 116, 139);
      pdf.text(APP_NAME, 18, height - 7.5);
      pdf.text(`Page ${page} of ${pageCount}`, width - 18, height - 7.5, { align: 'right' });
    }
  }

  async function renderPdf({ html, filename, pageSize }) {
    if (typeof globalThis.html2pdf !== 'function') {
      throw new Error('The local PDF engine did not load.');
    }

    const normalizedPageSize = normalizePageSize(pageSize);
    const element = cleanRenderDocument(html);
    await waitForAssets(element);

    const worker = globalThis.html2pdf()
      .set({
        margin: [18, 18, 18, 18],
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: {
          scale: 2,
          useCORS: true,
          allowTaint: false,
          backgroundColor: '#ffffff',
          logging: false,
          imageTimeout: 15000,
          foreignObjectRendering: true
        },
        jsPDF: {
          unit: 'mm',
          format: jsPdfFormat(normalizedPageSize),
          orientation: 'portrait',
          compress: true,
          putOnlyUsedFonts: true
        },
        pagebreak: {
          mode: ['css', 'legacy'],
          avoid: ['.question-content', '.code-wrap', '.media', '.math-display', 'tr']
        }
      })
      .from(element)
      .toPdf();

    await worker.get('pdf').then(pdf => {
      try {
        pdf.setProperties({
          title: String(filename || 'ChatGPT Conversation'),
          subject: 'ChatGPT conversation export',
          creator: APP_NAME
        });
      } catch {}
      addProfessionalFooter(pdf);
    });

    const blob = await worker.outputPdf('blob');
    if (!(blob instanceof Blob) || blob.size === 0) throw new Error('The PDF engine returned an empty file.');

    const objectUrl = URL.createObjectURL(blob);
    try {
      const response = await chrome.runtime.sendMessage({
        type: SAVE_MESSAGE,
        url: objectUrl,
        filename: String(filename || 'ChatGPT Conversation')
      });
      if (!response?.ok) throw new Error(response?.error || 'Chrome could not open the Save As dialog.');
      return {
        ok: true,
        filename: response.filename,
        downloadId: response.downloadId,
        bytes: blob.size
      };
    } finally {
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    }
  }

  window.addEventListener('message', async event => {
    if (event.source !== window.parent || !allowedParent(event.origin)) return;
    const request = event.data;
    if (request?.type !== MESSAGE_RENDER || typeof request.requestId !== 'string') return;

    const target = event.source;
    const targetOrigin = event.origin;
    try {
      const result = await renderPdf(request);
      target.postMessage({ type: MESSAGE_RESULT, requestId: request.requestId, ...result }, targetOrigin);
    } catch (error) {
      target.postMessage({
        type: MESSAGE_RESULT,
        requestId: request.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }, targetOrigin);
    } finally {
      root.replaceChildren();
      document.querySelectorAll('style[data-cgx-pdf-style]').forEach(node => node.remove());
    }
  });
})();
