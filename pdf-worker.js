(() => {
  'use strict';

  const START_MESSAGE = 'CGX_OFFSCREEN_START_PDF';
  const START_SMOKE_MESSAGE = 'CGX_OFFSCREEN_START_SMOKE';
  const STATUS_MESSAGE = 'CGX_OFFSCREEN_PDF_STATUS';
  const CLEANUP_MESSAGE = 'CGX_OFFSCREEN_RELEASE_PDF';
  const DOWNLOAD_MESSAGE = 'CGX_DOWNLOAD_PDF';
  const RENDER_FINISHED_MESSAGE = 'CGX_PDF_RENDER_FINISHED';
  const DOWNLOAD_STATE_MESSAGE = 'CGX_OFFSCREEN_DOWNLOAD_STATE';
  const PROGRESS_MESSAGE = 'CGX_PDF_PROGRESS';
  const activeUrls = new Set();
  const pendingDownloads = new Map();
  const jobStates = new Map();
  let currentJobId = null;

  const IMAGE_TIMEOUT_MS = 8000;
  const SVG_LOAD_TIMEOUT_MS = 6000;
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  const MAX_TOTAL_MEDIA_BYTES = 24 * 1024 * 1024;
  const MAX_SVG_CHARS = 2 * 1024 * 1024;
  const MAX_IMAGE_CONCURRENCY = 3;

  const FONT_FILES = Object.freeze({
    sinhala: ['NotoSansSinhala-Regular.ttf', 'vendor/fonts/NotoSansSinhala-Regular.ttf'],
    tamil: ['NotoSansTamil-Regular.ttf', 'vendor/fonts/NotoSansTamil-Regular.ttf'],
    mono: ['NotoSansMono-Regular.ttf', 'vendor/fonts/NotoSansMono-Regular.ttf'],
    symbols: ['NotoSansSymbols2-Regular.ttf', 'vendor/fonts/NotoSansSymbols2-Regular.ttf'],
    korean: ['NotoSansKR-Regular.woff2', 'vendor/fonts/NotoSansKR-Regular.woff2'],
    emoji: ['NotoEmoji-Regular.woff2', 'vendor/fonts/NotoEmoji-Regular.woff2']
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

  /**
   * Font for one code point inside preformatted text.
   *
   * NotoSansMono has no box-drawing or arrow glyphs, so forcing the whole
   * block to mono rendered diagrams as empty rectangles. Structural characters
   * are routed to the symbol font and non-Latin scripts to their own, while
   * everything else keeps the monospaced font that makes columns line up.
   */
  function preformattedFontKey(codePoint) {
    if (codePoint >= 0x0D80 && codePoint <= 0x0DFF) return 'sinhala';
    if (codePoint >= 0x0B80 && codePoint <= 0x0BFF) return 'tamil';
    if (
      (codePoint >= 0x1100 && codePoint <= 0x11FF) ||
      (codePoint >= 0x3130 && codePoint <= 0x318F) ||
      (codePoint >= 0xAC00 && codePoint <= 0xD7AF)
    ) return 'korean';
    if (codePoint >= 0x1F000 && codePoint <= 0x1FAFF) return 'emoji';

    // Routing here is driven by MEASURED glyph coverage of the bundled fonts,
    // not by what the Unicode block names suggest. NotoSansMono covers box
    // drawing (U+2500-257F), block elements, arrows and geometric shapes;
    // NotoSansSymbols2 does NOT, and sending them there rendered every diagram
    // as empty rectangles. tests/font-coverage.test.js enforces this.
    if (
      (codePoint >= 0x2600 && codePoint <= 0x27BF) || // dingbats, check marks
      (codePoint >= 0x2B00 && codePoint <= 0x2BFF)    // extra arrows and shapes
    ) return 'symbols';

    return 'mono';
  }

  /** Split one preformatted line into runs that each have a font with glyphs. */
  function monoRuns(line) {
    const runs = [];
    let current = null;
    for (const char of Array.from(String(line))) {
      const cp = char.codePointAt(0);
      // Variation selectors and ZWJ are shaping controls. pdfmake sometimes
      // asks the selected font to draw them as visible glyphs, producing tofu
      // squares. Preserve the surrounding base emoji/symbols and omit only the
      // default-ignorable controls from the PDF glyph stream.
      if (cp === 0x200D || cp === 0xFE0E || cp === 0xFE0F) continue;
      const key = preformattedFontKey(cp);
      if (current && current.__key === key) current.text += char;
      else {
        current = { text: char, font: FONT_NAMES[key] || 'NotoMono', __key: key };
        runs.push(current);
      }
    }
    return runs.length ? runs.map(({ text, font }) => ({ text, font })) : [{ text: '', font: 'NotoMono' }];
  }

  const loadedFontKeys = new Set();
  let fontLoadPromise = null;
  let mediaBytesUsed = 0;
  let activeImageTasks = 0;
  const imageWaiters = [];

  function bytesToBase64(bytes) {
    const parts = [];
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      parts.push(String.fromCharCode(...bytes.subarray(i, i + chunk)));
    }
    return btoa(parts.join(''));
  }

  function configureFonts() {
    const one = name => ({ normal:name, bold:name, italics:name, bolditalics:name });
    globalThis.pdfMake.fonts = {
      ...(globalThis.pdfMake.fonts || {}),
      Roboto: {
        normal: 'Roboto-Regular.ttf',
        bold: 'Roboto-Medium.ttf',
        italics: 'Roboto-Italic.ttf',
        bolditalics: 'Roboto-MediumItalic.ttf'
      },
      NotoSinhala: one('NotoSansSinhala-Regular.ttf'),
      NotoTamil: one('NotoSansTamil-Regular.ttf'),
      NotoKorean: one('NotoSansKR-Regular.woff2'),
      NotoSymbols: one('NotoSansSymbols2-Regular.ttf'),
      NotoEmoji: one('NotoEmoji-Regular.woff2'),
      NotoMono: one('NotoSansMono-Regular.ttf')
    };
  }

  function collectRequiredFontKeys(node, out = new Set()) {
    if (Array.isArray(node)) {
      node.forEach(item => collectRequiredFontKeys(item, out));
      return out;
    }
    if (!node || typeof node !== 'object') return out;
    if (typeof node.cgxFont === 'string' && node.cgxFont !== 'latin') out.add(node.cgxFont);
    if (node.cgxPreformatted) {
      out.add('mono');
      // Box drawing and arrows live in the symbol font, not the mono font.
      for (const char of Array.from(String(node.cgxPreformatted.text || ''))) {
        const key = preformattedFontKey(char.codePointAt(0));
        if (key !== 'mono') out.add(key);
      }
    }
    if (node.cgxMath || node.cgxMathInline) out.add('symbols');
    Object.values(node).forEach(value => collectRequiredFontKeys(value, out));
    return out;
  }

  async function ensureFonts(definition) {
    const required = [...collectRequiredFontKeys(definition)].filter(key => FONT_FILES[key] && !loadedFontKeys.has(key));
    if (!required.length) {
      configureFonts();
      return;
    }

    const load = async () => {
      const customVfs = {};
      await Promise.all(required.map(async key => {
        const [name, path] = FONT_FILES[key];
        const response = await fetch(chrome.runtime.getURL(path));
        if (!response.ok) throw new Error('Could not load bundled PDF font: ' + name);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!bytes.length) throw new Error('Bundled PDF font is empty: ' + name);
        customVfs[name] = bytesToBase64(bytes);
      }));

      // vfs_fonts.js exposes its Roboto VFS as globalThis.vfs. pdfmake's
      // addVirtualFileSystem replaces the active VFS in this bundled build,
      // so always re-register Roboto together with any lazily loaded fonts.
      const mergedVfs = {
        ...(globalThis.vfs || {}),
        ...customVfs
      };
      globalThis.vfs = mergedVfs;
      globalThis.pdfMake.addVirtualFileSystem(mergedVfs);
      required.forEach(key => loadedFontKeys.add(key));
      configureFonts();
    };

    const previous = fontLoadPromise || Promise.resolve();
    fontLoadPromise = previous.then(load);
    try {
      await fontLoadPromise;
    } catch (error) {
      fontLoadPromise = null;
      throw error;
    } finally {
      if (fontLoadPromise) fontLoadPromise = null;
    }
  }

  async function acquireImageSlot() {
    if (activeImageTasks < MAX_IMAGE_CONCURRENCY) {
      activeImageTasks += 1;
      return;
    }
    await new Promise(resolve => imageWaiters.push(resolve));
    activeImageTasks += 1;
  }

  function releaseImageSlot() {
    activeImageTasks = Math.max(0, activeImageTasks - 1);
    imageWaiters.shift()?.();
  }

  function reserveMediaBytes(bytes) {
    const next = mediaBytesUsed + Math.max(0, Number(bytes || 0));
    if (next > MAX_TOTAL_MEDIA_BYTES) throw new Error('PDF media budget exceeded.');
    mediaBytesUsed = next;
  }

  async function fetchBounded(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const declared = Number(response.headers.get('content-length') || 0);
      if (declared > MAX_IMAGE_BYTES) throw new Error('Image is too large.');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Image is too large.');
      reserveMediaBytes(bytes.length);
      return { response, bytes, type:String(response.headers.get('content-type') || '').toLowerCase() };
    } finally {
      clearTimeout(timer);
    }
  }

  function decodeSvgDataUrl(src) {
    const value = String(src || '');
    if (!value.startsWith('data:image/svg+xml')) return null;
    const comma = value.indexOf(',');
    if (comma < 0) return null;
    const meta = value.slice(0, comma);
    const body = value.slice(comma + 1);
    if (body.length > MAX_SVG_CHARS * 1.5) return null;
    try {
      const svg = /;base64/i.test(meta) ? atob(body) : decodeURIComponent(body);
      if (svg.length > MAX_SVG_CHARS) return null;
      reserveMediaBytes(svg.length);
      return svg;
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
    if (String(svg || '').length > MAX_SVG_CHARS) throw new Error('SVG is too large.');
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.decoding = 'async';
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          image.src = '';
          reject(new Error('SVG rasterization timed out.'));
        }, SVG_LOAD_TIMEOUT_MS);
        image.onload = () => { clearTimeout(timer); resolve(); };
        image.onerror = () => { clearTimeout(timer); reject(new Error('Unsupported SVG could not be rasterized.')); };
        image.src = url;
      });

      const naturalWidth = Math.max(1, image.naturalWidth || image.width || 1200);
      const naturalHeight = Math.max(1, image.naturalHeight || image.height || 800);
      const scale = Math.min(1, 1800 / naturalWidth, 1800 / naturalHeight);
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

  function fallbackImageNode(source, alt, margin) {
    return {
      text: alt,
      link: /^https?:/i.test(source) ? source : undefined,
      color: '#1E5A8A',
      decoration: /^https?:/i.test(source) ? 'underline' : undefined,
      margin: margin || [0, 3, 0, 7]
    };
  }

  async function resolveImageNode(node) {
    await acquireImageSlot();
    try {
      const source = String(node.cgxImage?.src || '');
      const alt = String(node.cgxImage?.alt || 'Image');
      const margin = node.margin || [0, 4, 0, 8];

      let svg = decodeSvgDataUrl(source);
      if (svg) {
        return svgNeedsRasterFallback(svg)
          ? { image: await rasterizeSvg(svg), fit: [500, 600], margin }
          : { svg, fit: [500, 600], margin };
      }

      if (/^data:image\/(?:png|jpe?g);base64,/i.test(source)) {
        if (source.length > MAX_IMAGE_BYTES * 1.5) return fallbackImageNode(source, alt, margin);
        reserveMediaBytes(Math.ceil(source.length * 0.75));
        return { image: source, fit: [500, 600], margin };
      }

      if (/^https:\/\//i.test(source)) {
        try {
          const { bytes, type } = await fetchBounded(source);
          if (type.includes('svg')) {
            svg = new TextDecoder().decode(bytes);
            if (svg.length > MAX_SVG_CHARS) throw new Error('SVG is too large.');
            return svgNeedsRasterFallback(svg)
              ? { image: await rasterizeSvg(svg), fit: [500, 600], margin }
              : { svg, fit: [500, 600], margin };
          }
          if (/image\/(?:png|jpeg|jpg)/i.test(type)) {
            const blob = new Blob([bytes], { type });
            return { image: await blobToDataUrl(blob), fit: [500, 600], margin };
          }
        } catch {}
      }

      return fallbackImageNode(source, alt, margin);
    } finally {
      releaseImageSlot();
    }
  }

  function mathPlain(node) {
    if (!node) return '';
    if (node.type === 'row') return node.children.map(mathPlain).join(' ');
    if (['ident','func','number','op','bigop','text'].includes(node.type)) return String(node.value || '');
    if (node.type === 'frac') return '(' + mathPlain(node.num) + ')/(' + mathPlain(node.den) + ')';
    if (node.type === 'sqrt') return '√(' + mathPlain(node.body) + ')';
    if (node.type === 'root') return mathPlain(node.degree) + '√(' + mathPlain(node.body) + ')';
    if (node.type === 'sup') return mathPlain(node.base) + '^(' + mathPlain(node.sup) + ')';
    if (node.type === 'sub') return mathPlain(node.base) + '_(' + mathPlain(node.sub) + ')';
    if (node.type === 'subsup') return mathPlain(node.base) + '_(' + mathPlain(node.sub) + ')^(' + mathPlain(node.sup) + ')';
    if (node.type === 'accent') return String(node.mark || '') + mathPlain(node.body);
    if (node.type === 'style') return mathPlain(node.body);
    if (node.type === 'matrix') return (node.left || '') + node.rows.map(row => row.map(mathPlain).join('  ')).join(' ; ') + (node.right || '');
    return '';
  }

  function mathNodeToPdf(node, depth = 0) {
    const fontSize = Math.max(7, 11 - depth * 0.7);
    const plain = value => ({ text: value, font:'NotoSymbols', fontSize, color:'#1F2937' });
    if (!node) return plain('');
    if (node.type === 'row') {
      return { columns: node.children.map(child => ({ width:'auto', ...mathNodeToPdf(child, depth) })), columnGap:2 };
    }
    if (['ident','func','number','op','bigop','text'].includes(node.type)) return plain(String(node.value || ''));
    if (node.type === 'frac') {
      return {
        stack: [
          { ...mathNodeToPdf(node.num, depth + 1), alignment:'center', margin:[2,0,2,1] },
          { canvas:[{ type:'line', x1:0, y1:0, x2:80, y2:0, lineWidth:0.7, lineColor:'#1F2937' }], alignment:'center' },
          { ...mathNodeToPdf(node.den, depth + 1), alignment:'center', margin:[2,1,2,0] }
        ],
        width:'auto'
      };
    }
    if (node.type === 'sqrt') {
      return { columns:[plain('√'), { width:'auto', ...mathNodeToPdf(node.body, depth + 1) }], columnGap:1 };
    }
    if (node.type === 'root') {
      return { columns:[{ text:mathPlain(node.degree), font:'NotoSymbols', fontSize:7, margin:[0,-2,0,0] }, plain('√'), { width:'auto', ...mathNodeToPdf(node.body, depth + 1) }], columnGap:1 };
    }
    if (node.type === 'sup' || node.type === 'sub' || node.type === 'subsup') {
      const script = [];
      if (node.type !== 'sub') script.push({ text:mathPlain(node.sup), font:'NotoSymbols', fontSize:7, margin:[0,-4,0,0] });
      if (node.type !== 'sup') script.push({ text:mathPlain(node.sub), font:'NotoSymbols', fontSize:7, margin:[0, node.type === 'subsup' ? -1 : 5, 0,0] });
      return { columns:[{ width:'auto', ...mathNodeToPdf(node.base, depth) }, { width:'auto', stack:script }], columnGap:1 };
    }
    if (node.type === 'matrix') {
      return {
        columns: [
          node.left ? plain(node.left) : { text:'' },
          { width:'auto', table:{ body:node.rows.map(row => row.map(cell => ({ ...mathNodeToPdf(cell, depth + 1), margin:[4,2,4,2] }))) }, layout:'noBorders' },
          node.right ? plain(node.right) : { text:'' }
        ],
        columnGap:2
      };
    }
    return plain(mathPlain(node));
  }

  function transformMathNode(spec) {
    const tex = String(spec?.tex || '');
    try {
      const ast = globalThis.ChatGPTMath?.parseTex ? globalThis.ChatGPTMath.parseTex(tex) : null;
      if (!ast) return { text:tex, font:'NotoSymbols' };
      if (spec?.display) {
        return { ...mathNodeToPdf(ast), alignment:'center', margin:[0,6,0,8] };
      }
      return { text:mathPlain(ast), font:'NotoSymbols', color:'#243142' };
    } catch {
      return { text:tex, font:'NotoSymbols', color:'#243142' };
    }
  }

  function preformattedFontSize(spec, pageSize) {
    // src/ir/pdf.js already decided the size: code is wrapped at a legible
    // floor, diagrams are shrunk to fit or sent to their own landscape page.
    if (Number(spec?.fontSize) > 0) return Number(spec.fontSize);
    const contentWidth = pageSize === 'A4' ? 493 : 510;
    const longest = Math.max(1, ...String(spec?.text || '').split('\n').map(line => Array.from(line).length));
    return Math.max(6, Math.min(spec?.diagram ? 8.3 : 8.5, contentWidth / (longest * 0.61)));
  }

  async function transformNode(node, pageSize = 'A4') {
    if (Array.isArray(node)) return Promise.all(node.map(item => transformNode(item, pageSize)));
    if (!node || typeof node !== 'object') return node;

    if (node.cgxRestoreOrientation) {
      return { text: '', pageBreak: 'after', pageOrientation: 'portrait' };
    }

    if (node.cgxPreformatted) {
      const spec = node.cgxPreformatted;
      const text = String(spec.text || '');
      const fontSize = preformattedFontSize(spec, pageSize);
      const contentWidth = (spec.landscape ? 700 : (pageSize === 'A4' ? 493 : 510)) - 14;
      const capacity = Math.floor(contentWidth / Math.max(0.1, fontSize * 0.605));

      // One node per line.
      //
      // pdfmake's `noWrap` puts the whole string on a single line, so a
      // multi-line diagram passed as one `text` collapsed into one row and was
      // then clipped at the page edge. Splitting first makes the line breaks
      // structural instead of depending on how `\n` interacts with noWrap.
      const lines = text.split('\n');
      const stack = lines.map(line => ({
        text: monoRuns(line.length ? line : ' '),
        // A line that cannot fit even at this size must wrap rather than be
        // silently truncated; the rest keep their exact columns.
        noWrap: Boolean(spec.diagram) && Array.from(line).length <= capacity,
        preserveLeadingSpaces: true,
        preserveTrailingSpaces: true
      }));

      const out = {
        stack,
        fontSize,
        lineHeight: spec.diagram ? 1.12 : 1.2,
        background: node.background || '#F4F6F8',
        margin: node.margin || [7, 6, 7, 8]
      };
      if (spec.landscape) {
        // A diagram too wide to shrink legibly gets its own landscape page
        // rather than being rendered at an unreadable size. The definition
        // emits a matching portrait restore node immediately after this one.
        return {
          stack: [out],
          pageBreak: 'before',
          pageOrientation: 'landscape'
        };
      }
      return out;
    }

    if (node.cgxMath) return transformMathNode(node.cgxMath);
    if (node.cgxMathInline) return transformMathNode({ ...node.cgxMathInline, display:false });
    if (node.cgxImage?.src) return resolveImageNode(node);

    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === 'cgxFont') out.font = FONT_NAMES[value] || 'Roboto';
      else out[key] = await transformNode(value, pageSize);
    }
    return out;
  }

  function getPdfBlob(doc) {
    return new Promise((resolve, reject) => {
      try {
        // Do not fake-cancel pdfmake with a Promise timeout. If pdfmake blocks
        // synchronously, a timer cannot interrupt it anyway. The browser-owned
        // watchdog in background.js destroys this offscreen context instead.
        globalThis.pdfMake.createPdf(doc).getBlob(resolve);
      } catch (error) {
        reject(error);
      }
    });
  }

  function emitProgress(jobId, stage, detail = '') {
    const existing = jobStates.get(String(jobId || ''));
    if (existing && existing.state !== 'done' && existing.state !== 'error') {
      jobStates.set(String(jobId), {
        ...existing,
        stage,
        stageDetail: detail,
        updatedAt: Date.now()
      });
    }
    chrome.runtime.sendMessage({
      type: PROGRESS_MESSAGE,
      jobId,
      stage,
      detail
    }).catch(() => {});
  }

  async function createPdfBlob(definition, jobId) {
    mediaBytesUsed = 0;
    emitProgress(jobId, 'fonts');
    await ensureFonts(definition || {});
    const pageSize = String(definition?.pageSize || 'A4');
    emitProgress(jobId, 'assets');
    const doc = await transformNode(definition || {}, pageSize);
    const footerLabel = String(definition?.cgxFooterLabel || 'AI Thread Exporter');
    doc.footer = (currentPage, pageCount) => ({
      columns: [
        { text: footerLabel, alignment: 'left' },
        { text: 'Page ' + currentPage + ' of ' + pageCount, alignment: 'right' }
      ],
      margin: [51, 10, 51, 0],
      fontSize: 8,
      color: '#64748B'
    });
    emitProgress(jobId, 'layout');
    const pdfPromise = getPdfBlob(doc);
    emitProgress(jobId, 'pdfmake-getblob');
    return pdfPromise;
  }

  function releaseUrl(url) {
    if (!activeUrls.delete(url)) return false;
    URL.revokeObjectURL(url);
    return true;
  }

  async function requestDownload(jobId, url, filename) {
    emitProgress(jobId, 'download');
    const response = await chrome.runtime.sendMessage({
      type: DOWNLOAD_MESSAGE,
      jobId,
      url,
      filename
    });
    if (!response?.ok || !Number.isInteger(response.downloadId)) {
      throw new Error(response?.error || 'Chrome could not start the PDF download.');
    }
    pendingDownloads.set(response.downloadId, { jobId, url });
    setTimeout(() => {
      const pending = pendingDownloads.get(response.downloadId);
      if (!pending || pending.url !== url) return;
      pendingDownloads.delete(response.downloadId);
      releaseUrl(url);
    }, 10 * 60 * 1000);
    return response;
  }

  function setJobState(jobId, state, extra = {}) {
    const snapshot = {
      jobId,
      state,
      updatedAt: Date.now(),
      ...extra
    };
    jobStates.set(jobId, snapshot);
    // Only the active job and a few recent terminal results are useful.
    if (jobStates.size > 8) {
      for (const [id, value] of jobStates) {
        if (id !== currentJobId && (value.state === 'done' || value.state === 'error')) {
          jobStates.delete(id);
          if (jobStates.size <= 8) break;
        }
      }
    }
    return snapshot;
  }

  function statusFor(jobId) {
    const state = jobStates.get(String(jobId || ''));
    if (!state) {
      return {
        ok: true,
        found: false,
        jobId: String(jobId || ''),
        activeJobId: currentJobId
      };
    }
    return {
      ok: true,
      found: true,
      ...state,
      engineDebug: globalThis.__cgxPdfDebug || '',
      activeJobId: currentJobId
    };
  }

  function acceptJob(request, smoke = false) {
    const jobId = String(request?.jobId || '').trim();
    if (!jobId) return { ok:false, error:'PDF export job id is missing.' };
    if (currentJobId) {
      return {
        ok:false,
        busy:true,
        jobId,
        activeJobId:currentJobId,
        error:'Another PDF export is already rendering. Please retry after it finishes.'
      };
    }

    currentJobId = jobId;
    setJobState(jobId, 'accepted', { smoke });
    setTimeout(() => {
      runPdfJob(request, smoke).catch(() => {});
    }, 0);
    return { ok:true, accepted:true, jobId };
  }

  async function runPdfJob(request, smoke = false) {
    const jobId = String(request.jobId);
    let url = '';
    try {
      setJobState(jobId, 'rendering', { smoke });
      emitProgress(jobId, 'render-started');
      const blob = await createPdfBlob(request.definition, jobId);
      if (!(blob instanceof Blob) || blob.size < 5) throw new Error('The PDF engine returned an empty file.');

      // The watchdog protects the expensive render only. Once a valid Blob
      // exists, clear it even if Save As waits for user interaction.
      await chrome.runtime.sendMessage({
        type: RENDER_FINISHED_MESSAGE,
        jobId
      }).catch(() => {});

      if (smoke) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        setJobState(jobId, 'done', {
          smoke:true,
          result:{
            bytes:bytes.length,
            magic:String.fromCharCode(...bytes.subarray(0, 4)),
            engine:'pdfmake-vector-unicode-v3'
          }
        });
        return;
      }

      url = URL.createObjectURL(blob);
      activeUrls.add(url);
      emitProgress(jobId, 'blob-ready', String(blob.size));
      setJobState(jobId, 'downloading', { smoke:false, bytes:blob.size });
      const download = await requestDownload(jobId, url, request.filename);
      setJobState(jobId, 'done', {
        smoke:false,
        result:{
          jobId,
          downloadId:download.downloadId,
          filename:download.filename,
          bytes:blob.size,
          engine:'pdfmake-vector-unicode-v3'
        }
      });
    } catch (error) {
      if (url) releaseUrl(url);
      setJobState(jobId, 'error', {
        smoke,
        error:error instanceof Error ? error.message : String(error)
      });
    } finally {
      if (currentJobId === jobId) currentJobId = null;
    }
  }

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request?.target !== 'cgx-offscreen-pdf') return;

    if (request.type === CLEANUP_MESSAGE) {
      sendResponse({ ok:true, released:releaseUrl(request.url) });
      return;
    }

    if (request.type === 'CGX_OFFSCREEN_WATCHDOG_FIRED') {
      if (currentJobId) {
        setJobState(currentJobId, 'error', {
          error: 'PDF rendering exceeded the safety deadline and the renderer was reset.'
        });
      }
      sendResponse({ ok: true });
      return;
    }

    if (request.type === STATUS_MESSAGE) {
      sendResponse(statusFor(request.jobId));
      return;
    }

    if (request.type === START_MESSAGE) {
      // Acknowledge immediately. Never hold a runtime message channel open
      // while pdfmake renders; Chrome may close long-lived response channels.
      sendResponse(acceptJob(request, false));
      return;
    }

    if (request.type === START_SMOKE_MESSAGE) {
      sendResponse(acceptJob(request, true));
      return;
    }

    if (request.type === DOWNLOAD_STATE_MESSAGE) {
      const pending = pendingDownloads.get(request.downloadId);
      if (!pending) {
        sendResponse({ ok:true, matched:false });
        return;
      }
      pendingDownloads.delete(request.downloadId);
      releaseUrl(pending.url);
      emitProgress(
        pending.jobId,
        request.state === 'complete' ? 'download-complete' : 'download-interrupted',
        request.error || ''
      );
      sendResponse({ ok:true, matched:true });
      return;
    }
  });
})();