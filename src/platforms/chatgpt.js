/**
 * ChatGPT platform adapter.
 *
 * Behaviour is intentionally identical to the pre-adapter content script; this
 * file only moves the selectors behind the interface so that Claude can be a
 * peer rather than a special case.
 */
(() => {
  'use strict';

  const kit = globalThis.ThreadExporterAdapterKit;
  if (!kit) return;

  const { resolve, visible, present, actionLabel, contentHash, defineAdapter } = kit;

  const ROLE_SELECTOR = '[data-message-author-role="user"], [data-message-author-role="assistant"]';
  const USER_SELECTOR = '[data-message-author-role="user"]';
  const ASSISTANT_SELECTOR = '[data-message-author-role="assistant"]';

  const TURN_CANDIDATES = [
    'article[data-testid^="conversation-turn"]',
    '[data-testid^="conversation-turn"]',
    'article',
    // Last resort: synthesise turns from the flat role list.
    root => synthesiseTurns(root)
  ];

  const ROOT_CANDIDATES = [
    'main div.flex.flex-col.text-sm',
    'main [role="presentation"]',
    'main',
    () => document.body
  ];

  const BODY_CANDIDATES = [
    '.markdown',
    '[class*="markdown"]',
    '[data-message-content]',
    '.prose',
    '[class*="prose"]',
    node => largestTextBlock(node)
  ];

  const HEADER_CANDIDATES = [
    '[data-testid="share-chat-button"]',
    'button[aria-label="Share"]',
    'button[aria-label*="Share conversation" i]',
    'button[title="Share"]',
    () => headerFallback()
  ];

  /**
   * ChatGPT does not always wrap a user/assistant pair in one container, so
   * this pairs the flat role list into synthetic turn elements by returning
   * the user node and letting `assistantNodes` walk forward from it.
   */
  function synthesiseTurns(root) {
    const scope = root instanceof Element || root instanceof Document ? root : document;
    return Array.from(scope.querySelectorAll(USER_SELECTOR));
  }

  function largestTextBlock(node) {
    if (!(node instanceof Element)) return null;
    const candidates = Array.from(node.querySelectorAll('div')).filter(el => {
      const text = (el.innerText || '').trim();
      return text.length > 0 && !el.querySelector(ROLE_SELECTOR) && !el.closest('[data-cgx-ui]');
    });
    candidates.sort((a, b) => (b.innerText?.length || 0) - (a.innerText?.length || 0));
    return candidates[0] || node;
  }

  function headerFallback() {
    const candidates = [];
    for (const element of document.querySelectorAll('header, nav, [role="banner"], main > div')) {
      const rect = element.getBoundingClientRect();
      if (rect.top > 140 || rect.bottom > 240 || rect.width < 240) continue;
      const buttons = Array.from(element.querySelectorAll('button'))
        .filter(button => visible(button) && !button.closest('article') && !button.closest('[data-cgx-ui]'));
      if (!buttons.length || buttons.length > 16) continue;
      const right = Math.max(...buttons.map(button => button.getBoundingClientRect().right));
      candidates.push({ element, score: right + (rect.top < 90 ? 300 : 0) });
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.element || null;
  }

  function turnOwner(node) {
    if (!(node instanceof Element)) return null;
    return node.closest('article, [data-testid^="conversation-turn"], [data-message-id]') || node.parentElement;
  }

  const adapter = defineAdapter({
    id: 'chatgpt',
    label: 'ChatGPT',
    virtualized: false,

    matches(url) {
      return /(^|\.)chatgpt\.com$/.test(url.hostname) || /(^|\.)chat\.openai\.com$/.test(url.hostname);
    },

    conversationRoot() {
      return resolve(document, ROOT_CANDIDATES, 'chatgpt.root') || document.body;
    },

    turnContainers() {
      const found = resolve(document, TURN_CANDIDATES, 'chatgpt.turns', {
        all: true,
        filter: el => el.querySelector(ROLE_SELECTOR) || el.matches(ROLE_SELECTOR)
      });
      // Keep only containers that actually open a turn (contain a user message),
      // so a regenerated answer does not register as its own turn.
      const turns = found.filter(el => el.matches(USER_SELECTOR) || el.querySelector(USER_SELECTOR));
      return turns.length ? turns : found;
    },

    userNode(turn) {
      if (!(turn instanceof Element)) return null;
      if (turn.matches(USER_SELECTOR)) return turn;
      return turn.querySelector(USER_SELECTOR);
    },

    assistantNodes(turn) {
      if (!(turn instanceof Element)) return [];
      const inside = Array.from(turn.querySelectorAll(ASSISTANT_SELECTOR));
      if (inside.length) return inside;

      // Synthetic-turn mode: walk forward through the flat role list until the
      // next user message, collecting every assistant node in between.
      const all = Array.from(document.querySelectorAll(ROLE_SELECTOR));
      const start = all.indexOf(turn.matches(USER_SELECTOR) ? turn : turn.querySelector(USER_SELECTOR));
      if (start < 0) return [];
      const out = [];
      for (let i = start + 1; i < all.length; i++) {
        if (all[i].getAttribute('data-message-author-role') === 'user') break;
        out.push(all[i]);
      }
      return out;
    },

    messageBody(node) {
      if (!(node instanceof Element)) return null;
      return resolve(node, BODY_CANDIDATES, 'chatgpt.body') || node;
    },

    isStreaming(node) {
      const owner = turnOwner(node);
      if (!owner) return false;
      if (owner.querySelector('[data-testid="stop-button"], button[aria-label*="Stop" i]')) return true;
      if (document.querySelector('[data-testid="stop-button"], button[data-testid="composer-speech-button-container"] ~ [data-testid="stop-button"]')) {
        // A global stop button only means *this* answer is streaming when it is
        // the last assistant node on the page.
        const assistants = Array.from(document.querySelectorAll(ASSISTANT_SELECTOR));
        return assistants.length > 0 && assistants[assistants.length - 1] === node;
      }
      return node.getAttribute?.('data-is-streaming') === 'true';
    },

    stableKey(node) {
      if (!(node instanceof Element)) return 'unknown';
      const owner = turnOwner(node) || node;
      const messageId = node.getAttribute('data-message-id') || owner.getAttribute?.('data-message-id');
      if (messageId) return 'message:' + messageId;
      const testId = owner.getAttribute?.('data-testid');
      if (testId) return 'testid:' + testId;
      return 'hash:' + contentHash((node.innerText || '').slice(0, 400));
    },

    conversationTitle() {
      const cleaned = document.title.replace(/\s*[-–—|]\s*ChatGPT\s*$/i, '').trim();
      if (cleaned && cleaned.toLowerCase() !== 'chatgpt') return cleaned;
      const firstUser = document.querySelector(USER_SELECTOR);
      const text = (firstUser?.innerText || '').replace(/\s+/g, ' ').trim();
      return text ? text.slice(0, 100) : 'ChatGPT Conversation';
    },

    headerAnchor() {
      const anchor = resolve(document, HEADER_CANDIDATES, 'chatgpt.header', {
        filter: el => present(el) && !el.closest('article')
      });
      if (!anchor) return null;
      const button = anchor.matches?.('button') ? anchor : anchor.querySelector?.('button') || anchor;
      return button.closest('[data-testid="share-chat-button"]') || button;
    },

    answerActionRow(node) {
      const owner = turnOwner(node);
      if (!owner) return null;
      const buttons = Array.from(owner.querySelectorAll('button')).filter(button =>
        present(button) &&
        !button.closest('[data-cgx-ui]') &&
        !button.closest('pre, code, .markdown, [class*="markdown"]')
      );
      if (!buttons.length) return null;

      const known = buttons.find(button =>
        /^(copy|read aloud|good response|bad response|regenerate|retry|share|more)(\b|\s|$)/.test(actionLabel(button))
      );
      const seed = known || buttons[buttons.length - 1];
      let current = seed.parentElement;
      let depth = 0;
      while (current && current !== owner && depth < 4) {
        const count = current.querySelectorAll('button').length;
        if (count >= 2 && count <= 10 && present(current)) return current;
        current = current.parentElement;
        depth += 1;
      }
      return seed.parentElement && present(seed.parentElement) ? seed.parentElement : null;
    },

    attachments(turn) {
      if (!(turn instanceof Element)) return [];
      return Array.from(turn.querySelectorAll('[data-testid*="attachment" i], [class*="attachment" i]'));
    }
  });

  globalThis.ThreadExporterPlatforms = globalThis.ThreadExporterPlatforms || [];
  globalThis.ThreadExporterPlatforms.push(adapter);
})();
