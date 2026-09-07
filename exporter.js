/**
 * Export orchestrator.
 *
 * Owns document naming, the DOCX package, the ZIP writer, and the PDF
 * transport. All block rendering lives in `src/ir/*`; this file no longer
 * parses Markdown and no longer knows which platform produced the conversation.
 */
(() => {
  'use strict';

  const DEFAULT_APP_NAME = 'AI Thread Exporter';
  const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  const IR = globalThis.ThreadExporterIR;
  const MD = globalThis.ThreadExporterMarkdown;
  const PDFIR = globalThis.ThreadExporterPdfIR;
  const DOCXIR = globalThis.ThreadExporterDocxIR;
  const mathRenderer = globalThis.ChatGPTMath || null;

  const MAX_PDF_SOURCE_BYTES = 24 * 1024 * 1024;
  const MAX_PDF_DEFINITION_BYTES = 36 * 1024 * 1024;
  const MAX_PDF_DEFINITION_NODES = 120000;

  const PAGE_SIZES = Object.freeze({
    A4: { css: 'A4', width: 11906, height: 16838 },
    Letter: { css: 'Letter', width: 12240, height: 15840 },
    Legal: { css: 'Legal', width: 12240, height: 20160 }
  });

  function normalizePageSize(value) {
    const key = String(value || 'A4').toLowerCase();
    if (key === 'letter') return 'Letter';
    if (key === 'legal') return 'Legal';
    return 'A4';
  }

  function shouldIncludeImage(meta = {}) {
    const src = String(meta.src || '').trim();
    if (!src || /^javascript:/i.test(src)) return false;
    const haystack = [src, meta.alt || '', meta.className || '', meta.role || ''].join(' ').toLowerCase();
    if (/google\.com\/s2\/favicons|favicon|apple-touch-icon|avatar|profile[-_ ]?image|toolbar[-_ ]?icon|tracking[-_ ]?pixel/.test(haystack)) return false;
    const width = Number(meta.width || 0);
    const height = Number(meta.height || 0);
    if (width > 0 && height > 0 && width <= 64 && height <= 64) return false;
    if (width > 0 && height > 0 && width * height < 4096) return false;
    return true;
  }

  function normalizeText(text) {
    return (text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function safeFilename(title, fallback = 'Conversation') {
    const cleaned = (title || fallback)
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100);
    return cleaned || fallback;
  }

  function appNameFor(data) {
    const label = data?.platformLabel || data?.platform;
    return label ? `${label} Thread Exporter` : DEFAULT_APP_NAME;
  }

  function documentTitle(data, turns) {
    const base = data?.title || `${data?.platformLabel || 'AI'} Conversation`;
    if (turns.length === 1 && Number.isFinite(turns[0].index)) return `${base} — Q&A ${turns[0].index + 1}`;
    return base;
  }

  function exportFilename(data, turns, extension) {
    let title = safeFilename(data?.title, `${data?.platformLabel || 'AI'} Conversation`);
    if (turns.length === 1 && Number.isFinite(turns[0].index)) title += ` - QA ${turns[0].index + 1}`;
    return extension ? `${title}.${extension}` : title;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    (document.body || document.documentElement).appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 6000);
  }

  /**
   * Turns arrive either with pre-extracted IR (`blocks`) from the content
   * script, or with only a Markdown string (legacy payloads, popup fallback,
   * tests). Normalise both to IR so every renderer sees one shape.
   */
  function blocksOf(message) {
    if (!message) return [];
    if (Array.isArray(message.blocks)) return message.blocks;
    return IR.parseBlocks(message.markdown || message.text || '');
  }

  function normalizeTurns(turns) {
    return (turns || []).map(turn => ({
      ...turn,
      question: { ...turn.question, blocks: blocksOf(turn.question) },
      answers: (turn.answers || []).map(answer => ({ ...answer, blocks: blocksOf(answer) }))
    }));
  }

  // ---------------- Markdown ----------------

  function createMarkdown(data, turns) {
    const prepared = normalizeTurns(turns);
    const lines = ['# ' + documentTitle(data, prepared), ''];

    prepared.forEach((turn, index) => {
      const n = Number.isFinite(turn.index) ? turn.index + 1 : index + 1;
      lines.push('## Question ' + n, '');
      lines.push(MD.blocksToMarkdown(turn.question.blocks).trimEnd(), '');

      const answers = turn.answers.filter(answer => answer.blocks.length);
      answers.forEach((answer, answerIndex) => {
        lines.push(answers.length > 1 ? '## Answer ' + (answerIndex + 1) : '## Answer', '');
        lines.push(MD.blocksToMarkdown(answer.blocks).trimEnd(), '');
      });

      if (index < prepared.length - 1) lines.push('---', '');
    });

    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  }

  // ---------------- PDF ----------------

  function buildPdfDefinition(data, turns, options = {}) {
    const prepared = normalizeTurns(turns);
    return PDFIR.buildDefinition(data, prepared, {
      ...options,
      pageSize: normalizePageSize(options.pageSize || 'A4'),
      appName: appNameFor(data),
      documentTitle: documentTitle(data, prepared)
    });
  }

  function jsonByteLength(value) {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  }

  function countPdfNodes(node) {
    if (Array.isArray(node)) return 1 + node.reduce((sum, item) => sum + countPdfNodes(item), 0);
    if (!node || typeof node !== 'object') return 1;
    return 1 + Object.values(node).reduce((sum, value) => sum + countPdfNodes(value), 0);
  }

  function preflightPdfSource(data, turns) {
    const bytes = jsonByteLength({ title: data?.title || '', turns: turns || [] });
    if (bytes > MAX_PDF_SOURCE_BYTES) {
      throw new Error('This conversation is too large to export safely as one PDF. Remove very large embedded images/diagrams or export fewer Q&A turns.');
    }
    return { sourceBytes: bytes };
  }

  function preflightPdfDefinition(definition) {
    const bytes = jsonByteLength(definition);
    const nodes = countPdfNodes(definition);
    if (bytes > MAX_PDF_DEFINITION_BYTES) {
      throw new Error('The generated PDF definition is too large for Chrome extension messaging. Export fewer Q&A turns or remove very large embedded diagrams.');
    }
    if (nodes > MAX_PDF_DEFINITION_NODES) {
      throw new Error('The conversation contains too many document elements for a reliable single PDF export. Export a smaller selection.');
    }
    return { definitionBytes: bytes, definitionNodes: nodes };
  }

  async function resetPdfRenderer() {
    try {
      await Promise.race([
        chrome.runtime.sendMessage({ type: 'CGX_RESET_PDF_WORKER' }),
        new Promise(resolve => setTimeout(resolve, 4000))
      ]);
    } catch {}
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function shortRuntimeMessage(message, timeoutMs = 1200) {
    const marker = Symbol('timeout');
    const result = await Promise.race([
      chrome.runtime.sendMessage(message).catch(error => ({ __cgxError: error })),
      delay(timeoutMs).then(() => marker)
    ]);
    if (result === marker) return { timedOut: true };
    if (result?.__cgxError) throw result.__cgxError;
    return { timedOut: false, response: result };
  }

  async function waitForPdfJob(jobId, overallTimeoutMs, options = {}) {
    const startedAt = Date.now();
    let lastStage = '';
    while (Date.now() - startedAt < overallTimeoutMs) {
      const check = await shortRuntimeMessage({
        target: 'cgx-offscreen-pdf',
        type: 'CGX_OFFSCREEN_PDF_STATUS',
        jobId
      }, 1000).catch(() => ({ timedOut: true }));

      if (!check.timedOut && check.response?.found) {
        const state = check.response.state || '';
        if (state && state !== lastStage) {
          lastStage = state;
          try { options.onProgress?.({ jobId, stage: state, detail: '' }); } catch {}
        }
        if (state === 'done') return check.response.result;
        if (state === 'error') throw new Error(check.response.error || 'The local PDF renderer failed.');
      }

      await delay(700);
    }
    throw new Error('PDF rendering exceeded the safety deadline. The renderer was reset so the next export can start cleanly.');
  }

  async function exportPdf(data, turns, options = {}) {
    if (!globalThis.chrome?.runtime?.sendMessage) {
      throw new Error('PDF export is only available inside the extension.');
    }

    const sourceMetrics = preflightPdfSource(data, turns);
    const pageSize = normalizePageSize(options.pageSize || 'A4');
    const definition = buildPdfDefinition(data, turns, { ...options, pageSize });
    const definitionMetrics = preflightPdfDefinition(definition);
    // F-02: a single-Q&A export must not reuse the whole-thread filename.
    const filename = exportFilename(data, turns, '');
    const jobId = 'pdf-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    // Deliberately longer than the service-worker watchdog, so the
    // browser-owned timer is always the authority that cancels a stuck render.
    const timeoutMs = Math.max(30000, Number(options.timeoutMs || 60000));

    const progressListener = request => {
      if (request?.type !== 'CGX_PDF_PROGRESS' || request.jobId !== jobId) return;
      try {
        options.onProgress?.({ jobId, stage: request.stage || '', detail: request.detail || '' });
      } catch {}
    };
    chrome.runtime.onMessage.addListener(progressListener);

    try {
      options.onProgress?.({ jobId, stage: 'preflight', detail: String(definitionMetrics.definitionBytes) });
      const prepared = await chrome.runtime.sendMessage({ type: 'CGX_PREPARE_PDF_WORKER', jobId });
      if (!prepared?.ok) throw new Error(prepared?.error || 'Could not prepare the local PDF renderer.');

      options.onProgress?.({ jobId, stage: 'transfer', detail: String(definitionMetrics.definitionBytes) });
      const accepted = await chrome.runtime.sendMessage({
        target: 'cgx-offscreen-pdf',
        type: 'CGX_OFFSCREEN_START_PDF',
        jobId,
        definition,
        filename,
        pageSize,
        metrics: { ...sourceMetrics, ...definitionMetrics }
      });

      if (!accepted?.ok || !accepted.accepted) {
        if (!accepted?.busy) await resetPdfRenderer();
        throw new Error(accepted?.error || 'The local PDF renderer did not accept the job.');
      }
      if (accepted.jobId !== jobId) {
        await resetPdfRenderer();
        throw new Error('Received a stale PDF job acknowledgement.');
      }

      options.onProgress?.({ jobId, stage: 'rendering', detail: '' });
      const result = await waitForPdfJob(jobId, timeoutMs, options);
      if (!result || result.jobId !== jobId) {
        await resetPdfRenderer();
        throw new Error('The PDF renderer returned an invalid job result.');
      }
      return result;
    } catch (error) {
      if (/safety deadline/i.test(String(error?.message || error))) await resetPdfRenderer();
      throw error;
    } finally {
      chrome.runtime.onMessage.removeListener(progressListener);
    }
  }

  // ---------------- ZIP ----------------

  let crcTable;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        crcTable[n] = c >>> 0;
      }
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  const u16 = value => new Uint8Array([value & 0xFF, (value >>> 8) & 0xFF]);
  const u32 = value => new Uint8Array([value & 0xFF, (value >>> 8) & 0xFF, (value >>> 16) & 0xFF, (value >>> 24) & 0xFF]);

  function concatBytes(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    return out;
  }

  function dosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    const time = ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() / 2) & 31);
    const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, day };
  }

  /** Raw DEFLATE via CompressionStream, falling back to store-only (F-12). */
  async function deflateRaw(bytes) {
    if (typeof CompressionStream !== 'function' || !bytes.length) return null;
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
      return compressed.length < bytes.length ? compressed : null;
    } catch {
      return null;
    }
  }

  async function zipBuild(files) {
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    const { time, day } = dosDateTime();

    for (const file of files) {
      const name = encoder.encode(file.name);
      const raw = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
      const crc = crc32(raw);
      const compressed = file.store ? null : await deflateRaw(raw);
      const payload = compressed || raw;
      const method = compressed ? 8 : 0;

      const local = concatBytes([
        u32(0x04034B50), u16(20), u16(0x0800), u16(method), u16(time), u16(day),
        u32(crc), u32(payload.length), u32(raw.length), u16(name.length), u16(0), name, payload
      ]);
      localParts.push(local);

      centralParts.push(concatBytes([
        u32(0x02014B50), u16(20), u16(20), u16(0x0800), u16(method), u16(time), u16(day),
        u32(crc), u32(payload.length), u32(raw.length), u16(name.length), u16(0), u16(0),
        u16(0), u16(0), u32(0), u32(offset), name
      ]));
      offset += local.length;
    }

    const central = concatBytes(centralParts);
    const locals = concatBytes(localParts);
    const end = concatBytes([
      u32(0x06054B50), u16(0), u16(0), u16(files.length), u16(files.length),
      u32(central.length), u32(locals.length), u16(0)
    ]);
    return concatBytes([locals, central, end]);
  }

  // ---------------- DOCX ----------------

  function collectImages(blocks, out) {
    const inline = node => {
      if (node.type === 'image' && node.src) out.set(node.src, { src: node.src, alt: node.alt || 'Image' });
      (node.children || []).forEach(inline);
    };
    for (const block of blocks || []) {
      if (block.type === 'image' && block.src) out.set(block.src, { src: block.src, alt: block.alt || 'Image' });
      (block.inline || []).forEach(inline);
      if (block.blocks) collectImages(block.blocks, out);
      if (block.items) block.items.forEach(item => collectImages(item.blocks, out));
      if (block.head) block.head.forEach(cell => collectImages(cell.blocks, out));
      if (block.rows) block.rows.forEach(row => row.forEach(cell => collectImages(cell.blocks, out)));
    }
    return out;
  }

  async function fetchImageAssets(turns) {
    const found = new Map();
    for (const turn of turns) {
      collectImages(turn.question.blocks, found);
      turn.answers.forEach(answer => collectImages(answer.blocks, found));
    }

    const assets = [];
    for (const item of found.values()) {
      if (!shouldIncludeImage({ src: item.src, alt: item.alt, width: 800, height: 500 })) continue;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const response = await fetch(item.src, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal });
        clearTimeout(timer);
        if (!response.ok) continue;
        if (Number(response.headers.get('content-length') || 0) > 8 * 1024 * 1024) continue;

        let blob = await response.blob();
        if (blob.size > 8 * 1024 * 1024) continue;
        let type = String(blob.type || '').toLowerCase();
        let width = 1000;
        let height = 625;

        if (type.includes('svg')) {
          try {
            const bitmap = await createImageBitmap(blob);
            width = bitmap.width || width;
            height = bitmap.height || height;
            const canvas = document.createElement('canvas');
            const scale = Math.min(1, 1800 / Math.max(1, width));
            canvas.width = Math.max(1, Math.round(width * scale));
            canvas.height = Math.max(1, Math.round(height * scale));
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            bitmap.close?.();
            blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png', 1));
            if (!blob) continue;
            type = 'image/png';
            width = canvas.width;
            height = canvas.height;
          } catch { continue; }
        } else {
          try {
            const bitmap = await createImageBitmap(blob);
            width = bitmap.width || width;
            height = bitmap.height || height;
            bitmap.close?.();
          } catch {}
        }

        const ext = type.includes('png') ? 'png'
          : (type.includes('jpeg') || type.includes('jpg')) ? 'jpg'
            : type.includes('gif') ? 'gif'
              : type.includes('webp') ? 'webp' : '';
        if (!ext) continue;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (!bytes.length) continue;
        assets.push({ src: item.src, alt: item.alt, bytes, ext, name: 'image' + (assets.length + 1) + '.' + ext, width, height });
      } catch {}
    }
    return assets;
  }

  async function createDocxBlob(data, turns, options = {}) {
    const prepared = normalizeTurns(turns);
    const title = documentTitle(data, prepared);
    const appName = appNameFor(data);
    const page = PAGE_SIZES[normalizePageSize(options.pageSize)];
    const { paragraph, run, blocksToXml, numberingXml, tocFieldXml, xmlEscape } = DOCXIR;

    const extraRels = [];
    const imageAssets = options.embedImages === false ? [] : await fetchImageAssets(prepared);
    const imageMap = new Map(imageAssets.map(asset => [asset.src, asset]));
    const numberingInstances = [];
    let relId = 10;
    let numId = 1;
    let docPrId = 100;

    const ctx = {
      hyperlinkRel(href) {
        const id = 'rId' + relId++;
        extraRels.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEscape(href)}" TargetMode="External"/>`);
        return id;
      },
      // One numbering instance per LIST, not per item (F-06).
      allocateNumbering(ordered, start) {
        const id = numId++;
        numberingInstances.push({ id, ordered, start });
        return id;
      },
      imageXml(token) {
        const asset = imageMap.get(token.src);
        if (!asset) {
          if (!/^https?:/i.test(token.src || '')) return run(token.alt || 'Image', { italic: true, color: '64748B' });
          const id = ctx.hyperlinkRel(token.src);
          return `<w:hyperlink r:id="${id}">${run(token.alt || 'Image', { color: '0563C1', underline: true })}</w:hyperlink>`;
        }
        if (!asset.relId) {
          asset.relId = 'rId' + relId++;
          extraRels.push(`<Relationship Id="${asset.relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${asset.name}"/>`);
        }
        const cx = Math.round(5.8 * 914400);
        const cy = Math.max(1, Math.round(cx * (asset.height / Math.max(1, asset.width))));
        const id = docPrId++;
        return '<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0">' +
          `<wp:extent cx="${cx}" cy="${cy}"/>` +
          `<wp:docPr id="${id}" name="${xmlEscape(asset.name)}" descr="${xmlEscape(token.alt || 'Image')}"/>` +
          '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
          '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
          `<pic:nvPicPr><pic:cNvPr id="0" name="${xmlEscape(asset.name)}"/><pic:cNvPicPr/></pic:nvPicPr>` +
          `<pic:blipFill><a:blip r:embed="${asset.relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
          `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
          '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
      },
      ommlInline(tex) {
        return mathRenderer?.toOmml ? mathRenderer.toOmml(tex) : run(tex);
      },
      ommlParagraph(tex) {
        return mathRenderer?.toOmmlParagraph ? mathRenderer.toOmmlParagraph(tex) : paragraph(run(tex));
      }
    };

    function boxed(contentXml) {
      return '<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>' +
        '<w:left w:val="single" w:sz="20" w:color="2E5B88"/><w:top w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/>' +
        '</w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="9360"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="9360" w:type="dxa"/>' +
        '<w:shd w:val="clear" w:color="auto" w:fill="F7F9FC"/><w:tcMar><w:top w:w="150" w:type="dxa"/><w:left w:w="180" w:type="dxa"/><w:bottom w:w="120" w:type="dxa"/><w:right w:w="180" w:type="dxa"/></w:tcMar>' +
        `</w:tcPr>${contentXml}</w:tc></w:tr></w:tbl>`;
    }

    const body = [];
    body.push(paragraph(run('CONVERSATION DOCUMENT'), { style: 'Kicker', keepNext: true }));
    body.push(paragraph(run(title), { style: 'Title', keepNext: true }));
    if (options.includeToc !== false && prepared.length >= 4) body.push(tocFieldXml());

    prepared.forEach((turn, index) => {
      const n = Number.isFinite(turn.index) ? turn.index + 1 : index + 1;
      body.push(paragraph(run(`QUESTION ${String(n).padStart(2, '0')}`), { style: 'SectionLabel', keepNext: true }));
      body.push(boxed(blocksToXml(turn.question.blocks, ctx, {}) || paragraph(' ')));

      const answers = turn.answers.filter(answer => answer.blocks.length);
      answers.forEach((answer, answerIndex) => {
        body.push(paragraph(
          run(answers.length > 1 ? `ANSWER ${String(answerIndex + 1).padStart(2, '0')}` : 'ANSWER'),
          { style: 'AnswerLabel', keepNext: true, before: 180 }
        ));
        body.push(blocksToXml(answer.blocks, ctx, {}));
      });

      if (index < prepared.length - 1) {
        body.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="8" w:color="D1D5DB"/></w:pBdr><w:spacing w:before="160" w:after="220"/></w:pPr></w:p>');
      }
    });

    const sectPr = '<w:sectPr>' +
      '<w:headerReference w:type="default" r:id="rId2"/>' +
      '<w:footerReference w:type="default" r:id="rId3"/>' +
      `<w:pgSz w:w="${page.width}" w:h="${page.height}"/>` +
      '<w:pgMar w:top="1077" w:right="964" w:bottom="1077" w:left="964" w:header="425" w:footer="425" w:gutter="0"/>' +
      '</w:sectPr>';

    const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
      'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">' +
      `<w:body>${body.join('')}${sectPr}</w:body></w:document>`;

    // Explicit outlineLvl so Word's Navigation Pane and the TOC field pick
    // headings up regardless of style-name inference (F-11).
    const headingStyle = (id, name, size, outline) =>
      `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:qFormat/>` +
      `<w:pPr><w:keepNext/><w:outlineLvl w:val="${outline}"/><w:spacing w:before="${200 - outline * 20}" w:after="90"/></w:pPr>` +
      `<w:rPr><w:b/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:color w:val="243142"/></w:rPr></w:style>`;

    const stylesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="Malgun Gothic" w:cs="Nirmala UI"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>' +
      '<w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="Malgun Gothic" w:cs="Nirmala UI"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:color w:val="243142"/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="40" w:after="260"/><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="42"/><w:szCs w:val="42"/><w:color w:val="183B56"/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Kicker"><w:name w:val="Kicker"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="90"/><w:keepNext/></w:pPr><w:rPr><w:b/><w:sz w:val="17"/><w:szCs w:val="17"/><w:color w:val="64748B"/><w:spacing w:val="20"/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="SectionLabel"><w:name w:val="Section Label"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="160" w:after="100"/><w:keepNext/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="17"/><w:szCs w:val="17"/><w:color w:val="5A6B7E"/><w:spacing w:val="16"/></w:rPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="AnswerLabel"><w:name w:val="Answer Label"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="220" w:after="100"/><w:keepNext/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="17"/><w:szCs w:val="17"/><w:color w:val="1E3A5F"/><w:spacing w:val="16"/></w:rPr></w:style>' +
      headingStyle('Heading2', 'heading 2', 28, 1) +
      headingStyle('Heading3', 'heading 3', 24, 2) +
      headingStyle('Heading4', 'heading 4', 22, 3) +
      '<w:style w:type="paragraph" w:styleId="CodeLabel"><w:name w:val="Code Label"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="100" w:after="50"/><w:keepNext/></w:pPr><w:rPr><w:b/><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="15"/><w:szCs w:val="15"/><w:color w:val="64748B"/></w:rPr></w:style>' +
      '</w:styles>';

    const headerXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="4" w:color="D1D5DB"/></w:pBdr><w:spacing w:after="60"/></w:pPr>' +
      run(appName.toUpperCase(), { bold: true, size: 15, color: '6B7280' }) + '</w:p></w:hdr>';

    const footerXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="right"/><w:pBdr><w:top w:val="single" w:sz="4" w:space="4" w:color="E5E7EB"/></w:pBdr><w:spacing w:before="60"/></w:pPr>' +
      run('Page ', { size: 16, color: '6B7280' }) +
      '<w:fldSimple w:instr="PAGE">' + run('1', { size: 16, color: '6B7280' }) + '</w:fldSimple>' +
      run(' of ', { size: 16, color: '6B7280' }) +
      '<w:fldSimple w:instr="NUMPAGES">' + run('1', { size: 16, color: '6B7280' }) + '</w:fldSimple>' +
      '</w:p></w:ftr>';

    const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="png" ContentType="image/png"/>' +
      '<Default Extension="jpg" ContentType="image/jpeg"/>' +
      '<Default Extension="jpeg" ContentType="image/jpeg"/>' +
      '<Default Extension="gif" ContentType="image/gif"/>' +
      '<Default Extension="webp" ContentType="image/webp"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
      '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' +
      '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' +
      '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
      '<Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
      '</Types>';

    const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
      '</Relationships>';

    const documentRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' +
      '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>' +
      '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' +
      '<Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/>' +
      extraRels.join('') + '</Relationships>';

    const settingsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:updateFields w:val="true"/><w:defaultTabStop w:val="720"/></w:settings>';

    const fontTableXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      ['Aptos', 'Consolas', 'Nirmala UI', 'Malgun Gothic', 'Segoe UI Symbol']
        .map(name => `<w:font w:name="${name}"><w:pitch w:val="variable"/></w:font>`).join('') +
      '</w:fonts>';

    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const coreXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      `<dc:title>${xmlEscape(title)}</dc:title>` +
      `<dc:subject>${xmlEscape((data.platformLabel || 'AI') + ' conversation export')}</dc:subject>` +
      `<dc:creator>${xmlEscape(appName)}</dc:creator>` +
      `<dc:description>Exported locally from ${xmlEscape(data.url || '')}</dc:description>` +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>` +
      `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>` +
      '</cp:coreProperties>';

    const wordCount = prepared.reduce((sum, turn) =>
      sum + IR.blocksToPlainText(turn.question.blocks).split(/\s+/).filter(Boolean).length +
      turn.answers.reduce((inner, answer) =>
        inner + IR.blocksToPlainText(answer.blocks).split(/\s+/).filter(Boolean).length, 0), 0);

    const appXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
      `<Application>${xmlEscape(appName)}</Application>` +
      `<Words>${wordCount}</Words>` +
      `<Paragraphs>${body.length}</Paragraphs>` +
      '<DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged>' +
      '</Properties>';

    const bytes = await zipBuild([
      { name: '[Content_Types].xml', data: contentTypes },
      { name: '_rels/.rels', data: rootRels },
      { name: 'docProps/core.xml', data: coreXml },
      { name: 'docProps/app.xml', data: appXml },
      { name: 'word/document.xml', data: documentXml },
      { name: 'word/styles.xml', data: stylesXml },
      { name: 'word/numbering.xml', data: numberingXml(numberingInstances) },
      { name: 'word/header1.xml', data: headerXml },
      { name: 'word/footer1.xml', data: footerXml },
      { name: 'word/settings.xml', data: settingsXml },
      { name: 'word/fontTable.xml', data: fontTableXml },
      { name: 'word/_rels/document.xml.rels', data: documentRels },
      // Already-compressed formats gain nothing from deflate.
      ...imageAssets.map(asset => ({ name: 'word/media/' + asset.name, data: asset.bytes, store: true }))
    ]);

    return new Blob([bytes], { type: MIME_DOCX });
  }

  function exportMarkdown(data, turns) {
    const blob = new Blob([createMarkdown(data, turns)], { type: 'text/markdown;charset=utf-8' });
    downloadBlob(blob, exportFilename(data, turns, 'md'));
  }

  async function exportDocx(data, turns, options = {}) {
    downloadBlob(await createDocxBlob(data, turns, options), exportFilename(data, turns, 'docx'));
  }

  function copyMarkdown(data, turns) {
    return navigator.clipboard.writeText(createMarkdown(data, turns));
  }

  const api = Object.freeze({
    normalizeText,
    normalizePageSize,
    shouldIncludeImage,
    PAGE_SIZES,
    safeFilename,
    exportFilename,
    documentTitle,
    normalizeTurns,
    createMarkdown,
    createDocxBlob,
    buildPdfDefinition,
    preflightPdfSource,
    preflightPdfDefinition,
    exportMarkdown,
    exportDocx,
    exportPdf,
    copyMarkdown,
    downloadBlob
  });

  globalThis.ThreadExporter = api;
  // Deprecated alias, kept for one release so nothing external breaks.
  globalThis.ChatGPTExporter = api;
})();
