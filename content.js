/**
 * Content script.
 *
 * Knows nothing about ChatGPT or Claude directly: everything site-specific
 * comes from the platform adapter. UI lives in shadow roots so neither site's
 * stylesheet can reach it and we need no `!important` wall.
 */
(() => {
  'use strict';

  const registry = globalThis.ThreadExporterRegistry;
  const kit = globalThis.ThreadExporterAdapterKit;
  const extractor = globalThis.ThreadExporterExtract;
  const exporter = globalThis.ThreadExporter;
  const IR = globalThis.ThreadExporterIR;

  if (!registry || !kit || !extractor || !exporter) {
    console.error('[Thread Exporter] modules did not load.');
    return;
  }

  const adapter = registry.detect(location.href);
  if (!adapter) return;

  const HOST_ATTR = 'data-cgx-ui';
  const ANSWER_HOST_CLASS = 'cgx-answer-host';
  const THREAD_HOST_ID = 'cgx-thread-host';

  const settings = {
    pageSize: 'A4',
    defaultFormat: 'pdf',
    includeToc: true,
    embedImages: true,
    includeThinking: false,
    includeArtifacts: true
  };

  chrome.storage?.sync?.get(settings).then(stored => Object.assign(settings, stored || {})).catch(() => {});
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [key, change] of Object.entries(changes)) {
      if (key in settings) settings[key] = change.newValue;
    }
  });

  /** Options that every export format understands. */
  function exportOptions(pageSize) {
    return {
      pageSize,
      includeToc: settings.includeToc !== false,
      embedImages: settings.embedImages !== false
    };
  }

  // ------------------------------------------------------------------
  // Extraction
  // ------------------------------------------------------------------

  function messageFrom(node, role) {
    const body = adapter.messageBody(node) || node;
    const blocks = extractor.fromMessage(body, {
      artifacts: role === 'assistant' ? adapter.artifacts(node) : [],
      thinking: role === 'assistant' ? adapter.thinkingBlocks(node) : [],
      includeThinking: settings.includeThinking,
      includeArtifacts: settings.includeArtifacts
    });
    if (!blocks.length) return null;
    return { role, blocks, text: IR.blocksToPlainText(blocks) };
  }

  function turnFrom(container, index) {
    const userNode = adapter.userNode(container);
    if (!userNode) return null;
    const question = messageFrom(userNode, 'user');
    if (!question) return null;
    const answers = adapter.assistantNodes(container)
      .map(node => messageFrom(node, 'assistant'))
      .filter(Boolean);
    return {
      id: 'turn-' + (index + 1),
      index,
      key: adapter.stableKey(container),
      question,
      answers: answers.length ? answers : [{ role: 'assistant', blocks: [], text: '' }]
    };
  }

  function baseDocument() {
    return {
      title: adapter.conversationTitle(),
      url: location.href,
      platform: adapter.id,
      platformLabel: adapter.label,
      exportedAt: new Date().toISOString()
    };
  }

  /**
   * Full-thread extraction. For a virtualized platform this scrolls the whole
   * conversation into the DOM first and reports whether it managed to reach the
   * top — a partial export must never be silent (F-04).
   */
  async function extractConversation(options = {}) {
    let containers = adapter.turnContainers();
    let complete = true;

    if (adapter.virtualized) {
      const harvest = await adapter.ensureFullyLoaded({ onProgress: options.onProgress });
      if (harvest.containers?.length) containers = harvest.containers;
      complete = harvest.complete;
    }

    const turns = containers.map((container, index) => turnFrom(container, index)).filter(Boolean);
    return { ...baseDocument(), turns, complete };
  }

  function extractTurnsByKeys(keys) {
    const wanted = new Set(keys);
    const turns = adapter.turnContainers()
      .map((container, index) => ({ container, index }))
      .filter(entry => wanted.has(adapter.stableKey(entry.container)))
      .map(entry => turnFrom(entry.container, entry.index))
      .filter(Boolean);
    if (!turns.length) throw new Error('This answer changed while the export menu was open. Please try again.');
    return { ...baseDocument(), turns, complete: true };
  }

  // ------------------------------------------------------------------
  // Shadow-DOM UI
  // ------------------------------------------------------------------

  const CONTROL_CSS = `
    :host { all: initial; display: inline-flex; vertical-align: middle; font-family: ui-sans-serif, -apple-system, "Segoe UI", sans-serif; }
    button {
      display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
      font: 600 12.5px/1 ui-sans-serif, -apple-system, "Segoe UI", sans-serif;
      color: #0f172a; background: #ffffff; border: 1px solid rgba(15,23,42,.16);
      border-radius: 8px; padding: 6px 10px; min-height: 30px;
      transition: background-color .15s ease, border-color .15s ease;
    }
    button:hover:not(:disabled) { background: #f1f5f9; border-color: rgba(15,23,42,.28); }
    button:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
    button:disabled { opacity: .55; cursor: default; }
    button.selected { background: #e0ecff; border-color: #2563eb; }
    svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    @media (prefers-color-scheme: dark) {
      button { color: #e2e8f0; background: rgba(255,255,255,.06); border-color: rgba(255,255,255,.16); }
      button:hover:not(:disabled) { background: rgba(255,255,255,.12); }
      button.selected { background: rgba(59,130,246,.28); border-color: #60a5fa; }
    }
  `;

  const EXPORT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4"/><path d="M5 14.5V19a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4.5"/></svg>';

  function createControlHost(tagClass) {
    const host = document.createElement('span');
    host.className = tagClass;
    host.setAttribute(HOST_ATTR, 'true');
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CONTROL_CSS;
    const button = document.createElement('button');
    button.type = 'button';
    shadow.append(style, button);
    return { host, shadow, button };
  }

  // ------------------------------------------------------------------
  // Per-answer control
  // ------------------------------------------------------------------

  /** Turn keys currently marked for a range export (shift-click). */
  const selection = new Set();

  function footerRowFor(container, key) {
    const existing = Array.from(container.querySelectorAll(':scope > .cgx-answer-row'))
      .find(row => row.dataset.cgxKey === key);
    if (existing) return existing;

    const row = document.createElement('div');
    row.className = 'cgx-answer-row';
    row.setAttribute(HOST_ATTR, 'true');
    row.dataset.cgxKey = key;
    row.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin:6px 0 14px;';
    container.appendChild(row);
    return row;
  }

  function decorateTurn(container) {
    if (!(container instanceof Element) || !container.isConnected) return;
    const assistants = adapter.assistantNodes(container);
    if (!assistants.length) return;

    const key = adapter.stableKey(container);
    const row = footerRowFor(container, key);

    let control = row.querySelector('.' + ANSWER_HOST_CLASS);
    if (!control) {
      const created = createControlHost(ANSWER_HOST_CLASS);
      control = created.host;
      control.__cgx = created;
      row.appendChild(control);

      created.button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        const turnKey = control.dataset.cgxKey;

        if (event.shiftKey) {
          if (selection.has(turnKey)) selection.delete(turnKey);
          else selection.add(turnKey);
          refreshSelectionStyles();
          return;
        }

        const keys = selection.size ? Array.from(selection) : [turnKey];
        const heading = keys.length > 1 ? `Export ${keys.length} selected Q&A turns` : 'Export this Q&A';
        openMenu(control, heading, () => extractTurnsByKeys(keys));
      });
    }

    control.dataset.cgxKey = key;
    const { button } = control.__cgx;
    const streaming = assistants.some(node => adapter.isStreaming(node));

    button.disabled = streaming;
    button.setAttribute('aria-disabled', String(streaming));
    button.title = streaming
      ? 'Wait for the answer to finish generating'
      : 'Export this question and answer (shift-click to select a range)';
    button.setAttribute('aria-label', button.title);
    button.innerHTML = EXPORT_ICON + '<span>' + (streaming ? 'Generating…' : 'Export') + '</span>';
    button.classList.toggle('selected', selection.has(key));
  }

  function refreshSelectionStyles() {
    for (const host of document.querySelectorAll('.' + ANSWER_HOST_CLASS)) {
      const button = host.__cgx?.button;
      if (button) button.classList.toggle('selected', selection.has(host.dataset.cgxKey));
    }
  }

  // ------------------------------------------------------------------
  // Thread control
  // ------------------------------------------------------------------

  function decorateThread() {
    const anchor = adapter.headerAnchor();
    let host = document.getElementById(THREAD_HOST_ID);

    if (!host) {
      const created = createControlHost('cgx-thread-host');
      host = created.host;
      host.id = THREAD_HOST_ID;
      host.__cgx = created;
      host.style.marginRight = '6px';
      created.button.innerHTML = EXPORT_ICON + '<span>Export chat</span>';
      created.button.title = 'Export the entire conversation';
      created.button.setAttribute('aria-label', created.button.title);
      created.button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        selection.clear();
        refreshSelectionStyles();
        openMenu(host, 'Export entire conversation', progress => extractConversation({ onProgress: progress }));
      });
    }

    if (anchor?.parentElement) {
      if (host.nextElementSibling !== anchor) anchor.parentElement.insertBefore(host, anchor);
      return;
    }
    if (!host.isConnected) {
      const fallback = document.querySelector('header') || document.body;
      fallback.appendChild(host);
    }
  }

  // ------------------------------------------------------------------
  // Menu + toast
  // ------------------------------------------------------------------

  const MENU_CSS = `
    :host { all: initial; position: fixed; z-index: 2147483647; font-family: ui-sans-serif, -apple-system, "Segoe UI", sans-serif; }
    .menu { min-width: 268px; background: #fff; color: #0f172a; border: 1px solid rgba(15,23,42,.14);
      border-radius: 12px; box-shadow: 0 12px 32px rgba(15,23,42,.18); padding: 8px; }
    .heading { font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: #64748b; padding: 6px 8px 8px; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 8px 8px; font-size: 12px; color: #475569; }
    select { font: inherit; padding: 4px 6px; border-radius: 6px; border: 1px solid rgba(15,23,42,.18); background: #fff; color: inherit; }
    button.item { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; cursor: pointer;
      background: transparent; border: 0; border-radius: 8px; padding: 8px; color: inherit; font: inherit; }
    button.item:hover:not(:disabled) { background: #f1f5f9; }
    button.item:disabled { opacity: .5; cursor: default; }
    button.item strong { display: block; font-size: 13px; }
    button.item small { display: block; font-size: 11px; color: #64748b; }
    .warn { margin: 4px 8px 8px; padding: 6px 8px; border-radius: 6px; background: #fef3c7; color: #92400e; font-size: 11.5px; }
    @media (prefers-color-scheme: dark) {
      .menu { background: #1e293b; color: #e2e8f0; border-color: rgba(255,255,255,.14); }
      button.item:hover:not(:disabled) { background: rgba(255,255,255,.08); }
      select { background: #0f172a; border-color: rgba(255,255,255,.2); }
      .warn { background: #422006; color: #fde68a; }
    }
  `;

  let menuHost = null;
  let menuAbort = null;

  function closeMenu() {
    menuAbort?.abort();
    menuAbort = null;
    menuHost?.remove();
    menuHost = null;
  }

  function openMenu(anchorHost, heading, provider) {
    closeMenu();

    menuHost = document.createElement('div');
    menuHost.setAttribute(HOST_ATTR, 'true');
    const shadow = menuHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = MENU_CSS;

    const formatItems = {
      pdf: '<button class="item" data-format="pdf" role="menuitem"><span><strong>PDF document</strong><small>Print-ready, selectable text</small></span></button>',
      docx: '<button class="item" data-format="docx" role="menuitem"><span><strong>Microsoft Word</strong><small>Editable .docx with real list numbering</small></span></button>',
      md: '<button class="item" data-format="md" role="menuitem"><span><strong>Markdown</strong><small>Clean semantic .md file</small></span></button>'
    };
    const order = [settings.defaultFormat, 'pdf', 'docx', 'md']
      .filter((format, index, all) => formatItems[format] && all.indexOf(format) === index);

    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML =
      `<div class="heading">${heading}</div>` +
      '<div class="row"><span>Page size</span><select data-page-size>' +
      ['A4', 'Letter', 'Legal'].map(size =>
        `<option value="${size}"${size === settings.pageSize ? ' selected' : ''}>${size}</option>`).join('') +
      '</select></div>' +
      order.map(format => formatItems[format]).join('') +
      '<button class="item" data-format="copy" role="menuitem"><span><strong>Copy as Markdown</strong><small>Straight to the clipboard</small></span></button>';

    shadow.append(style, menu);
    document.body.appendChild(menuHost);

    const rect = anchorHost.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    let left = Math.min(rect.left, innerWidth - menuRect.width - 8);
    let top = rect.bottom + 8;
    if (top + menuRect.height > innerHeight - 8) top = Math.max(8, rect.top - menuRect.height - 8);
    menuHost.style.left = Math.round(Math.max(8, left)) + 'px';
    menuHost.style.top = Math.round(top) + 'px';

    menuAbort = new AbortController();

    menu.querySelectorAll('button[data-format]').forEach(item => {
      item.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();

        const format = item.dataset.format;
        const pageSize = menu.querySelector('[data-page-size]')?.value || 'A4';
        settings.pageSize = pageSize;
        chrome.storage?.sync?.set({ pageSize }).catch(() => {});

        const label = item.querySelector('strong');
        const original = label.textContent;
        const items = menu.querySelectorAll('button[data-format]');
        items.forEach(other => { other.disabled = true; });

        const setStage = text => { label.textContent = text; };

        try {
          const data = await provider(progress => {
            if (progress?.stage === 'harvest') setStage(`Loading conversation… ${progress.turns} turns`);
          });
          if (!data?.turns?.length) throw new Error('No question-and-answer content was found on this page.');

          if (data.complete === false) {
            const warn = document.createElement('div');
            warn.className = 'warn';
            warn.textContent = `Only ${data.turns.length} turns could be loaded from this thread. Scroll to the top and retry for a complete export.`;
            menu.appendChild(warn);
          }

          if (format === 'pdf') {
            const stages = {
              preflight: 'Checking PDF…', transfer: 'Sending to renderer…', rendering: 'Rendering PDF…',
              fonts: 'Loading fonts…', assets: 'Preparing media…', layout: 'Laying out pages…',
              'blob-ready': 'Opening Save As…', downloading: 'Opening Save As…', download: 'Opening Save As…'
            };
            await exporter.exportPdf(data, data.turns, {
              ...exportOptions(pageSize),
              onProgress: progress => setStage(stages[progress?.stage] || 'Rendering PDF…')
            });
          } else if (format === 'docx') {
            setStage('Building document…');
            await exporter.exportDocx(data, data.turns, exportOptions(pageSize));
          } else if (format === 'copy') {
            await exporter.copyMarkdown(data, data.turns);
          } else {
            exporter.exportMarkdown(data, data.turns);
          }

          const suffix = data.complete === false ? ' (partial)' : '';
          closeMenu();
          selection.clear();
          refreshSelectionStyles();
          toast(
            format === 'pdf' ? 'PDF Save As opened' + suffix + '.'
              : format === 'copy' ? 'Markdown copied to the clipboard' + suffix + '.'
                : `Exported ${data.turns.length} turn(s) as ${format === 'docx' ? 'Word' : 'Markdown'}${suffix}.`
          );
        } catch (error) {
          label.textContent = original;
          items.forEach(other => { other.disabled = false; });
          closeMenu();
          toast(error?.message || String(error), true);
        }
      }, { signal: menuAbort.signal });
    });

    requestAnimationFrame(() => {
      if (!menuAbort) return;
      document.addEventListener('pointerdown', event => {
        if (!menuHost?.contains(event.target) && !anchorHost.contains(event.target)) closeMenu();
      }, { capture: true, signal: menuAbort.signal });
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape') closeMenu();
      }, { signal: menuAbort.signal });
      window.addEventListener('resize', closeMenu, { once: true, signal: menuAbort.signal });
    });
  }

  function toast(message, isError = false) {
    document.querySelector('.cgx-toast-host')?.remove();
    const host = document.createElement('div');
    host.className = 'cgx-toast-host';
    host.setAttribute(HOST_ATTR, 'true');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<style>:host{all:initial;position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;}' +
      '.t{font:500 13px/1.4 ui-sans-serif,-apple-system,"Segoe UI",sans-serif;padding:10px 16px;border-radius:10px;' +
      'box-shadow:0 8px 24px rgba(15,23,42,.22);max-width:min(560px,90vw);}' +
      `.t{background:${isError ? '#7f1d1d' : '#0f172a'};color:#fff;}</style>` +
      `<div class="t"></div>`;
    shadow.querySelector('.t').textContent = message;
    document.body.appendChild(host);
    setTimeout(() => host.remove(), isError ? 6000 : 3400);
  }

  // ------------------------------------------------------------------
  // Scheduling
  // ------------------------------------------------------------------

  const pending = new Set();
  let fullPass = false;
  let frame = 0;
  let deadline = 0;

  function flush() {
    if (frame) cancelAnimationFrame(frame);
    if (deadline) clearTimeout(deadline);
    frame = 0;
    deadline = 0;

    if (fullPass) {
      fullPass = false;
      pending.clear();
      adapter.turnContainers().forEach(decorateTurn);
    } else {
      const roots = Array.from(pending);
      pending.clear();
      roots.forEach(decorateTurn);
    }
    decorateThread();
  }

  function schedule(mutations = null) {
    if (Array.isArray(mutations)) {
      for (const mutation of mutations) {
        const target = mutation.target instanceof Element ? mutation.target : null;
        if (!target) continue;
        if (target.closest?.('[' + HOST_ATTR + ']')) continue;
        const container = adapter.turnContainers().find(turn => turn === target || turn.contains(target));
        if (container) pending.add(container);
        else fullPass = true;
      }
    } else {
      fullPass = true;
    }
    if (!frame) frame = requestAnimationFrame(flush);
    if (!deadline) deadline = setTimeout(flush, 300);
  }

  const observer = new MutationObserver(schedule);

  function observe() {
    const root = adapter.conversationRoot() || document.body;
    observer.disconnect();
    // Scoped to the conversation, and without `style`, so token streaming does
    // not fire a flush on every animation frame (F-26).
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-is-streaming', 'data-message-id', 'data-testid']
    });
  }

  observe();
  schedule();
  setInterval(observe, 5000);
  window.addEventListener('popstate', () => schedule());
  window.addEventListener('hashchange', () => schedule());

  // ------------------------------------------------------------------
  // Messaging (popup + diagnostics)
  // ------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request?.type === 'CGX_EXTRACT') {
      extractConversation()
        .then(data => sendResponse({ ok: true, ...data }))
        .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }

    if (request?.type === 'CGX_DIAGNOSTICS') {
      sendResponse({
        ok: true,
        platform: adapter.id,
        virtualized: adapter.virtualized,
        turns: adapter.turnContainers().length,
        selectors: kit.diagnostics.snapshot(),
        userAgent: navigator.userAgent,
        version: chrome.runtime.getManifest().version
      });
      return true;
    }

    return undefined;
  });
})();
