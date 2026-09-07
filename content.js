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

  async function messageFrom(node, role) {
    const body = adapter.messageBody(node) || node;
    const isAssistant = role === 'assistant';

    // Artifact bodies live in a side panel, so capturing them means opening
    // each one. Only done for assistant messages, and only when enabled.
    let artifacts = [];
    if (isAssistant && settings.includeArtifacts !== false) {
      artifacts = typeof adapter.captureArtifacts === 'function'
        ? await adapter.captureArtifacts(node)
        : adapter.artifacts(node);
    }

    const blocks = extractor.fromMessage(body, {
      artifacts,
      thinking: isAssistant ? adapter.thinkingBlocks(node) : [],
      includeThinking: settings.includeThinking,
      includeArtifacts: settings.includeArtifacts !== false
    });
    if (!blocks.length) return null;
    return { role, blocks, text: IR.blocksToPlainText(blocks) };
  }

  /** A question we could not parse still beats dropping the turn entirely. */
  function fallbackMessage(node, role) {
    const text = extractor.preservedText
      ? extractor.preservedText(node)
      : (node?.textContent || '');
    const clean = String(text || '').replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (!clean) return null;
    return {
      role,
      blocks: [{ type: 'paragraph', inline: [{ type: 'text', text: clean }] }],
      text: clean
    };
  }

  /**
   * Build one turn from a question node and its answer nodes.
   *
   * A turn survives if EITHER side has content. Previously a question that
   * failed to parse — a long pasted block, an attachment-only message —
   * discarded the answer with it, which is what produced
   * "No question-and-answer content was found on this page."
   */
  async function turnFrom(group, index) {
    const questionNode = group.question;
    const answerNodes = group.answers || [];

    let capturedAttachments = null;
    if (questionNode && typeof adapter.captureAttachments === 'function') {
      try {
        capturedAttachments = await adapter.captureAttachments(questionNode);
      } catch {
        capturedAttachments = null;
      }
    }

    let question = questionNode ? await messageFrom(questionNode, 'user') : null;

    // A pasted block or attachment card sits outside the message body, so the
    // body can parse to nothing while the message clearly has content. Read
    // the whole node rather than exporting an empty question section.
    if (questionNode && (!question || !question.text.trim())) {
      question = fallbackMessage(questionNode, 'user') || question;
    }

    const answers = [];
    for (const node of answerNodes) {
      let message = await messageFrom(node, 'assistant');
      if (!message) message = fallbackMessage(node, 'assistant');
      if (message) answers.push(message);
    }

    // Attachments and pasted files sit outside the message body.
    if (questionNode) {
      const existing = question ? question.text : '';
      const extras = attachmentBlocks(questionNode, capturedAttachments).filter(block => {
        // Skip anything the question body already contains verbatim.
        const text = IR.blocksToPlainText([block]).trim();
        return text && !(text.length > 24 && existing.includes(text));
      });
      if (extras.length) {
        if (question) {
          question.blocks = question.blocks.concat(extras);
          question.text = IR.blocksToPlainText(question.blocks);
        } else {
          question = { role: 'user', blocks: extras, text: IR.blocksToPlainText(extras) };
        }
      }
    }

    if (!question && !answers.length) return null;

    return {
      id: 'turn-' + (index + 1),
      index,
      key: adapter.stableKey(questionNode || answerNodes[0]),
      question: question || { role: 'user', blocks: [], text: '' },
      answers: answers.length ? answers : [{ role: 'assistant', blocks: [], text: '' }]
    };
  }

  async function turnsFromGroups(groups) {
    const turns = [];
    for (let index = 0; index < groups.length; index++) {
      const turn = await turnFrom(groups[index], index);
      if (turn) turns.push(turn);
    }
    return turns;
  }

  const BUNDLE_EXT = /\.(tar|tar\.gz|tgz|zip|gz|bz2|xz|7z|rar)$/i;
  const BINARY_EXT = /\.(exe|dll|bin|so|dylib|pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|webp|mp4|mp3|wav)$/i;
  const MARKDOWN_EXT = /\.(md|markdown|mdown|mkd)$/i;

  function attachmentLanguage(filename) {
    const ext = (String(filename || '').match(/\.([A-Za-z0-9]+)$/) || [, ''])[1].toLowerCase();
    const aliases = {
      js: 'javascript',
      jsx: 'jsx',
      ts: 'typescript',
      tsx: 'tsx',
      py: 'python',
      rb: 'ruby',
      rs: 'rust',
      sh: 'bash',
      zsh: 'bash',
      yml: 'yaml',
      htm: 'html',
      cxx: 'cpp',
      cc: 'cpp',
      cs: 'csharp'
    };
    return aliases[ext] || ext;
  }

  /**
   * Blocks for files attached to a message.
   *
   * Text-like attachments (.py, .md, .html, .patch, .json ...) have their
   * content in the DOM once expanded, so it is exported as a code block.
   * Archives and binaries do not — their bytes are never in the page — so they
   * are recorded by name instead of being silently dropped or half-rendered.
   */
  function attachmentBlocks(node, captured = null) {
    const blocks = [];
    const seen = new Set();
    const elements = Array.isArray(captured) ? captured : (adapter.attachments(node) || []);

    for (const element of elements) {
      const descriptor = [
        element.getAttribute?.('data-filename') || '',
        element.getAttribute?.('aria-label') || '',
        element.getAttribute?.('title') || '',
        element.getAttribute?.('data-testid') || '',
        element.getAttribute?.('class') || ''
      ].join(' ').replace(/\s+/g, ' ').trim();
      const pasted = /paste|pasted/i.test(descriptor);

      const explicitName = String(
        element.getAttribute?.('data-filename') ||
        element.getAttribute?.('aria-label') ||
        element.querySelector?.('[class*="name" i], [class*="title" i]')?.textContent ||
        ''
      ).replace(/\s+/g, ' ').trim();

      const fallbackName = pasted
        ? 'Pasted content'
        : String(element.textContent || '').replace(/\s+/g, ' ').trim();
      const name = (explicitName || fallbackName).slice(0, 120);
      if (!name || seen.has(name)) continue;
      seen.add(name);

      const filenameMatch = name.match(/[\w.-]+\.[A-Za-z0-9]{1,8}/);
      const filename = filenameMatch?.[0] || (pasted ? 'Pasted content' : name);

      if (BUNDLE_EXT.test(filename)) {
        blocks.push({
          type: 'heading',
          level: 4,
          inline: [{ type: 'text', text: 'Attachment bundle: ' + filename }]
        });
        blocks.push({
          type: 'paragraph',
          inline: [{
            type: 'em',
            children: [{
              type: 'text',
              text: 'Archive/bundle referenced in the original conversation. Its internal files are not available in the rendered chat page, so the exporter records the bundle here without inventing or omitting its presence.'
            }]
          }]
        });
        continue;
      }

      if (BINARY_EXT.test(filename)) {
        blocks.push({
          type: 'heading',
          level: 4,
          inline: [{ type: 'text', text: 'Attachment: ' + filename }]
        });
        blocks.push({
          type: 'paragraph',
          inline: [{
            type: 'em',
            children: [{
              type: 'text',
              text: 'Binary attachment referenced in the original conversation; its file contents are not embedded in the chat DOM.'
            }]
          }]
        });
        continue;
      }

      const snapshot = element.__cgxAttachmentContent || null;
      const root = snapshot || element;
      const pre = root.matches?.('pre') ? root : root.querySelector?.('pre');
      const body = pre ||
        (root.matches?.('textarea, [class*="font-mono" i], [class*="content" i], [class*="whitespace-pre" i]') ? root : null) ||
        root.querySelector?.('textarea, [class*="font-mono" i], [class*="content" i], [class*="whitespace-pre" i]');
      const rawText = body
        ? String(body.value || extractor.preservedText(body) || '')
        : '';
      const text = typeof extractor.safeText === 'function'
        ? extractor.safeText(rawText)
        : rawText.replace(/\u0000/g, '');

      if (text.trim()) {
        const heading = pasted ? 'Pasted content' : 'Attachment: ' + filename;
        blocks.push({ type: 'heading', level: 4, inline: [{ type: 'text', text: heading }] });

        if (!pasted && MARKDOWN_EXT.test(filename) && typeof IR.parseBlocks === 'function') {
          const rendered = IR.parseBlocks(text);
          if (rendered.length) blocks.push(...rendered);
          else blocks.push({ type: 'code', lang: 'markdown', text: text.replace(/\s+$/, ''), diagram: false });
        } else {
          blocks.push({
            type: 'code',
            lang: pasted ? '' : attachmentLanguage(filename),
            text: text.replace(/\s+$/, ''),
            diagram: false
          });
        }
      } else {
        const label = pasted ? 'Pasted content' : 'Attachment: ' + filename;
        blocks.push({
          type: 'paragraph',
          inline: [{ type: 'em', children: [{ type: 'text', text: label }] }]
        });
      }
    }

    return blocks;
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
    let groups = kit.groupTurns(adapter.messages());
    let complete = true;

    if (adapter.virtualized) {
      const harvest = await adapter.ensureFullyLoaded({ onProgress: options.onProgress });
      if (harvest.turns?.length) groups = harvest.turns;
      complete = harvest.complete;
    }

    const turns = await turnsFromGroups(groups);
    return { ...baseDocument(), turns, complete };
  }

  /**
   * Export specific turns.
   *
   * Takes the elements themselves rather than re-resolving them by key: the
   * old key round-trip failed whenever the page re-rendered between opening
   * the menu and clicking a format, which on Claude is most of the time.
   * Keys are only used to recover the turn's position in the thread, and a
   * detached element still yields correct content because we hold a reference
   * to its subtree.
   */
  async function extractTurns(entries) {
    const live = kit.groupTurns(adapter.messages());
    const resolved = [];

    for (const entry of entries) {
      // Prefer the live group, so a re-render between opening the menu and
      // choosing a format cannot lose the answers.
      let group = live.find(candidate =>
        candidate.question === entry.container ||
        candidate.answers.includes(entry.container));

      if (!group) {
        group = live.find(candidate => {
          const anchor = candidate.question || candidate.answers[0];
          return anchor && adapter.stableKey(anchor) === entry.key;
        });
      }
      // Fall back to the captured group: a detached subtree still has content.
      if (!group) group = entry.group;
      if (!group) continue;

      const position = live.indexOf(group);
      resolved.push({ group, index: position >= 0 ? position : entry.index });
    }

    if (!resolved.length) {
      throw new Error('Could not read this answer from the page. Reload the conversation and try again.');
    }

    resolved.sort((a, b) => a.index - b.index);
    const turns = [];
    for (const item of resolved) {
      const turn = await turnFrom(item.group, item.index);
      if (turn) turns.push(turn);
    }

    if (!turns.length) {
      throw new Error('Could not read any content from this answer. Reload the conversation and try again.');
    }
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

  /** Turns marked for a range export (shift-click), keyed for de-duplication. */
  const selection = new Map();

  /**
   * Place the control immediately after the last answer of the turn.
   *
   * Anchoring on the answer element rather than on a turn container puts the
   * button in the same visual position on both platforms — the end of the
   * answer — and works on Claude, where a user message and its answer do not
   * share a wrapper.
   */
  function footerRowFor(lastAnswer, key) {
    const parent = lastAnswer.parentElement;
    if (!parent) return null;

    const existing = Array.from(parent.querySelectorAll(':scope > .cgx-answer-row'))
      .find(row => row.dataset.cgxKey === key);
    if (existing) {
      // Keep it directly after the answer even if the site reordered children.
      if (existing.previousElementSibling !== lastAnswer) {
        lastAnswer.insertAdjacentElement('afterend', existing);
      }
      return existing;
    }

    const row = document.createElement('div');
    row.className = 'cgx-answer-row';
    row.setAttribute(HOST_ATTR, 'true');
    row.dataset.cgxKey = key;
    row.style.cssText = 'display:flex;justify-content:flex-start;align-items:center;gap:8px;margin:2px 0 10px;';
    lastAnswer.insertAdjacentElement('afterend', row);
    return row;
  }

  function decorateTurn(group, index = -1) {
    const answers = group?.answers || [];
    if (!answers.length) return;

    const lastAnswer = answers[answers.length - 1];
    if (!(lastAnswer instanceof Element) || !lastAnswer.isConnected) return;

    const anchor = group.question || lastAnswer;
    const key = adapter.stableKey(anchor);
    const row = footerRowFor(lastAnswer, key);
    if (!row) return;

    let control = row.querySelector('.' + ANSWER_HOST_CLASS);
    if (!control) {
      const created = createControlHost(ANSWER_HOST_CLASS);
      control = created.host;
      control.__cgx = created;
      row.appendChild(control);

      created.button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        const entry = control.__cgxEntry;
        if (!entry) return;

        if (event.shiftKey) {
          if (selection.has(entry.key)) selection.delete(entry.key);
          else selection.set(entry.key, entry);
          refreshSelectionStyles();
          return;
        }

        const entries = selection.size ? Array.from(selection.values()) : [entry];
        const heading = entries.length > 1
          ? `Export ${entries.length} selected Q&A turns`
          : 'Export this Q&A';
        openMenu(control, heading, () => extractTurns(entries));
      });
    }

    control.dataset.cgxKey = key;
    // Hold the group itself; re-resolving by key alone was the failure mode.
    control.__cgxEntry = { container: anchor, group, key, index };
    if (selection.has(key)) selection.set(key, control.__cgxEntry);
    const { button } = control.__cgx;
    const streaming = answers.some(node => adapter.isStreaming(node));

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

    if (anchor?.parentElement && anchor.isConnected) {
      host.style.position = '';
      host.style.inset = '';
      host.style.zIndex = '';
      if (host.nextElementSibling !== anchor) anchor.parentElement.insertBefore(host, anchor);
      return;
    }

    // No usable header anchor. Appending to <body> put the button at the very
    // bottom of the page, where it looked like it had simply not appeared, so
    // pin it instead — always visible, never in the message flow.
    host.style.position = 'fixed';
    host.style.top = '12px';
    host.style.right = '76px';
    host.style.zIndex = '2147483646';
    if (host.parentElement !== document.body) document.body.appendChild(host);
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

    // Decoration always works from the full group list: a turn's answers can
    // live outside the mutated subtree, so a partial pass would miss them.
    const groups = kit.groupTurns(adapter.messages());
    pending.clear();
    fullPass = false;
    groups.forEach((group, index) => decorateTurn(group, index));
    decorateThread();
  }

  function schedule(mutations = null) {
    if (Array.isArray(mutations)) {
      // Any mutation outside our own UI triggers a re-decoration pass; the
      // pass itself is cheap and correct, and rAF coalesces bursts.
      for (const mutation of mutations) {
        const target = mutation.target instanceof Element ? mutation.target : null;
        if (target?.closest?.('[' + HOST_ATTR + ']')) continue;
        fullPass = true;
        break;
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
