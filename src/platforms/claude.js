/**
 * Claude platform adapter.
 *
 * Claude publishes no DOM contract and ships UI changes frequently, so every
 * selector here is a *tiered hypothesis*: a stable-looking test id first, a
 * semantic class second, and a structural heuristic last. `ThreadExporterAdapterKit.resolve`
 * records which tier fired so the diagnostics report can tell you a redesign
 * happened before your users do.
 *
 * Verify tier 1 against a live thread with:
 *   [...document.querySelectorAll('[data-testid],[data-test-render-count]')]
 *     .map(el => el.getAttribute('data-testid') || 'render-count:' + el.tagName)
 *     .filter((v, i, a) => a.indexOf(v) === i).sort()
 */
(() => {
  'use strict';

  const kit = globalThis.ThreadExporterAdapterKit;
  if (!kit) return;

  const {
    resolve, visible, present, actionLabel, contentHash,
    defineAdapter, harvestVirtualizedTurns, sleep, groupTurns, outermost
  } = kit;

  const USER_SELECTOR = 'div[data-testid="user-message"], .font-user-message';
  const ASSISTANT_SELECTOR = 'div.font-claude-response, div.font-claude-message, [data-testid="claude-response"]';

  const ROOT_CANDIDATES = [
    () => {
      const marker = document.querySelector('div[data-test-render-count]');
      return marker?.parentElement || null;
    },
    () => document.querySelector('div[data-testid="user-message"]')?.closest('main, [role="main"]') || null,
    'main',
    () => document.body
  ];

  const TURN_CANDIDATES = [
    'div[data-test-render-count]',
    '[class*="conversation-turn"]',
    // Structural fallback: the common ancestor that holds a user message.
    root => Array.from(root.querySelectorAll(USER_SELECTOR))
      .map(node => node.closest('div[data-test-render-count]') || node.parentElement?.parentElement || node)
      .filter(Boolean)
  ];

  const BODY_CANDIDATES = [
    '.font-claude-response',
    '.font-claude-message',
    '[class*="prose"]',
    '.grid-cols-1 > div',
    node => node
  ];

  const HEADER_CANDIDATES = [
    'button[data-testid="share-conversation"]',
    'button[aria-label*="Share" i]',
    () => Array.from(document.querySelectorAll('header button, [role="banner"] button, [class*="sticky" i] button'))
      .find(button => /share|upgrade|model/i.test(actionLabel(button))) || null,
    // The chat title control sits in the top bar on every Claude layout so far.
    'button[data-testid="chat-menu-trigger"]',
    () => {
      // Last resort: the top-most bar that holds a small number of buttons and
      // is not part of the message flow.
      const bars = Array.from(document.querySelectorAll('header, [role="banner"], div[class*="sticky" i]'))
        .filter(bar => {
          const rect = bar.getBoundingClientRect();
          if (rect.top > 120 || rect.width < 240) return false;
          const buttons = bar.querySelectorAll('button');
          return buttons.length > 0 && buttons.length <= 12;
        })
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      const bar = bars[0];
      if (!bar) return null;
      const buttons = Array.from(bar.querySelectorAll('button')).filter(present);
      return buttons[buttons.length - 1] || null;
    }
  ];

  const ARTIFACT_CONTENT_SELECTOR = [
    '#markdown-artifact',
    '#wiggle-file-content',
    '[data-testid="artifact-content"]',
    '[data-testid="artifact-preview"]',
    '[data-testid="artifact-renderer"]',
    '[data-testid="artifact-viewer"]'
  ].join(', ');

  const ARTIFACT_PANEL_SELECTOR = [
    ARTIFACT_CONTENT_SELECTOR,
    'iframe[title*="artifact" i]',
    'iframe[title*="preview" i]',
    '[data-testid*="artifact" i]',
    '[class*="artifact-panel" i]',
    '[class*="artifact-view" i]',
    '[class*="artifact-preview" i]'
  ].join(', ');

  const CLAUDE_CHROME_PHRASES = [
    'new', 'projects', 'artifacts', 'scheduled', 'customize',
    'pinned', 'chats and tasks', 'view all conversations'
  ];

  const captureDiagnosticsState = {
    cardsSeen: 0,
    connectedCards: 0,
    captured: 0,
    failed: 0,
    failures: []
  };

  function resetCaptureDiagnostics() {
    captureDiagnosticsState.cardsSeen = 0;
    captureDiagnosticsState.connectedCards = 0;
    captureDiagnosticsState.captured = 0;
    captureDiagnosticsState.failed = 0;
    captureDiagnosticsState.failures = [];
  }

  function recordCaptureFailure(card, reason) {
    captureDiagnosticsState.failed += 1;
    if (captureDiagnosticsState.failures.length < 30) {
      captureDiagnosticsState.failures.push({
        title: compactText(actionLabel(card)).slice(0, 120),
        reason
      });
    }
  }

  function inConversationFlow(element) {
    return Boolean(element?.closest?.(
      'div[data-test-render-count], [class*="conversation-turn"], ' + USER_SELECTOR + ', ' + ASSISTANT_SELECTOR
    ));
  }

  function compactText(value) {
    return String(value || '')
      .replace(/\u0000/g, '')
      .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function panelText(panel) {
    if (!(panel instanceof Element)) return '';

    const parts = [];
    const own = panel.innerText || panel.textContent || '';
    if (own) parts.push(own);

    const frames = panel.matches('iframe') ? [panel] : Array.from(panel.querySelectorAll('iframe'));
    for (const frame of frames) {
      try {
        const body = frame.contentDocument?.body;
        const text = body?.innerText || body?.textContent || '';
        if (text) parts.push(text);
      } catch {}
    }

    return compactText(parts.join('\n'));
  }

  function isClaudeChrome(element) {
    if (!(element instanceof Element)) return true;
    if (element.matches('nav, [role="navigation"]') || element.closest('nav, [role="navigation"]')) return true;

    const marker = [
      element.id || '',
      element.getAttribute?.('data-testid') || '',
      element.getAttribute?.('aria-label') || '',
      element.getAttribute?.('class') || ''
    ].join(' ').toLowerCase();

    if (/sidebar|navigation|chat-list|conversation-list|left-rail/.test(marker)) return true;

    const text = compactText(element.innerText || element.textContent || '').toLowerCase();
    const chromeHits = CLAUDE_CHROME_PHRASES.filter(phrase => text.includes(phrase)).length;

    // Document content is allowed to discuss Claude UI words such as Projects,
    // Artifacts, Scheduled, Customize and Pinned. Treat those words as only a
    // weak signal; structural navigation ancestry and link density are the hard
    // rejection signals.
    const links = element.querySelectorAll?.('a[href]')?.length || 0;
    const rich = Boolean(element.querySelector?.(
      'pre, code, article, [class*="prose" i], table, canvas, svg, iframe'
    ));
    return (links >= 8 && !rich) || (chromeHits >= 6 && links >= 4 && !rich);
  }

  function isVerifiedArtifactPanel(element) {
    if (!(element instanceof Element) || !present(element) || inConversationFlow(element) || isClaudeChrome(element)) {
      return false;
    }

    if (element.matches(ARTIFACT_CONTENT_SELECTOR)) return true;
    if (element.matches('iframe[title*="artifact" i], iframe[title*="preview" i]')) return true;

    const marker = [
      element.id || '',
      element.getAttribute?.('data-testid') || '',
      element.getAttribute?.('aria-label') || '',
      element.getAttribute?.('title') || '',
      element.getAttribute?.('class') || ''
    ].join(' ').toLowerCase();

    if (!/artifact|preview/.test(marker)) return false;

    return Boolean(
      panelText(element) ||
      element.querySelector?.('pre, code, article, [class*="prose" i], table, canvas, svg, iframe')
    );
  }

  function artifactContentRoot(panel) {
    if (!(panel instanceof Element)) return null;
    if (panel.matches(ARTIFACT_CONTENT_SELECTOR + ', iframe[title*="artifact" i], iframe[title*="preview" i]')) {
      return panel;
    }

    const inner = Array.from(panel.querySelectorAll(
      ARTIFACT_CONTENT_SELECTOR +
      ', iframe[title*="artifact" i], iframe[title*="preview" i], article[class*="prose" i], [class*="prose" i], pre, [class*="cm-content" i]'
    )).filter(candidate => !isClaudeChrome(candidate));

    inner.sort((a, b) => {
      const score = element =>
        (element.matches(ARTIFACT_CONTENT_SELECTOR) ? 5000 : 0) +
        (element.matches('iframe') ? 4000 : 0) +
        Math.min(3000, panelText(element).length);
      return score(b) - score(a);
    });
    return inner[0] || panel;
  }

  function cloneArtifactNode(node) {
    if (!node) return null;
    if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.nodeValue || '');
    if (node.nodeType !== Node.ELEMENT_NODE) return null;

    const tag = node.tagName.toLowerCase();

    if (tag === 'iframe') {
      try {
        const body = node.contentDocument?.body;
        if (!body) return null;
        const wrapper = document.createElement('div');
        wrapper.setAttribute('data-cgx-iframe-content', 'true');
        for (const child of Array.from(body.childNodes)) {
          const cloned = cloneArtifactNode(child);
          if (cloned) wrapper.appendChild(cloned);
        }
        return wrapper;
      } catch {
        return null;
      }
    }

    if (tag === 'canvas') {
      try {
        const img = document.createElement('img');
        img.src = node.toDataURL('image/png');
        img.alt = node.getAttribute('aria-label') || 'Artifact preview';
        img.width = node.width || 0;
        img.height = node.height || 0;
        return img;
      } catch {
        return null;
      }
    }

    const clone = node.cloneNode(false);
    if (tag === 'textarea') clone.textContent = node.value || '';

    const sourceChildren = node.shadowRoot
      ? Array.from(node.shadowRoot.childNodes)
      : Array.from(node.childNodes);

    for (const child of sourceChildren) {
      const cloned = cloneArtifactNode(child);
      if (cloned) clone.appendChild(cloned);
    }
    return clone;
  }

  function snapshotArtifactPanel(panel) {
    const root = artifactContentRoot(panel);
    return root ? cloneArtifactNode(root) : null;
  }

  function findArtifactPanel() {
    const candidates = Array.from(document.querySelectorAll(ARTIFACT_PANEL_SELECTOR))
      .filter(isVerifiedArtifactPanel);

    candidates.sort((a, b) => {
      const score = element => {
        const direct = element.matches(ARTIFACT_CONTENT_SELECTOR) ? 6000 : 0;
        const frame = element.matches('iframe') ? 4000 : 0;
        const rich = element.querySelector?.(
          'pre, code, article, [class*="prose" i], table, canvas, svg, iframe'
        ) ? 1500 : 0;
        return direct + frame + rich + Math.min(3000, panelText(element).length);
      };
      return score(b) - score(a);
    });

    return candidates[0] || null;
  }

  const THINKING_CANDIDATES = [
    '[data-testid="thinking-block"]',
    '[data-testid*="thinking" i]',
    node => Array.from(node.querySelectorAll('details, [class*="thinking" i]'))
      .filter(el => /thinking|thought/i.test(actionLabel(el) + ' ' + (el.className || '')))
  ];

  function turnOwner(node) {
    if (!(node instanceof Element)) return null;
    return node.closest('div[data-test-render-count]') ||
      node.closest('[class*="conversation-turn"]') ||
      node.parentElement;
  }

  /**
   * Claude renders inline artifact *cards* in the message flow while the
   * artifact body lives in a side panel. The card carries the title and kind,
   * which is enough for the v1 placeholder even when the panel is closed.
   */
  function artifactCards(turn) {
    if (!(turn instanceof Element)) return [];
    const selectors = [
      '[data-testid="artifact-card"]',
      '[data-testid*="artifact" i][role="button"]',
      'button[aria-label*="artifact" i]'
    ];
    for (const selector of selectors) {
      const found = Array.from(turn.querySelectorAll(selector))
        .filter(element => !isClaudeChrome(element));
      if (found.length) return found;
    }

    // Last resort: score interactive answer controls instead of requiring the
    // literal word "artifact". Claude frequently renders title-only artifact
    // cards, so a visible title button with file/document iconography or an
    // artifact/file-ish class/test id must still be considered.
    return Array.from(turn.querySelectorAll('button, [role="button"], a[role="button"]')).filter(element => {
      const label = actionLabel(element);
      const marker = [
        element.getAttribute?.('data-testid') || '',
        element.getAttribute?.('class') || '',
        element.getAttribute?.('aria-label') || '',
        element.getAttribute?.('title') || ''
      ].join(' ');
      const hasArtifactSignal = /(artifact|document|react component|\bcode\b|html|svg|markdown|file|preview)/i.test(
        label + ' ' + marker
      );
      const hasTitleShape =
        label.length >= 4 &&
        label.length <= 220 &&
        Boolean(element.querySelector?.('svg, [class*="icon" i], [class*="file" i], [class*="document" i]'));
      return (hasArtifactSignal || hasTitleShape) &&
        !/copy|retry|feedback|edit|more|share|download/.test(label) &&
        !isClaudeChrome(element);
    });
  }

  function artifactPanelSignature(panel) {
    if (!(panel instanceof Element)) return '';
    const root = artifactContentRoot(panel);
    return [
      panel.getAttribute?.('data-testid') || '',
      panel.getAttribute?.('aria-label') || '',
      panelText(root || panel).slice(0, 1600),
      root?.querySelectorAll?.('pre, code, article, table, img, svg, canvas, iframe')?.length || 0
    ].join('|');
  }

  const adapter = defineAdapter({
    id: 'claude',
    label: 'Claude',

    resetCaptureDiagnostics,

    captureDiagnostics() {
      return JSON.parse(JSON.stringify(captureDiagnosticsState));
    },

    // Claude keeps only a window of a long conversation mounted. Everything
    // downstream must treat a plain DOM read as potentially partial (F-04).
    virtualized: true,

    matches(url) {
      return /(^|\.)claude\.ai$/.test(url.hostname);
    },

    conversationRoot() {
      return resolve(document, ROOT_CANDIDATES, 'claude.root') || document.body;
    },

    /**
     * Flat, document-ordered message list.
     *
     * Claude does NOT reliably wrap a user message and its answer in one
     * element — each message gets its own wrapper. Pairing is done from this
     * ordered list instead, which is why answers no longer come back empty.
     */
    messages() {
      const root = adapter.conversationRoot() || document.body;

      let nodes = resolve(root, [
        () => Array.from(root.querySelectorAll(USER_SELECTOR + ', ' + ASSISTANT_SELECTOR)),
        () => Array.from(document.querySelectorAll(USER_SELECTOR + ', ' + ASSISTANT_SELECTOR)),
        // Last resort: any turn wrapper that carries readable text.
        () => Array.from(document.querySelectorAll('div[data-test-render-count]'))
          .filter(el => (el.textContent || '').trim().length > 0)
      ], 'claude.messages', { all: true });

      nodes = outermost(nodes);

      return nodes.map(node => ({
        node,
        role: node.matches(USER_SELECTOR) ? 'user'
          : node.matches(ASSISTANT_SELECTOR) ? 'assistant'
            // Heuristic tier: infer the role from whichever marker it contains.
            : node.querySelector(USER_SELECTOR) ? 'user' : 'assistant'
      }));
    },

    turnContainers() {
      return groupTurns(adapter.messages())
        .map(turn => turn.question || turn.answers[0])
        .filter(Boolean);
    },

    userNode(turn) {
      if (!(turn instanceof Element)) return null;
      if (turn.matches(USER_SELECTOR)) return turn;
      return turn.querySelector(USER_SELECTOR);
    },

    assistantNodes(turn) {
      if (!(turn instanceof Element)) return [];
      if (turn.matches(ASSISTANT_SELECTOR)) return [turn];
      const inside = Array.from(turn.querySelectorAll(ASSISTANT_SELECTOR));
      if (inside.length) return inside;
      // The turn anchor is a user message: walk the flat list forward to the
      // next user message, collecting the answers in between.
      const all = adapter.messages();
      const start = all.findIndex(message => message.node === turn);
      if (start < 0) return [];
      const out = [];
      for (let i = start + 1; i < all.length; i++) {
        if (all[i].role === 'user') break;
        out.push(all[i].node);
      }
      return out;
    },

    messageBody(node) {
      if (!(node instanceof Element)) return null;
      if (node.matches(USER_SELECTOR)) return node;
      return resolve(node, BODY_CANDIDATES, 'claude.body') || node;
    },

    isStreaming(node) {
      if (!(node instanceof Element)) return false;
      if (node.closest('[data-is-streaming="true"]')) return true;
      if (node.querySelector('[data-is-streaming="true"]')) return true;
      const owner = turnOwner(node);
      return Boolean(owner?.querySelector('button[aria-label*="Stop" i]'));
    },

    stableKey(node) {
      if (!(node instanceof Element)) return 'unknown';
      const owner = turnOwner(node) || node;
      const messageId = node.getAttribute('data-message-id') || owner.getAttribute?.('data-message-id');
      if (messageId) return 'message:' + messageId;
      const uuid = owner.getAttribute?.('data-uuid') || node.getAttribute('data-uuid');
      if (uuid) return 'uuid:' + uuid;
      // `data-test-render-count` is NOT identity — it changes on re-render — so
      // fall back to a content hash, which survives Claude unmounting and
      // remounting the same turn during a scroll harvest.
      const user = adapter.userNode(owner);
      const role = node.matches(USER_SELECTOR) || node.querySelector(USER_SELECTOR) ? 'user' : 'assistant';
      const bodyText = String(user?.innerText || node.innerText || '');
      const seed = role + '\u241E' + bodyText;
      // Hash the complete message in both directions instead of truncating at
      // 400 characters. Do not include neighbouring virtualized DOM: a message
      // at the edge of a window may remount without the same neighbours.
      return 'hash:' + contentHash(seed) + '-' +
        contentHash(Array.from(seed).reverse().join('')) + '-' + seed.length;
    },

    conversationTitle() {
      const cleaned = document.title.replace(/\s*[-–—|]\s*Claude\s*$/i, '').trim();
      if (cleaned && !/^claude$/i.test(cleaned)) return cleaned;

      const heading = document.querySelector('button[data-testid="chat-menu-trigger"], header h1, header [class*="truncate"]');
      const headingText = (heading?.textContent || '').replace(/\s+/g, ' ').trim();
      if (headingText && !/^claude$/i.test(headingText)) return headingText.slice(0, 100);

      const firstUser = document.querySelector(USER_SELECTOR);
      const text = (firstUser?.innerText || '').replace(/\s+/g, ' ').trim();
      return text ? text.slice(0, 100) : 'Claude Conversation';
    },

    headerAnchor() {
      return resolve(document, HEADER_CANDIDATES, 'claude.header', {
        filter: el => present(el) && !el.closest('[data-cgx-ui]')
      });
    },

    /**
     * Claude's action row is hover-revealed and sits at opacity 0 until the
     * turn is hovered, so this deliberately uses `present` (which tolerates
     * opacity 0) rather than `visible`. The injector still prefers its own
     * always-visible footer row; this is only used as an enhancement.
     */
    answerActionRow(node) {
      const owner = turnOwner(node);
      if (!owner) return null;
      const buttons = Array.from(owner.querySelectorAll('button')).filter(button =>
        present(button) &&
        !button.closest('[data-cgx-ui]') &&
        !button.closest('pre, code')
      );
      const known = buttons.find(button =>
        /^(copy|retry|good response|bad response|edit|more)(\b|\s|$)/.test(actionLabel(button))
      );
      if (!known) return null;
      let current = known.parentElement;
      let depth = 0;
      while (current && current !== owner && depth < 4) {
        const count = current.querySelectorAll('button').length;
        if (count >= 2 && count <= 10) return current;
        current = current.parentElement;
        depth += 1;
      }
      return known.parentElement;
    },

    artifacts(turn) {
      // Accepts either the user or the assistant node: artifact cards live in
      // the assistant message, which may not be a descendant of the anchor.
      const cards = artifactCards(turnOwner(turn) || turn);
      if (!cards.length) return [];
      // If the side panel happens to be open, hand back the rendered body too
      // so the extractor can inline real content instead of a placeholder.
      const panel = findArtifactPanel();
      return cards.map(card => {
        card.__cgxArtifactPanel = panel && present(panel) ? snapshotArtifactPanel(panel) : null;
        return card;
      });
    },

    /**
     * Open each artifact so its body can be exported.
     *
     * Artifacts render in a side panel rather than in the message, so a
     * closed artifact exports as a stub. This clicks each card, waits for the
     * panel to render, snapshots it (detached, so it survives the panel
     * closing), and restores the previous panel state.
     */
    async captureArtifacts(node) {
      const owner = turnOwner(node) || node;
      const cards = artifactCards(owner);
      captureDiagnosticsState.cardsSeen += cards.length;
      captureDiagnosticsState.connectedCards += cards.filter(card => card.isConnected).length;
      if (!cards.length) return [];

      const panelWasOpen = Boolean(findArtifactPanel());

      for (const card of cards) {
        if (card.__cgxArtifactPanel) continue;
        if (!card.isConnected) {
          card.__cgxArtifactPanel = null;
          recordCaptureFailure(card, 'detached-card');
          continue;
        }

        try {
          const beforePanel = findArtifactPanel();
          const beforeSignature = artifactPanelSignature(beforePanel);
          const button = card.matches('button, [role="button"], a') ? card : card.querySelector('button, [role="button"], a') || card;
          button.click();

          // Wait for a panel that is both readable and attributable to this
          // click. Accept a newly mounted panel or a changed signature; never
          // silently reuse stale content from the previously open artifact.
          let panel = null;
          let lastSignature = '';
          let stableRounds = 0;
          const cardLabel = compactText(actionLabel(card)).toLowerCase();

          for (let attempt = 0; attempt < 24; attempt++) {
            await sleep(100);
            panel = findArtifactPanel();
            const readable = panelText(panel);
            const root = panel ? artifactContentRoot(panel) : null;
            const signature = artifactPanelSignature(panel);
            const changed = Boolean(panel) && (panel !== beforePanel || signature !== beforeSignature);

            const onlyCardChrome = readable &&
              cardLabel &&
              readable.length <= cardLabel.length + 32 &&
              cardLabel.includes(readable.toLowerCase());

            const hasRenderableContent = Boolean(
              readable ||
              root?.querySelector?.('pre, code, article, [class*="prose" i], table, img, svg, canvas, iframe')
            );

            if (changed && panel && root && hasRenderableContent && !onlyCardChrome) {
              stableRounds = signature === lastSignature ? stableRounds + 1 : 0;
              if (stableRounds >= 1) break;
            } else {
              stableRounds = 0;
            }
            lastSignature = signature;
          }

          card.__cgxArtifactPanel = panel && artifactPanelSignature(panel) !== beforeSignature
            ? snapshotArtifactPanel(panel)
            : null;

          if (card.__cgxArtifactPanel) captureDiagnosticsState.captured += 1;
          else recordCaptureFailure(card, panel ? 'panel-did-not-change' : 'panel-not-found');
        } catch (error) {
          card.__cgxArtifactPanel = null;
          recordCaptureFailure(card, 'capture-error: ' + String(error?.message || error).slice(0, 100));
        }
      }

      if (!panelWasOpen) {
        const close = document.querySelector(
          'button[aria-label*="Close" i], button[data-testid="close-artifact"]'
        );
        try { close?.click(); } catch {}
        await sleep(80);
      }

      return cards;
    },

    thinkingBlocks(node) {
      if (!(node instanceof Element)) return [];
      const owner = turnOwner(node) || node;
      const found = resolve(owner, THINKING_CANDIDATES, 'claude.thinking', { all: true });
      return Array.isArray(found) ? found : [];
    },

    attachments(turn) {
      if (!(turn instanceof Element)) return [];
      const scope = turn.matches(USER_SELECTOR) ? (turnOwner(turn) || turn) : turn;
      const found = Array.from(scope.querySelectorAll([
        '[data-testid*="file" i]',
        '[data-testid*="attachment" i]',
        '[data-testid*="paste" i]',
        '[class*="attachment" i]',
        '[class*="pasted" i]',
        '[aria-label*="paste" i]',
        '[aria-label*="pasted" i]',
        '[title*="paste" i]'
      ].join(', ')));

      for (const element of scope.querySelectorAll('button, [role="button"], details')) {
        if (/pasted content|paste content|text attachment|attached text/i.test(actionLabel(element))) {
          found.push(element);
        }
      }

      const unique = Array.from(new Set(found));
      return unique.filter(el => !unique.some(other => other !== el && other.contains(el)));
    },

    async captureAttachments(turn) {
      const items = adapter.attachments(turn);
      if (!items.length) return [];

      const readableNode = element => {
        if (!(element instanceof Element)) return null;
        const candidates = Array.from(element.querySelectorAll([
          'pre',
          'textarea',
          '[class*="whitespace-pre" i]',
          '[class*="font-mono" i]',
          '[data-testid*="content" i]'
        ].join(', ')));
        candidates.sort((a, b) =>
          String(b.value || b.textContent || '').length - String(a.value || a.textContent || '').length
        );
        return candidates.find(candidate => String(candidate.value || candidate.textContent || '').trim()) || null;
      };

      const overlayFor = element => {
        const candidates = Array.from(document.querySelectorAll([
          'dialog',
          '[role="dialog"]',
          '[data-testid*="paste" i]',
          '[class*="popover" i]'
        ].join(', '))).filter(candidate =>
          candidate !== element &&
          !element.contains(candidate) &&
          present(candidate) &&
          String(candidate.textContent || '').trim().length > 12
        );
        candidates.sort((a, b) =>
          String(b.textContent || '').length - String(a.textContent || '').length
        );
        return candidates[0] || null;
      };

      for (const item of items) {
        const marker = [
          actionLabel(item),
          item.getAttribute?.('data-testid') || '',
          item.getAttribute?.('class') || ''
        ].join(' ');

        if (!/paste|pasted|text attachment|attached text/i.test(marker)) continue;

        let body = readableNode(item);
        if (body) {
          item.__cgxAttachmentContent = body.cloneNode(true);
          continue;
        }

        const clickable = item.matches('button, [role="button"], summary')
          ? item
          : item.querySelector('button, [role="button"], summary');
        if (!clickable) continue;

        try { clickable.click(); } catch {}

        for (let attempt = 0; attempt < 15; attempt++) {
          await sleep(80);
          body = readableNode(item) || overlayFor(item);
          const text = String(body?.value || body?.textContent || '').trim();
          if (text && !/^pasted content$/i.test(text)) break;
        }

        if (body) {
          const preferred = readableNode(body) || body;
          item.__cgxAttachmentContent = preferred.cloneNode(true);

          const dialog = body.closest?.('dialog, [role="dialog"]') ||
            (body.matches?.('dialog, [role="dialog"]') ? body : null);
          const close = dialog?.querySelector?.(
            'button[aria-label*="close" i], button[data-testid*="close" i]'
          );
          try { close?.click(); } catch {}
        }
      }

      return items;
    },

    async ensureFullyLoaded(options = {}) {
      const result = await harvestVirtualizedTurns(adapter, options);
      return {
        complete: result.complete,
        messages: result.messages,
        turns: result.turns
      };
    }
  });

  globalThis.ThreadExporterPlatforms = globalThis.ThreadExporterPlatforms || [];
  globalThis.ThreadExporterPlatforms.push(adapter);
})();
