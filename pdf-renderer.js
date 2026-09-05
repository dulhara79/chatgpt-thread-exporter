(() => {
  'use strict';

  const APP_NAME = 'ChatGPT Thread Exporter';
  const RENDER_MESSAGE = 'CGX_OFFSCREEN_RENDER_PDF';
  const CLEANUP_MESSAGE = 'CGX_OFFSCREEN_RELEASE_PDF';
  const root = document.getElementById('render-root');
  const activeUrls = new Set();

  const PAGE_MM = Object.freeze({
    A4: { width: 210, height: 297 },
    Letter: { width: 215.9, height: 279.4 },
    Legal: { width: 215.9, height: 355.6 }
  });

  const MARGIN_MM = 18;
  const UNIT_GAP_MM = 3;
  const MAX_SECTION_PX = 1350;
  const MAX_FRAGMENT_PX = 900;
  const MAX_BATCH_PX = 1800;
  const MAX_BATCH_UNITS = 4;
  const ASSET_WAIT_MS = 2500;
  const RENDER_WATCHDOG_MS = 22000;

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

    const runtimeStyle = document.createElement('style');
    runtimeStyle.dataset.cgxPdfStyle = 'true';
    runtimeStyle.textContent = [
      '.cgx-pdf-fragment { margin-bottom: 0 !important; padding-bottom: 0 !important; border-bottom: 0 !important; }',
      '.cgx-pdf-fragment .answer-header:first-child { margin-top: 0 !important; }',
      '.cgx-pdf-batch { width: 100%; margin: 0; padding: 0; background: #fff; }',
      '.cgx-pdf-batch > *:last-child { margin-bottom: 0 !important; }'
    ].join('\n');
    document.head.appendChild(runtimeStyle);

    const main = parsed.querySelector('main.document');
    if (!main) throw new Error('The PDF document could not be prepared.');

    root.replaceChildren(document.importNode(main, true));
    return root.querySelector('main.document');
  }

  async function waitForAssets(container, timeoutMs = ASSET_WAIT_MS) {
    try {
      if (document.fonts?.ready) {
        await Promise.race([
          document.fonts.ready,
          new Promise(resolve => setTimeout(resolve, timeoutMs))
        ]);
      }
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
        setTimeout(done, timeoutMs);
      });
    }));

    await new Promise(resolve => requestAnimationFrame(resolve));
  }

  function elementHeight(element) {
    const rect = element?.getBoundingClientRect?.();
    return Math.max(0, Number(rect?.height || element?.scrollHeight || 0));
  }

  function createSectionFragment() {
    const wrapper = document.createElement('section');
    wrapper.className = 'qa-section cgx-pdf-fragment';
    return wrapper;
  }

  function createAnswerFragment(answerHeader, blocks, includeHeader) {
    const wrapper = createSectionFragment();
    if (includeHeader && answerHeader) wrapper.appendChild(answerHeader.cloneNode(true));

    const answer = document.createElement('div');
    answer.className = 'answer-content';
    for (const block of blocks) answer.appendChild(block.cloneNode(true));
    wrapper.appendChild(answer);
    return wrapper;
  }

  function unit(node, height) {
    return {
      node,
      height: Math.max(40, Number(height || 0))
    };
  }

  function splitLargeSection(section) {
    const units = [];
    const label = section.querySelector(':scope > .section-label');
    const question = section.querySelector(':scope > .question-content');

    if (label || question) {
      const intro = createSectionFragment();
      let introHeight = 0;
      if (label) {
        intro.appendChild(label.cloneNode(true));
        introHeight += elementHeight(label);
      }
      if (question) {
        intro.appendChild(question.cloneNode(true));
        introHeight += elementHeight(question);
      }
      units.push(unit(intro, introHeight));
    }

    const children = Array.from(section.children);
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i];
      if (!child.classList.contains('answer-header')) continue;

      const answerHeader = child;
      const headerHeight = Math.max(32, elementHeight(answerHeader));
      const answerContent = children[i + 1]?.classList.contains('answer-content') ? children[i + 1] : null;

      if (!answerContent) {
        units.push(unit(createAnswerFragment(answerHeader, [], true), headerHeight));
        continue;
      }

      const blocks = Array.from(answerContent.children);
      if (!blocks.length) {
        const wrapper = createSectionFragment();
        wrapper.appendChild(answerHeader.cloneNode(true));
        wrapper.appendChild(answerContent.cloneNode(true));
        units.push(unit(wrapper, headerHeight + elementHeight(answerContent)));
        i += 1;
        continue;
      }

      let group = [];
      let groupHeight = 0;
      let includeHeader = true;

      for (const block of blocks) {
        const height = Math.max(24, elementHeight(block));
        if (group.length && groupHeight + height > MAX_FRAGMENT_PX) {
          units.push(unit(
            createAnswerFragment(answerHeader, group, includeHeader),
            groupHeight + (includeHeader ? headerHeight : 0)
          ));
          includeHeader = false;
          group = [];
          groupHeight = 0;
        }
        group.push(block);
        groupHeight += height;
      }

      if (group.length) {
        units.push(unit(
          createAnswerFragment(answerHeader, group, includeHeader),
          groupHeight + (includeHeader ? headerHeight : 0)
        ));
      }
      i += 1;
    }

    return units.length ? units : [unit(section.cloneNode(true), elementHeight(section))];
  }

  function collectRenderUnits(main) {
    const units = [];
    const header = main.querySelector(':scope > .document-header');
    if (header) units.push(unit(header.cloneNode(true), elementHeight(header)));

    for (const section of main.querySelectorAll(':scope > .qa-section')) {
      const height = elementHeight(section);
      if (height <= MAX_SECTION_PX) units.push(unit(section.cloneNode(true), height));
      else units.push(...splitLargeSection(section));
    }

    return units;
  }

  function packRenderBatches(units) {
    const batches = [];
    let current = [];
    let currentHeight = 0;

    const flush = () => {
      if (!current.length) return;
      batches.push(current);
      current = [];
      currentHeight = 0;
    };

    for (const item of units) {
      const nextHeight = currentHeight + item.height;
      if (
        current.length &&
        (nextHeight > MAX_BATCH_PX || current.length >= MAX_BATCH_UNITS)
      ) {
        flush();
      }
      current.push(item);
      currentHeight += item.height;
      if (item.height >= MAX_BATCH_PX) flush();
    }

    flush();
    return batches;
  }

  function createBatchNode(batch) {
    const wrapper = document.createElement('div');
    wrapper.className = 'cgx-pdf-batch';
    for (const item of batch) wrapper.appendChild(item.node.cloneNode(true));
    return wrapper;
  }

  function renderScale(batchCount) {
    if (batchCount >= 35) return 1.08;
    if (batchCount >= 20) return 1.16;
    if (batchCount >= 10) return 1.24;
    return 1.32;
  }

  function workerOptions(pageSize, scale) {
    return {
      margin: [MARGIN_MM, MARGIN_MM, MARGIN_MM, MARGIN_MM],
      image: { type: 'jpeg', quality: 0.92 },
      html2canvas: {
        scale,
        useCORS: true,
        allowTaint: false,
        backgroundColor: '#ffffff',
        logging: false,
        imageTimeout: ASSET_WAIT_MS,
        foreignObjectRendering: false,
        removeContainer: true
      },
      jsPDF: {
        unit: 'mm',
        format: jsPdfFormat(pageSize),
        orientation: 'portrait',
        compress: true,
        putOnlyUsedFonts: true
      },
      pagebreak: { mode: [] }
    };
  }

  function withWatchdog(promise, timeoutMs, message) {
    let timer;
    return Promise.race([
      promise.finally(() => clearTimeout(timer)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  }

  async function renderBatchCanvas(batch, pageSize, scale) {
    const element = createBatchNode(batch);
    root.replaceChildren(element);
    await waitForAssets(element);

    const renderPromise = (async () => {
      const worker = globalThis.html2pdf()
        .set(workerOptions(pageSize, scale))
        .from(element)
        .toCanvas();

      const canvas = await worker.get('canvas');
      if (!(canvas instanceof HTMLCanvasElement) || canvas.width < 2 || canvas.height < 2) {
        throw new Error('A PDF section could not be rendered.');
      }
      return canvas;
    })();

    try {
      return await withWatchdog(
        renderPromise,
        RENDER_WATCHDOG_MS,
        'A PDF section took too long to render.'
      );
    } finally {
      root.replaceChildren();
    }
  }

  async function renderBatchWithFallback(batch, pageSize, scale) {
    try {
      return await renderBatchCanvas(batch, pageSize, scale);
    } catch (error) {
      if (batch.length <= 1) throw error;

      const canvases = [];
      for (const item of batch) {
        const canvas = await renderBatchCanvas([item], pageSize, Math.max(0.95, scale - 0.12));
        canvases.push(canvas);
      }
      return canvases;
    }
  }

  function pageState(pageSize) {
    const page = PAGE_MM[pageSize] || PAGE_MM.A4;
    return {
      pageWidth: page.width,
      pageHeight: page.height,
      contentWidth: page.width - (MARGIN_MM * 2),
      contentHeight: page.height - (MARGIN_MM * 2),
      y: MARGIN_MM
    };
  }

  function addPage(pdf, state) {
    pdf.addPage();
    state.y = MARGIN_MM;
  }

  function addCanvasSlice(pdf, canvas, sx, sy, sw, sh, x, y, widthMm, heightMm) {
    const slice = document.createElement('canvas');
    slice.width = Math.max(1, Math.floor(sw));
    slice.height = Math.max(1, Math.floor(sh));

    const ctx = slice.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, slice.width, slice.height);
    ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, slice.width, slice.height);

    const image = slice.toDataURL('image/jpeg', 0.92);
    pdf.addImage(image, 'JPEG', x, y, widthMm, heightMm, undefined, 'FAST');

    slice.width = 1;
    slice.height = 1;
  }

  function appendCanvas(pdf, canvas, state, gapMm = UNIT_GAP_MM) {
    const x = MARGIN_MM;
    const widthMm = state.contentWidth;
    const totalHeightMm = canvas.height * widthMm / canvas.width;
    const bottom = state.pageHeight - MARGIN_MM;
    let remainingMm = bottom - state.y;

    if (totalHeightMm <= remainingMm) {
      const image = canvas.toDataURL('image/jpeg', 0.92);
      pdf.addImage(image, 'JPEG', x, state.y, widthMm, totalHeightMm, undefined, 'FAST');
      state.y += totalHeightMm + gapMm;
      return;
    }

    if (totalHeightMm <= state.contentHeight) {
      addPage(pdf, state);
      const image = canvas.toDataURL('image/jpeg', 0.92);
      pdf.addImage(image, 'JPEG', x, state.y, widthMm, totalHeightMm, undefined, 'FAST');
      state.y += totalHeightMm + gapMm;
      return;
    }

    let sourceY = 0;
    const pxPerMm = canvas.width / widthMm;

    while (sourceY < canvas.height) {
      remainingMm = bottom - state.y;
      if (remainingMm < 24) {
        addPage(pdf, state);
        remainingMm = bottom - state.y;
      }

      const remainingPx = canvas.height - sourceY;
      const maxSlicePx = Math.max(1, Math.floor(remainingMm * pxPerMm));
      const slicePx = Math.min(remainingPx, maxSlicePx);
      const sliceHeightMm = slicePx / pxPerMm;

      addCanvasSlice(
        pdf,
        canvas,
        0,
        sourceY,
        canvas.width,
        slicePx,
        x,
        state.y,
        widthMm,
        sliceHeightMm
      );

      sourceY += slicePx;
      state.y += sliceHeightMm;

      if (sourceY < canvas.height) addPage(pdf, state);
      else state.y += gapMm;
    }
  }

  function releaseCanvas(canvas) {
    if (!(canvas instanceof HTMLCanvasElement)) return;
    canvas.width = 1;
    canvas.height = 1;
  }

  function addProfessionalFooter(pdf) {
    const pageCount = pdf.internal.getNumberOfPages();
    for (let page = 1; page <= pageCount; page += 1) {
      pdf.setPage(page);
      const width = pdf.internal.pageSize.getWidth();
      const height = pdf.internal.pageSize.getHeight();

      pdf.setDrawColor(226, 232, 240);
      pdf.setLineWidth(0.2);
      pdf.line(MARGIN_MM, height - 12, width - MARGIN_MM, height - 12);

      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8);
      pdf.setTextColor(100, 116, 139);
      pdf.text(APP_NAME, MARGIN_MM, height - 7.5);
      pdf.text('Page ' + page + ' of ' + pageCount, width - MARGIN_MM, height - 7.5, { align: 'right' });
    }
  }

  async function renderPdf({ html, filename, pageSize }) {
    if (typeof globalThis.html2pdf !== 'function') {
      throw new Error('The local PDF engine did not load.');
    }

    const normalizedPageSize = normalizePageSize(pageSize);
    const main = cleanRenderDocument(html);

    // Load assets once while the source document exists, then clone bounded units.
    // The full conversation is removed before html2canvas starts, preventing it
    // from cloning the entire thread for every render pass.
    await waitForAssets(main);
    const units = collectRenderUnits(main);
    if (!units.length) throw new Error('No PDF content was found.');

    const batches = packRenderBatches(units);
    if (!batches.length) throw new Error('No PDF render batches were created.');

    root.replaceChildren();

    const scale = renderScale(batches.length);
    const state = pageState(normalizedPageSize);

    let first = await renderBatchWithFallback(batches[0], normalizedPageSize, scale);
    const firstCanvases = Array.isArray(first) ? first : [first];
    const firstCanvas = firstCanvases.shift();

    const seedWorker = globalThis.html2pdf()
      .set(workerOptions(normalizedPageSize, scale))
      .from(firstCanvas, 'canvas')
      .toPdf();

    const pdf = await seedWorker.get('pdf');
    const firstHeightMm = firstCanvas.height * state.contentWidth / firstCanvas.width;
    state.y = MARGIN_MM + firstHeightMm + UNIT_GAP_MM;
    releaseCanvas(firstCanvas);

    for (const canvas of firstCanvases) {
      appendCanvas(pdf, canvas, state);
      releaseCanvas(canvas);
    }

    for (let i = 1; i < batches.length; i += 1) {
      const rendered = await renderBatchWithFallback(batches[i], normalizedPageSize, scale);
      const canvases = Array.isArray(rendered) ? rendered : [rendered];

      for (const canvas of canvases) {
        appendCanvas(pdf, canvas, state);
        releaseCanvas(canvas);
      }

      if (i % 2 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }

    try {
      pdf.setProperties({
        title: String(filename || 'ChatGPT Conversation'),
        subject: 'ChatGPT conversation export',
        creator: APP_NAME
      });
    } catch {}

    addProfessionalFooter(pdf);

    const blob = pdf.output('blob');
    if (!(blob instanceof Blob) || blob.size === 0) {
      throw new Error('The PDF engine returned an empty file.');
    }

    const url = URL.createObjectURL(blob);
    activeUrls.add(url);

    setTimeout(() => {
      if (!activeUrls.delete(url)) return;
      URL.revokeObjectURL(url);
    }, 5 * 60 * 1000);

    return {
      ok: true,
      url,
      bytes: blob.size,
      renderUnits: units.length,
      renderBatches: batches.length
    };
  }

  function releaseUrl(url) {
    if (!activeUrls.delete(url)) return false;
    URL.revokeObjectURL(url);
    return true;
  }

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request?.target !== 'cgx-offscreen') return;

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
      }))
      .finally(() => {
        root.replaceChildren();
        document.querySelectorAll('style[data-cgx-pdf-style]').forEach(node => node.remove());
      });

    return true;
  });
})();