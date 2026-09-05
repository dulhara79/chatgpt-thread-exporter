(() => {
  'use strict';

  const RENDER_MESSAGE = 'CGX_OFFSCREEN_RENDER_PDF';
  const CLEANUP_MESSAGE = 'CGX_OFFSCREEN_RELEASE_PDF';
  const activeUrls = new Set();

  function registerFonts() {
    if (!globalThis.pdfMake?.createPdf) return;
    const extra = globalThis.CGX_PDF_EXTRA_FONTS || {};
    globalThis.pdfMake.fonts = Object.assign({}, globalThis.pdfMake.fonts || {}, extra);
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

  function svgNeedsRasterFallback(svg) {
    const source = String(svg || '');
    return /<foreignObject\b/i.test(source) ||
      /<filter\b/i.test(source) ||
      /<fe[A-Z][^>]*>/i.test(source) ||
      /\bfilter\s*=/i.test(source) ||
      /\bvector-effect\s*=/i.test(source);
  }

  function svgDimensions(svg) {
    try {
      const doc = new DOMParser().parseFromString(String(svg || ''), 'image/svg+xml');
      const root = doc.documentElement;
      const parseNumber = value => {
        const match = String(value || '').match(/-?\d+(?:\.\d+)?/);
        return match ? Number(match[0]) : 0;
      };
      let width = parseNumber(root.getAttribute('width'));
      let height = parseNumber(root.getAttribute('height'));
      const viewBox = String(root.getAttribute('viewBox') || '').trim().split(/[ ,]+/).map(Number);
      if ((!width || !height) && viewBox.length === 4 && viewBox.every(Number.isFinite)) {
        width ||= Math.abs(viewBox[2]);
        height ||= Math.abs(viewBox[3]);
      }
      if (!width || !height) return { width: 1200, height: 750 };
      const scale = Math.min(1, 1800 / Math.max(width, height));
      return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale))
      };
    } catch {
      return { width: 1200, height: 750 };
    }
  }

  async function rasterizeSvgGraphic(svg) {
    const blob = new Blob([String(svg || '')], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error('SVG image could not be rendered.'));
        image.src = url;
      });

      const size = svgDimensions(svg);
      const canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png');
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function transformImageNode(node) {
    const src = String(node.cgxImage?.src || '');
    const originalSrc = String(node.cgxImage?.originalSrc || src);
    const alt = String(node.cgxImage?.alt || 'Image');
    const margin = node.margin || [0, 4, 0, 8];

    const svg = decodeSvgDataUrl(src);
    if (svg) {
      if (svgNeedsRasterFallback(svg)) {
        try {
          const png = await rasterizeSvgGraphic(svg);
          return { image: png, fit: [500, 600], margin };
        } catch {
          return {
            text: alt,
            link: /^https?:/i.test(originalSrc) ? originalSrc : undefined,
            color: '#1E5A8A',
            margin
          };
        }
      }
      return { svg, fit: [500, 600], margin };
    }

    if (/^data:image\/(?:png|jpe?g);base64,/i.test(src)) {
      return { image: src, fit: [500, 600], margin };
    }

    return {
      text: alt,
      link: /^https?:/i.test(originalSrc) ? originalSrc : undefined,
      color: '#1E5A8A',
      decoration: /^https?:/i.test(originalSrc) ? 'underline' : undefined,
      margin
    };
  }

  async function transformNode(node) {
    if (Array.isArray(node)) return Promise.all(node.map(transformNode));
    if (!node || typeof node !== 'object') return node;

    if (Object.prototype.hasOwnProperty.call(node, 'cgxImage')) {
      return transformImageNode(node);
    }

    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === 'cgxPreformattedDiagram') continue;
      out[key] = await transformNode(value);
    }
    return out;
  }

  async function createPdfBlob(definition) {
    registerFonts();
    const doc = await transformNode(structuredClone(definition || {}));
    doc.footer = (currentPage, pageCount) => ({
      columns: [
        { text: 'ChatGPT Thread Exporter', alignment: 'left' },
        { text: 'Page ' + currentPage + ' of ' + pageCount, alignment: 'right' }
      ],
      margin: [51, 10, 51, 0],
      fontSize: 8,
      color: '#64748B'
    });

    return new Promise((resolve, reject) => {
      try {
        globalThis.pdfMake.createPdf(doc).getBlob(resolve);
      } catch (error) {
        reject(error);
      }
    });
  }

  async function renderPdf(request) {
    if (!globalThis.pdfMake?.createPdf) throw new Error('The local vector PDF engine did not load.');
    if (!globalThis.CGX_PDF_EXTRA_FONTS) throw new Error('The multilingual PDF font bundle did not load.');

    const blob = await createPdfBlob(request.definition);
    if (!(blob instanceof Blob) || blob.size < 5) throw new Error('The PDF engine returned an empty file.');

    const url = URL.createObjectURL(blob);
    activeUrls.add(url);
    setTimeout(() => {
      if (!activeUrls.delete(url)) return;
      URL.revokeObjectURL(url);
    }, 5 * 60 * 1000);

    return { ok: true, url, bytes: blob.size, engine: 'pdfmake-vector-v039' };
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
      .catch(error => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }));
    return true;
  });
})();