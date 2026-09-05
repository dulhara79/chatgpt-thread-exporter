(() => {
  'use strict';

  const RENDER_MESSAGE = 'CGX_OFFSCREEN_RENDER_PDF';
  const CLEANUP_MESSAGE = 'CGX_OFFSCREEN_RELEASE_PDF';
  const activeUrls = new Set();

  const FONT_FILES = Object.freeze({
    'NotoSansSinhala-Regular.ttf': 'vendor/fonts/NotoSansSinhala-Regular.ttf',
    'NotoSansTamil-Regular.ttf': 'vendor/fonts/NotoSansTamil-Regular.ttf',
    'NotoSansMono-Regular.ttf': 'vendor/fonts/NotoSansMono-Regular.ttf',
    'NotoSansSymbols2-Regular.ttf': 'vendor/fonts/NotoSansSymbols2-Regular.ttf',
    'NotoSansKR-Regular.woff2': 'vendor/fonts/NotoSansKR-Regular.woff2',
    'NotoEmoji-Regular.woff2': 'vendor/fonts/NotoEmoji-Regular.woff2'
  });

  const FONT_NAMES = Object.freeze({
    latin: 'Roboto',
    sinhala: 'NotoSinhala',
    tamil: 'NotoTamil',
    korean: 'NotoKorean',
    symbols: 'NotoSymbols',
    emoji: 'NotoEmoji',
    mono: 'NotoMono'
  });

  let fontPromise = null;

  function bytesToBase64(bytes) {
    const parts = [];
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      parts.push(String.fromCharCode(...bytes.subarray(i, i + chunk)));
    }
    return btoa(parts.join(''));
  }

  async function ensureFonts() {
    if (fontPromise) return fontPromise;
    fontPromise = (async () => {
      const vfs = {};
      for (const [name, path] of Object.entries(FONT_FILES)) {
        const response = await fetch(chrome.runtime.getURL(path));
        if (!response.ok) throw new Error('Could not load bundled PDF font: ' + name);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!bytes.length) throw new Error('Bundled PDF font is empty: ' + name);
        vfs[name] = bytesToBase64(bytes);
      }

      globalThis.pdfMake.addVirtualFileSystem(vfs);
      globalThis.pdfMake.fonts = {
        ...(globalThis.pdfMake.fonts || {}),
        Roboto: {
          normal: 'Roboto-Regular.ttf',
          bold: 'Roboto-Medium.ttf',
          italics: 'Roboto-Italic.ttf',
          bolditalics: 'Roboto-MediumItalic.ttf'
        },
        NotoSinhala: {
          normal: 'NotoSansSinhala-Regular.ttf',
          bold: 'NotoSansSinhala-Regular.ttf',
          italics: 'NotoSansSinhala-Regular.ttf',
          bolditalics: 'NotoSansSinhala-Regular.ttf'
        },
        NotoTamil: {
          normal: 'NotoSansTamil-Regular.ttf',
          bold: 'NotoSansTamil-Regular.ttf',
          italics: 'NotoSansTamil-Regular.ttf',
          bolditalics: 'NotoSansTamil-Regular.ttf'
        },
        NotoKorean: {
          normal: 'NotoSansKR-Regular.woff2',
          bold: 'NotoSansKR-Regular.woff2',
          italics: 'NotoSansKR-Regular.woff2',
          bolditalics: 'NotoSansKR-Regular.woff2'
        },
        NotoSymbols: {
          normal: 'NotoSansSymbols2-Regular.ttf',
          bold: 'NotoSansSymbols2-Regular.ttf',
          italics: 'NotoSansSymbols2-Regular.ttf',
          bolditalics: 'NotoSansSymbols2-Regular.ttf'
        },
        NotoEmoji: {
          normal: 'NotoEmoji-Regular.woff2',
          bold: 'NotoEmoji-Regular.woff2',
          italics: 'NotoEmoji-Regular.woff2',
          bolditalics: 'NotoEmoji-Regular.woff2'
        },
        NotoMono: {
          normal: 'NotoSansMono-Regular.ttf',
          bold: 'NotoSansMono-Regular.ttf',
          italics: 'NotoSansMono-Regular.ttf',
          bolditalics: 'NotoSansMono-Regular.ttf'
        }
      };
    })();
    return fontPromise;
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
    return /<foreignObject\b|<filter\b|filter\s*=|<mask\b|<pattern\b|<video\b|<canvas\b/i.test(String(svg || ''));
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('Could not read image data.'));
      reader.readAsDataURL(blob);
    });
  }

  async function rasterizeSvg(svg) {
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.decoding = 'async';
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error('Unsupported SVG could not be rasterized.'));
        image.src = url;
      });

      const naturalWidth = Math.max(1, image.naturalWidth || image.width || 1200);
      const naturalHeight = Math.max(1, image.naturalHeight || image.height || 800);
      const scale = Math.min(1, 1800 / naturalWidth);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(naturalHeight * scale));
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png');
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function resolveImageNode(node) {
    const source = String(node.cgxImage?.src || '');
    const alt = String(node.cgxImage?.alt || 'Image');
    const margin = node.margin || [0, 4, 0, 8];

    let svg = decodeSvgDataUrl(source);
    if (svg) {
      if (svgNeedsRasterFallback(svg)) {
        return { image: await rasterizeSvg(svg), fit: [500, 600], margin };
      }
      return { svg, fit: [500, 600], margin };
    }

    if (/^data:image\/(?:png|jpe?g);base64,/i.test(source)) {
      return { image: source, fit: [500, 600], margin };
    }

    if (/^https:\/\//i.test(source)) {
      try {
        const response = await fetch(source, { credentials: 'omit', referrerPolicy: 'no-referrer' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const type = String(response.headers.get('content-type') || '').toLowerCase();

        if (type.includes('svg')) {
          svg = await response.text();
          if (svgNeedsRasterFallback(svg)) {
            return { image: await rasterizeSvg(svg), fit: [500, 600], margin };
          }
          return { svg, fit: [500, 600], margin };
        }

        const blob = await response.blob();
        if (/image\/(?:png|jpeg|jpg)/i.test(blob.type)) {
          return { image: await blobToDataUrl(blob), fit: [500, 600], margin };
        }
      } catch {}
    }

    return {
      text: alt,
      link: /^https?:/i.test(source) ? source : undefined,
      color: '#1E5A8A',
      decoration: /^https?:/i.test(source) ? 'underline' : undefined,
      margin: [0, 3, 0, 7]
    };
  }

  function preformattedFontSize(text, pageSize, diagram) {
    const contentWidth = pageSize === 'A4' ? 493 : 510;
    const longest = Math.max(1, ...String(text || '').split('\n').map(line => Array.from(line).length));
    const preferred = diagram ? 8.3 : 8.5;
    return Math.max(5.5, Math.min(preferred, contentWidth / (longest * 0.61)));
  }

  async function transformNode(node, pageSize = 'A4') {
    if (Array.isArray(node)) return Promise.all(node.map(item => transformNode(item, pageSize)));
    if (!node || typeof node !== 'object') return node;

    if (node.cgxPreformatted) {
      const spec = node.cgxPreformatted;
      const text = String(spec.text || '');
      return {
        text,
        font: 'NotoMono',
        fontSize: preformattedFontSize(text, pageSize, Boolean(spec.diagram)),
        lineHeight: spec.diagram ? 1.1 : 1.18,
        noWrap: true,
        preserveLeadingSpaces: true,
        preserveTrailingSpaces: true,
        background: node.background || '#F4F6F8',
        margin: node.margin || [7, 6, 7, 8]
      };
    }

    if (node.cgxImage?.src) return resolveImageNode(node);

    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === 'cgxFont') {
        out.font = FONT_NAMES[value] || 'Roboto';
      } else {
        out[key] = await transformNode(value, pageSize);
      }
    }
    return out;
  }

  async function createPdfBlob(definition) {
    await ensureFonts();
    const pageSize = String(definition?.pageSize || 'A4');
    const doc = await transformNode(structuredClone(definition || {}), pageSize);
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
    const blob = await createPdfBlob(request.definition);
    if (!(blob instanceof Blob) || blob.size < 5) throw new Error('The PDF engine returned an empty file.');

    const url = URL.createObjectURL(blob);
    activeUrls.add(url);
    setTimeout(() => {
      if (!activeUrls.delete(url)) return;
      URL.revokeObjectURL(url);
    }, 5 * 60 * 1000);

    return { ok: true, url, bytes: blob.size, engine: 'pdfmake-vector-unicode' };
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