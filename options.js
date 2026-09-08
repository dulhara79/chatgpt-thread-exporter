'use strict';

const DEFAULTS = {
  pageSize: 'A4',
  defaultFormat: 'pdf',
  includeToc: true,
  embedImages: true,
  includeArtifacts: true,
  includeThinking: false
};

const BOOLEAN_KEYS = ['includeToc', 'embedImages', 'includeArtifacts', 'includeThinking'];
const $ = id => document.getElementById(id);

async function load() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  for (const [key, value] of Object.entries({ ...DEFAULTS, ...stored })) {
    const field = $(key);
    if (field) field.value = String(value);
  }
}

async function save() {
  const payload = {};
  for (const key of Object.keys(DEFAULTS)) {
    const field = $(key);
    if (!field) continue;
    payload[key] = BOOLEAN_KEYS.includes(key) ? field.value === 'true' : field.value;
  }
  await chrome.storage.sync.set(payload);
  $('status').textContent = 'Saved.';
  setTimeout(() => { $('status').textContent = ''; }, 2000);
}

async function diagnose() {
  const report = $('report');
  report.hidden = false;
  report.textContent = 'Collecting…';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab.');
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'CGX_DIAGNOSTICS' });
    if (!response?.ok) throw new Error(response?.error || 'The content script did not respond.');

    // `tierHits` keys look like "claude.userNode#2" — a tier above 1 means the
    // preferred selector stopped matching and the site probably changed.
    const degraded = Object.entries(response.selectors?.tierHits || {})
      .filter(([key]) => !key.endsWith('#1'))
      .map(([key, count]) => `${key} (${count}x)`);

    report.textContent = JSON.stringify({
      version: response.version,
      platform: response.platform,
      virtualized: response.virtualized,
      turnsInDom: response.turns,
      degradedSelectors: degraded,
      missedSelectors: response.selectors?.misses || {},
      notes: response.selectors?.notes || [],
      effectiveSettings: response.effectiveSettings || {},
      artifactDiagnostics: response.artifactDiagnostics || null,
      userAgent: response.userAgent
    }, null, 2);
    $('copyReport').hidden = false;
  } catch (error) {
    report.textContent = 'Could not read the page: ' + (error?.message || error) +
      '\n\nOpen a ChatGPT or Claude conversation in the active tab and try again.';
  }
}

$('save').addEventListener('click', save);
$('diagnose').addEventListener('click', diagnose);
$('copyReport').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('report').textContent);
  $('status').textContent = 'Report copied.';
  setTimeout(() => { $('status').textContent = ''; }, 2000);
});

load();
