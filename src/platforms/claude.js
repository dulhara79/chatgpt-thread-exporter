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

  const ARTIFACT_CANDIDATES = [
    '#markdown-artifact',
    '#wiggle-file-content',
    '[data-testid="artifact-content"]',
    () => document.querySelector('div.h-full.top-0 div.font-mono') || null
  ];

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
      'button[aria-label*="artifact" i]',
      '[class*="artifact" i]'
    ];
    for (const selector of selectors) {
      const found = Array.from(turn.querySelectorAll(selector));
      if (found.length) return found;
    }
    return [];
  }

  const adapter = defineAdapter({
    id: 'claude',
    label: 'Claude',

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
      const seed = (user?.innerText || node.innerText || '').slice(0, 400);
      return 'hash:' + contentHash(seed);
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
      const panel = resolve(document, ARTIFACT_CANDIDATES, 'claude.artifactPanel');
      return cards.map(card => {
        card.__cgxArtifactPanel = panel && visible(panel) ? panel : null;
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
      if (!cards.length) return [];

      const panelWasOpen = Boolean(resolve(document, ARTIFACT_CANDIDATES, 'claude.artifactPanel'));

      for (const card of cards) {
        if (card.__cgxArtifactPanel) continue;
        try {
          const button = card.matches('button') ? card : card.querySelector('button') || card;
          button.click();

          // Wait for the panel to mount and stop changing size.
          let panel = null;
          let lastLength = -1;
          for (let attempt = 0; attempt < 25; attempt++) {
            await sleep(120);
            panel = resolve(document, ARTIFACT_CANDIDATES, 'claude.artifactPanel');
            const length = panel?.textContent?.length ?? -1;
            if (panel && length > 0 && length === lastLength) break;
            lastLength = length;
          }

          // Snapshot: cloning detaches it from the panel we are about to reuse
          // for the next artifact, so each card keeps its own content.
          card.__cgxArtifactPanel = panel ? panel.cloneNode(true) : null;
        } catch {
          card.__cgxArtifactPanel = null;
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
        // Claude shows long pasted text as its own collapsible card; its
        // contents were being dropped, leaving the question section blank.
        '[class*="pasted" i]',
        'button[aria-label*="paste" i]'
      ].join(', ')));

      // Some layouts nest the chip inside its own wrapper; keep the outermost.
      return found.filter(el => !found.some(other => other !== el && other.contains(el)));
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
