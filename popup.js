const state = { data: null, selected: new Set() };
const exporter = globalThis.ChatGPTExporter;
const $ = id => document.getElementById(id);
const statusEl = $('status');
const turnsEl = $('turns');
const metaEl = $('meta');

function setStatus(message, error = false) {
  statusEl.textContent = message;
  statusEl.className = `status${error ? ' error' : ''}`;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>\"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function shortText(value, limit = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function updateCount() {
  $('count').textContent = String(state.selected.size);
  for (const id of ['md', 'docx', 'pdf']) $(id).disabled = state.selected.size === 0;
}

function render() {
  turnsEl.innerHTML = '';
  if (!state.data?.turns?.length) {
    turnsEl.innerHTML = '<div style="padding:14px;font-size:12px;color:#6b6c70">No Q&amp;A turns found on this page.</div>';
    metaEl.hidden = true;
    updateCount();
    return;
  }

  metaEl.hidden = false;
  metaEl.innerHTML = `<strong>${escapeHtml(state.data.title)}</strong><span>${state.data.turns.length} Q&amp;A turn(s) found</span>`;

  state.data.turns.forEach((turn, i) => {
    const row = document.createElement('label');
    row.className = 'turn';
    row.innerHTML = `
      <input type="checkbox" data-id="${turn.id}" ${state.selected.has(turn.id) ? 'checked' : ''} />
      <div>
        <div class="q">${i + 1}. ${escapeHtml(shortText(turn.question.text, 125))}</div>
        <div class="a">${escapeHtml(shortText((turn.answers || []).map(a => a.text).join(' '), 135))}</div>
      </div>`;
    row.querySelector('input').addEventListener('change', event => {
      event.target.checked ? state.selected.add(turn.id) : state.selected.delete(turn.id);
      updateCount();
    });
    turnsEl.appendChild(row);
  });
  updateCount();
}

async function readCurrentTab() {
  setStatus('Reading this ChatGPT tab…');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url || '')) {
      throw new Error('Open a ChatGPT conversation tab first.');
    }
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'CHATGPT_EXPORTER_EXTRACT' });
    if (!response?.ok) throw new Error(response?.error || 'Could not read the conversation. Refresh the ChatGPT page and try again.');
    state.data = response;
    state.selected = new Set(response.turns.map(turn => turn.id));
    setStatus(`Ready. ${response.turns.length} turn(s) found.`);
    render();
  } catch (error) {
    state.data = null;
    state.selected.clear();
    render();
    setStatus(error?.message || String(error), true);
  }
}

function selectedTurns() {
  return (state.data?.turns || []).filter(turn => state.selected.has(turn.id));
}

function pageSize() {
  return $('page-size')?.value || 'A4';
}

$('refresh').addEventListener('click', readCurrentTab);
$('all').addEventListener('click', () => {
  if (!state.data) return;
  state.selected = new Set(state.data.turns.map(turn => turn.id));
  render();
});
$('none').addEventListener('click', () => {
  state.selected.clear();
  render();
});

$('md').addEventListener('click', () => {
  const turns = selectedTurns();
  if (!turns.length) return;
  exporter.exportMarkdown(state.data, turns);
  setStatus('Markdown exported.');
});

$('docx').addEventListener('click', async () => {
  const turns = selectedTurns();
  if (!turns.length) return;
  try {
    await exporter.exportDocx(state.data, turns, { pageSize: pageSize() });
    setStatus('Word document exported (' + pageSize() + ').');
  } catch (error) {
    setStatus(`Word export failed: ${error?.message || error}`, true);
  }
});

$('pdf').addEventListener('click', () => {
  const turns = selectedTurns();
  if (!turns.length) return;
  try {
    exporter.exportPdf(state.data, turns, { pageSize: pageSize() });
    setStatus('Print view opened (' + pageSize() + ') — choose “Save as PDF”.');
  } catch (error) {
    setStatus(`PDF export failed: ${error?.message || error}`, true);
  }
});

readCurrentTab();
