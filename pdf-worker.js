(() => {
  'use strict';

  const RENDER_MESSAGE = 'CGX_OFFSCREEN_RENDER_PDF';
  const CLEANUP_MESSAGE = 'CGX_OFFSCREEN_RELEASE_PDF';
  const activeUrls = new Set();

  function rasterText(text, options = {}) {
    const value = String(text || '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/\*([^*\n]+)\*/g, '$1')
      .replace(/_([^_\n]+)_/g, '$1')
      .replace(/\x60([^\x60]+)\x60/g, '$1')
      .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1');

    const scale = 2;
    const width = 1100;
    const padding = 18;
    const fontSize = Math.max(18, Math.round((Number(options.fontSize || 10.5) * 96 / 72) * scale));
    const lineHeight = Math.round(fontSize * 1.48);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const weight = options.bold ? '700 ' : '';
    const family = '"Nirmala UI","Noto Sans Sinhala","Noto Sans Tamil","Malgun Gothic","Segoe UI",Arial,sans-serif';
    ctx.font = weight + fontSize + 'px ' + family;

    const maxTextWidth = width - padding * 2;
    const lines = [];
    for (const paragraph of value.split(/\n/)) {
      if (!paragraph) {
        lines.push('');
        continue;
      }
      const parts = paragraph.includes(' ') ? paragraph.split(/(\s+)/) : Array.from(paragraph);
      let line = '';
      for (const part of parts) {
        const candidate = line + part;
        if (line && ctx.measureText(candidate).width > maxTextWidth) {
          lines.push(line.trimEnd());
          line = part.trimStart();
        } else {
          line = candidate;
        }
      }
      lines.push(line);
    }

    canvas.width = width;
    canvas.height = Math.max(lineHeight + padding * 2, lines.length * lineHeight + padding * 2);
    const draw = canvas.getContext('2d', { alpha: false });
    draw.fillStyle = options.background || '#ffffff';
    draw.fillRect(0, 0, canvas.width, canvas.height);
    draw.fillStyle = options.color || '#243142';
    draw.font = weight + fontSize + 'px ' + family;
    draw.textBaseline = 'top';
    lines.forEach((line, index) => draw.fillText(line, padding, padding + index * lineHeight));

    return {
      image: canvas.toDataURL('image/png'),
      width: Number(options.width || 500),
      margin: options.margin || [0, 0, 0, 7]
    };
  }

  function decodeSvgDataUrl(src) {
    const value = String(src || '');
    if (!value.startsWith('data:image/svg+xml')) return null;
    const comma = value.indexOf(',');
    if (comma < 0) return null;
    const meta = value.slice(0, comma);
    const body = value.slice(comma + 1);
    try {
      return /;base64/i.test(meta) ? atob(body) : decodeURIComponent(body);
    } catch {
      return null;
    }
  }

  function transformNode(node) {
    if (Array.isArray(node)) return node.map(transformNode);
    if (!node || typeof node !== 'object') return node;

    if (Object.prototype.hasOwnProperty.call(node, 'cgxRasterText')) {
      return rasterText(node.cgxRasterText, node);
    }

    if (node.cgxImage?.src) {
      const src = String(node.cgxImage.src);
      const svg = decodeSvgDataUrl(src);
      if (svg) return { svg, fit: [500, 600], margin: node.margin || [0, 4, 0, 8] };
      if (/^data:image\/(?:png|jpe?g);base64,/i.test(src)) {
        return { image: src, fit: [500, 600], margin: node.margin || [0, 4, 0, 8] };
      }
      return { text: node.cgxImage.alt || 'Image', link: /^https?:/i.test(src) ? src : undefined, color: '#1E5A8A', margin: [0, 3, 0, 7] };
    }

    const out = {};
    for (const [key, value] of Object.entries(node)) out[key] = transformNode(value);
    return out;
  }

  function createPdfBlob(definition) {
    return new Promise((resolve, reject) => {
      try {
        const doc = transformNode(structuredClone(definition || {}));
        doc.footer = (currentPage, pageCount) => ({
          columns: [
            { text: 'ChatGPT Thread Exporter', alignment: 'left' },
            { text: 'Page ' + currentPage + ' of ' + pageCount, alignment: 'right' }
          ],
          margin: [51, 10, 51, 0],
          fontSize: 8,
          color: '#64748B'
        });
        globalThis.pdfMake.createPdf(doc).getBlob(resolve);
      } catch (error) {
        reject(error);
      }
    });
  }

  async function renderPdf(request) {
    if (!globalThis.pdfMake?.createPdf) throw new Error('The local vector PDF engine did not load.');
    const blob = await createPdfBlob(request.definition);
    if (!(blob instanceof Blob) || blob.size < 5) throw new Error('The PDF engine returned an empty file.');

    const url = URL.createObjectURL(blob);
    activeUrls.add(url);
    setTimeout(() => {
      if (!activeUrls.delete(url)) return;
      URL.revokeObjectURL(url);
    }, 5 * 60 * 1000);

    return { ok: true, url, bytes: blob.size, engine: 'pdfmake-vector' };
  }

  function releaseUrl(url) {
    if (!activeUrls.delete(url)) return false;
    URL.revokeObjectURL(url);
    return true;
  }

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request?.target !== 'cgx-offscreen-pdf') return;

    if (request.type === CLEANUP_MESSAGE) {
      sendResponse({ ok: true, released: releaseUrl(request.url) });
      return;
    }

    if (request.type !== RENDER_MESSAGE) return;
    renderPdf(request)
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  });
})();