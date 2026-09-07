/**
 * Platform registry. The only place that decides which adapter is in play.
 */
(() => {
  'use strict';

  function detect(href = globalThis.location?.href || '') {
    const adapters = globalThis.ThreadExporterPlatforms || [];
    let url;
    try {
      url = new URL(href);
    } catch {
      return null;
    }
    for (const adapter of adapters) {
      try {
        if (adapter.matches(url)) return adapter;
      } catch {}
    }
    return null;
  }

  function byId(id) {
    return (globalThis.ThreadExporterPlatforms || []).find(adapter => adapter.id === id) || null;
  }

  function list() {
    return (globalThis.ThreadExporterPlatforms || []).map(adapter => ({
      id: adapter.id,
      label: adapter.label,
      virtualized: adapter.virtualized
    }));
  }

  globalThis.ThreadExporterRegistry = Object.freeze({ detect, byId, list });
})();
