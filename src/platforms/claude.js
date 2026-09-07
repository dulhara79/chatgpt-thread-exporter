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
    defineAdapter, harvestVirtualizedTurns
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
    () => Array.from(document.querySelectorAll('header button, [role="banner"] button'))
      .find(button => actionLabel(button).includes('share')) || null,
    () => document.querySelector('header') || null
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

    turnContainers() {
      const root = adapter.conversationRoot();
      const found = resolve(root, TURN_CANDIDATES, 'claude.turns', { all: true });
      // A turn is only a turn once it owns a user message; Claude reuses the
      // same wrapper for standalone system/notice rows.
      const withUser = found.filter(el => el.querySelector(USER_SELECTOR) || el.matches(USER_SELECTOR));
      return withUser.length ? withUser : found;
    },

    userNode(turn) {
      if (!(turn instanceof Element)) return null;
      if (turn.matches(USER_SELECTOR)) return turn;
      return turn.querySelector(USER_SELECTOR);
    },

    assistantNodes(turn) {
      if (!(turn instanceof Element)) return [];
      return Array.from(turn.querySelectorAll(ASSISTANT_SELECTOR));
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
      const cards = artifactCards(turn);
      if (!cards.length) return [];
      // If the side panel happens to be open, hand back the rendered body too
      // so the extractor can inline real content instead of a placeholder.
      const panel = resolve(document, ARTIFACT_CANDIDATES, 'claude.artifactPanel');
      return cards.map(card => {
        card.__cgxArtifactPanel = panel && visible(panel) ? panel : null;
        return card;
      });
    },

    thinkingBlocks(node) {
      if (!(node instanceof Element)) return [];
      const owner = turnOwner(node) || node;
      const found = resolve(owner, THINKING_CANDIDATES, 'claude.thinking', { all: true });
      return Array.isArray(found) ? found : [];
    },

    attachments(turn) {
      if (!(turn instanceof Element)) return [];
      return Array.from(turn.querySelectorAll('[data-testid*="file" i], [class*="attachment" i]'));
    },

    async ensureFullyLoaded(options = {}) {
      const result = await harvestVirtualizedTurns(adapter, options);
      return {
        complete: result.complete,
        turns: result.turns.length,
        containers: result.turns
      };
    }
  });

  globalThis.ThreadExporterPlatforms = globalThis.ThreadExporterPlatforms || [];
  globalThis.ThreadExporterPlatforms.push(adapter);
})();
