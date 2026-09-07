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

  const { resolve, visible, present, actionLabel, contentHash, defineAdapter,
    harvestVirtualizedTurns, groupTurns, outermost } = kit;

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

    // ChatGPT windows long conversations and fetches older messages lazily on
    // scroll, exactly like Claude does. Treating it as non-virtualized is what
    // made whole-thread exports silently return only the loaded section.
    virtualized: true,

    matches(url) {
      return /(^|\.)chatgpt\.com$/.test(url.hostname) || /(^|\.)chat\.openai\.com$/.test(url.hostname);
    },

    conversationRoot() {
      return resolve(document, ROOT_CANDIDATES, 'chatgpt.root') || document.body;
    },

    /** Flat, document-ordered message list; pairing happens in the kit. */
    messages() {
      const nodes = outermost(resolve(document, [
        ROLE_SELECTOR,
        () => Array.from(document.querySelectorAll('[data-message-id]')),
        () => Array.from(document.querySelectorAll(TURN_CANDIDATES[0]))
      ], 'chatgpt.messages', { all: true }));

      return nodes.map(node => ({
        node,
        role: node.getAttribute('data-message-author-role') === 'user' ? 'user'
          : node.getAttribute('data-message-author-role') === 'assistant' ? 'assistant'
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

      // Walk the flat list forward to the next user message.
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
      const scope = turnOwner(turn) || turn;
      const found = Array.from(scope.querySelectorAll([
        '[data-testid*="attachment" i]',
        '[data-testid*="file" i]',
        '[class*="attachment" i]',
        // Long pasted text becomes its own card on ChatGPT too.
        '[class*="pasted" i]'
      ].join(', ')));
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
