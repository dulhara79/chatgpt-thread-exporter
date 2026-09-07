/**
 * Shared platform-adapter infrastructure.
 *
 * Nothing outside `src/platforms/` may reference a site-specific selector.
 * Adapters declare selectors as *ordered candidate tiers* so that a site
 * redesign degrades one tier at a time instead of failing outright, and so the
 * diagnostics report can say which tier actually fired.
 *
 * @typedef {Object} PlatformAdapter
 * @property {string} id
 * @property {string} label
 * @property {(url: URL) => boolean} matches
 * @property {() => Element|null} conversationRoot
 * @property {() => {node: Element, role: 'user'|'assistant'}[]} messages
 * @property {() => Element[]} turnContainers  derived from messages(); do not implement
 * @property {(turn: Element) => Element|null} userNode
 * @property {(turn: Element) => Element[]} assistantNodes
 * @property {(node: Element) => Element|null} messageBody
 * @property {(node: Element) => boolean} isStreaming
 * @property {(node: Element) => string} stableKey
 * @property {() => string} conversationTitle
 * @property {() => Element|null} headerAnchor
 * @property {(node: Element) => Element|null} answerActionRow
 * @property {(turn: Element) => Element[]} artifacts
 * @property {(node: Element) => Element[]} thinkingBlocks
 * @property {(turn: Element) => Element[]} attachments
 * @property {boolean} virtualized
 * @property {(opts?: object) => Promise<{complete: boolean, turns: number}>} ensureFullyLoaded
 */
(() => {
  'use strict';

  /** Per-session selector-resolution counters, surfaced by the debug report. */
  const diagnostics = {
    tierHits: Object.create(null),
    misses: Object.create(null),
    notes: []
  };

  function recordHit(name, tier) {
    const key = name + '#' + tier;
    diagnostics.tierHits[key] = (diagnostics.tierHits[key] || 0) + 1;
  }

  function recordMiss(name) {
    diagnostics.misses[name] = (diagnostics.misses[name] || 0) + 1;
  }

  function note(message) {
    if (diagnostics.notes.length < 50) diagnostics.notes.push(String(message));
  }

  function resetDiagnostics() {
    diagnostics.tierHits = Object.create(null);
    diagnostics.misses = Object.create(null);
    diagnostics.notes = [];
  }

  function snapshotDiagnostics() {
    return JSON.parse(JSON.stringify(diagnostics));
  }

  /**
   * Resolve the first non-empty tier of a candidate list.
   * A candidate is either a CSS selector string or a function returning
   * Element | Element[] | null.
   *
   * @param {Element|Document} scope
   * @param {(string|Function)[]} candidates
   * @param {string} name  diagnostics label, e.g. 'claude.userNode'
   * @param {{all?: boolean, filter?: (el: Element) => boolean}} [options]
   * @returns {Element|Element[]|null}
   */
  function resolve(scope, candidates, name, options = {}) {
    const all = Boolean(options.all);
    const filter = typeof options.filter === 'function' ? options.filter : () => true;
    const root = scope || document;

    for (let tier = 0; tier < candidates.length; tier++) {
      const candidate = candidates[tier];
      let found = [];
      try {
        if (typeof candidate === 'function') {
          const value = candidate(root);
          found = Array.isArray(value) ? value : value ? [value] : [];
        } else if (all) {
          found = Array.from(root.querySelectorAll(candidate));
        } else {
          const one = root.querySelector(candidate);
          found = one ? [one] : [];
        }
      } catch {
        found = [];
      }

      found = found.filter(el => el instanceof Element && filter(el));
      if (found.length) {
        recordHit(name, tier + 1);
        return all ? found : found[0];
      }
    }

    recordMiss(name);
    return all ? [] : null;
  }

  /** True when the element is rendered and occupies space. */
  function visible(element) {
    if (!(element instanceof Element) || !element.isConnected) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /**
   * Like `visible`, but tolerates `opacity: 0`.
   *
   * Claude's per-answer action row is hover-revealed and sits at opacity 0
   * until the turn is hovered. Treating that as "not present" is what makes a
   * naive port to Claude fail, so placement checks use this instead.
   */
  function present(element) {
    if (!(element instanceof Element) || !element.isConnected) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }

  /** Normalised, lowercased accessible label of a control. */
  function actionLabel(element) {
    if (!(element instanceof Element)) return '';
    return [
      element.getAttribute('aria-label') || '',
      element.getAttribute('title') || '',
      element.getAttribute('data-testid') || '',
      element.textContent || ''
    ].join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /** Stable 32-bit content hash, used as a last-resort turn identity. */
  function contentHash(value) {
    const text = String(value || '');
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  /**
   * Find the element that actually scrolls the conversation.
   *
   * Both platforms move this between releases, and it is sometimes a
   * descendant of the conversation root rather than an ancestor, so check both
   * directions and fall back to the tallest scrollable candidate.
   */
  function scrollParent(element) {
    const scrollable = el => {
      if (!(el instanceof Element)) return false;
      const overflow = getComputedStyle(el).overflowY;
      return (overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') &&
        el.scrollHeight > el.clientHeight + 8;
    };

    let current = element instanceof Element ? element : null;
    while (current && current !== document.body) {
      if (scrollable(current)) return current;
      current = current.parentElement;
    }

    // Nothing above scrolls: look for the tallest scrollable descendant.
    if (element instanceof Element) {
      const inner = Array.from(element.querySelectorAll('div, main, section'))
        .filter(scrollable)
        .sort((a, b) => b.scrollHeight - a.scrollHeight);
      if (inner.length) return inner[0];
    }

    const doc = document.scrollingElement || document.documentElement;
    if (doc && doc.scrollHeight > doc.clientHeight + 8) return doc;

    const anywhere = Array.from(document.querySelectorAll('div, main, section'))
      .filter(scrollable)
      .sort((a, b) => b.scrollHeight - a.scrollHeight);
    return anywhere[0] || doc;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Merge one window of turn keys into the running ordered list.
   *
   * We scroll upward, so each window overlaps the previous one and extends it
   * at the front. Anchoring on the first shared key keeps the final order
   * correct even though earlier elements have since been unmounted and can no
   * longer be compared with compareDocumentPosition.
   */
  function mergeWindow(order, windowKeys) {
    if (!order.length) {
      order.push(...windowKeys);
      return;
    }
    let anchorIndex = -1;
    let anchorPosition = -1;
    for (let i = 0; i < windowKeys.length; i++) {
      const position = order.indexOf(windowKeys[i]);
      if (position >= 0) {
        anchorIndex = i;
        anchorPosition = position;
        break;
      }
    }
    if (anchorIndex === -1) {
      // No overlap at all: this window sits entirely above what we have.
      order.unshift(...windowKeys);
      return;
    }
    if (anchorIndex > 0) order.splice(anchorPosition, 0, ...windowKeys.slice(0, anchorIndex));
    for (const key of windowKeys.slice(anchorIndex)) {
      if (!order.includes(key)) order.push(key);
    }
  }

  /**
   * Scroll the whole conversation into memory (F-04).
   *
   * Both platforms window their message list, and both fetch older messages
   * lazily when you reach the top, so this has to do two different kinds of
   * waiting: a short settle after each scroll step for the virtualizer to
   * render, and a longer wait at the very top for a network page to arrive.
   * Unmounted elements stay reachable because the Map holds a reference, which
   * keeps their detached subtree alive for later extraction.
   *
   * @param {PlatformAdapter} adapter
   * @param {{maxSteps?: number, settleMs?: number, lazyWaitMs?: number, onProgress?: Function, signal?: AbortSignal}} [options]
   */
  async function harvestVirtualizedTurns(adapter, options = {}) {
    const maxSteps = Number(options.maxSteps || 600);
    const settleMs = Number(options.settleMs || 140);
    const lazyWaitMs = Number(options.lazyWaitMs || 3000);

    const root = adapter.conversationRoot();
    const scroller = scrollParent(root);
    const startTop = scroller.scrollTop;

    /** @type {Map<string, Element>} */
    const seen = new Map();
    /** @type {string[]} */
    const order = [];

    const collect = () => {
      const windowKeys = [];
      for (const message of adapter.messages()) {
        const key = adapter.stableKey(message.node);
        // A remount replaces the stale node under the same key.
        seen.set(key, message);
        windowKeys.push(key);
      }
      mergeWindow(order, windowKeys);
      return windowKeys.length;
    };

    const report = (stage, steps) => {
      try {
        options.onProgress?.({ stage, turns: seen.size, steps, maxSteps });
      } catch {}
    };

    collect();
    report('harvest', 0);

    let stagnantRounds = 0;
    let complete = false;
    let steps = 0;

    while (steps < maxSteps) {
      if (options.signal?.aborted) break;

      const beforeCount = seen.size;
      const beforeTop = scroller.scrollTop;
      const beforeHeight = scroller.scrollHeight;

      if (beforeTop <= 2) {
        // We are at the top. Older messages may still be loading over the
        // network, which is exactly the case that silently truncated exports:
        // the loop used to stop here because scrollTop could not decrease.
        const grew = await waitForGrowth(scroller, seen, collect, lazyWaitMs, options);
        if (!grew) {
          complete = true;
          break;
        }
        report('harvest', steps);
        continue;
      }

      scroller.scrollTop = Math.max(0, beforeTop - Math.round(scroller.clientHeight * 0.75));
      await sleep(settleMs);
      collect();
      steps += 1;
      report('harvest', steps);

      const movedOrGrew =
        seen.size !== beforeCount ||
        scroller.scrollTop !== beforeTop ||
        scroller.scrollHeight !== beforeHeight;
      stagnantRounds = movedOrGrew ? 0 : stagnantRounds + 1;

      // Four consecutive rounds with no scroll movement, no height change and
      // no new turns means the scroller genuinely cannot go higher.
      if (stagnantRounds >= 4) {
        complete = scroller.scrollTop <= 2;
        break;
      }
    }

    // Put the reader back where they were.
    scroller.scrollTop = startTop;
    await sleep(40);
    collect();

    const messages = order.map(key => seen.get(key)).filter(item => item?.node instanceof Element);
    if (!complete) note('Harvest stopped before reaching the top of the conversation.');

    return { messages, turns: groupTurns(messages), complete, steps, scroller };
  }

  /**
   * At the top of the list, wait for lazily fetched older messages.
   * Resolves true if anything new appeared, false if the thread is fully loaded.
   */
  async function waitForGrowth(scroller, seen, collect, timeoutMs, options) {
    const startedAt = Date.now();
    const startHeight = scroller.scrollHeight;
    const startCount = seen.size;

    while (Date.now() - startedAt < timeoutMs) {
      if (options.signal?.aborted) return false;
      await sleep(160);
      collect();
      if (seen.size > startCount) return true;
      if (scroller.scrollHeight > startHeight + 40) {
        // Content was prepended; step down so the next loop can scroll up again.
        scroller.scrollTop = Math.min(scroller.scrollHeight, scroller.clientHeight);
        return true;
      }
      // Nudge the loader: some implementations only fetch on an actual event.
      if (scroller.scrollTop === 0) scroller.scrollTop = 1;
    }
    return false;
  }

  /**
   * Remove nodes that are contained by another node in the same list.
   * Selector tiers routinely match both a wrapper and its inner body.
   */
  function outermost(nodes) {
    const list = nodes.filter(node => node instanceof Element);
    return list.filter(node => !list.some(other => other !== node && other.contains(node)));
  }

  /**
   * Group a flat, document-ordered message list into question/answer turns.
   *
   * Deliberately NOT based on a per-turn container element. Neither platform
   * guarantees that a user message and its answer share a wrapper — assuming
   * they did is what produced turns with a question and zero answers.
   *
   * @param {{node: Element, role: 'user'|'assistant'}[]} messages
   */
  function groupTurns(messages) {
    const turns = [];
    let current = null;

    for (const message of messages || []) {
      if (!message?.node) continue;
      if (message.role === 'user') {
        current = { question: message.node, answers: [] };
        turns.push(current);
      } else {
        // An assistant message before any user message (a shared link opening
        // mid-thread, or a system greeting) still deserves a turn.
        if (!current) {
          current = { question: null, answers: [] };
          turns.push(current);
        }
        current.answers.push(message.node);
      }
    }

    return turns;
  }

  /** Fills in the optional half of the adapter interface. */
  function defineAdapter(definition) {
    const base = {
      virtualized: false,
      artifacts: () => [],
      thinkingBlocks: () => [],
      attachments: () => [],
      answerActionRow: () => null,
      headerAnchor: () => null,
      /** Derived from `messages()`; adapters no longer implement this. */
      turnContainers() {
        return groupTurns(this.messages()).map(turn => turn.question || turn.answers[0]).filter(Boolean);
      },
      async ensureFullyLoaded() {
        const messages = this.messages();
        return { complete: true, messages, turns: groupTurns(messages) };
      }
    };
    return Object.freeze(Object.assign(Object.create(null), base, definition));
  }

  globalThis.ThreadExporterAdapterKit = Object.freeze({
    resolve,
    visible,
    present,
    actionLabel,
    contentHash,
    scrollParent,
    sleep,
    harvestVirtualizedTurns,
    mergeWindow,
    groupTurns,
    outermost,
    defineAdapter,
    diagnostics: {
      snapshot: snapshotDiagnostics,
      reset: resetDiagnostics,
      note,
      recordHit,
      recordMiss
    }
  });
})();
