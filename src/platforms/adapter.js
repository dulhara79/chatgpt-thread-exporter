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
 * @property {() => Element[]} turnContainers
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
   * Find the nearest scrollable ancestor. Both platforms move their scroll
   * container between releases, so this is derived rather than hard-coded.
   */
  function scrollParent(element) {
    let current = element instanceof Element ? element : null;
    while (current && current !== document.body) {
      const style = getComputedStyle(current);
      const overflow = style.overflowY;
      if ((overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') &&
        current.scrollHeight > current.clientHeight + 4) {
        return current;
      }
      current = current.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Generic virtualization harvester (F-04).
   *
   * Scrolls the conversation container upward in viewport-sized steps,
   * accumulating turns by stable key so that unmounted turns captured earlier
   * survive. Returns turns in document order, plus whether the harvest reached
   * the top of the thread — the caller must surface `complete: false` to the
   * user rather than exporting silently.
   *
   * @param {PlatformAdapter} adapter
   * @param {{maxSteps?: number, settleMs?: number, onProgress?: Function, signal?: AbortSignal}} [options]
   */
  async function harvestVirtualizedTurns(adapter, options = {}) {
    const maxSteps = Number(options.maxSteps || 400);
    const settleMs = Number(options.settleMs || 130);
    const root = adapter.conversationRoot();
    const scroller = scrollParent(root);
    const startTop = scroller.scrollTop;
    /** @type {Map<string, Element>} */
    const seen = new Map();

    const collect = () => {
      for (const turn of adapter.turnContainers()) {
        const key = adapter.stableKey(turn);
        // Re-mounted nodes replace their stale predecessor under the same key.
        seen.set(key, turn);
      }
    };

    collect();

    let idleRounds = 0;
    let lastTop = Number.NaN;
    let steps = 0;
    let complete = false;

    while (steps < maxSteps) {
      if (options.signal?.aborted) break;
      if (scroller.scrollTop <= 1) {
        // Give the virtualizer one more settle at the very top.
        await sleep(settleMs);
        collect();
        complete = true;
        break;
      }

      scroller.scrollTop = Math.max(0, scroller.scrollTop - Math.round(scroller.clientHeight * 0.8));
      await sleep(settleMs);
      collect();

      idleRounds = scroller.scrollTop === lastTop ? idleRounds + 1 : 0;
      lastTop = scroller.scrollTop;
      steps += 1;

      try {
        options.onProgress?.({ stage: 'harvest', turns: seen.size, steps, maxSteps });
      } catch {}

      // Three consecutive no-move rounds means the scroller will not go higher.
      if (idleRounds >= 3) {
        complete = scroller.scrollTop <= 1;
        break;
      }
    }

    // Restore the reading position the user had before we hijacked the scroller.
    scroller.scrollTop = startTop;
    await sleep(30);
    collect();

    const ordered = Array.from(seen.values())
      .filter(el => el instanceof Element)
      .sort((a, b) => {
        if (a === b) return 0;
        const relation = a.compareDocumentPosition(b);
        if (relation & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (relation & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return 0;
      });

    if (!complete) note('Virtualized harvest stopped before reaching the top of the thread.');

    return { turns: ordered, complete, steps };
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
      async ensureFullyLoaded() {
        return { complete: true, turns: this.turnContainers().length };
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
