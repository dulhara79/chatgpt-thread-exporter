const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, fixture, plain } = require('./helpers/harness.js');

function findBlock(blocks, type) {
  for (const block of blocks || []) {
    if (block.type === type) return block;
    const children = (block.blocks || []).concat((block.items || []).flatMap(item => item.blocks));
    const hit = findBlock(children, type);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------- ChatGPT

test('ChatGPT: registry resolves the adapter by hostname', () => {
  const page = loadPage(fixture('chatgpt-thread.html'), 'https://chatgpt.com/c/abc');
  assert.equal(page.adapter.id, 'chatgpt');
  assert.equal(page.adapter.virtualized, false);
});

test('ChatGPT: turns, roles and title resolve', () => {
  const page = loadPage(fixture('chatgpt-thread.html'), 'https://chatgpt.com/c/abc');
  const turns = page.adapter.turnContainers();
  assert.equal(turns.length, 1);
  assert.ok(page.adapter.userNode(turns[0]));
  assert.equal(page.adapter.assistantNodes(turns[0]).length, 1);
  assert.equal(page.adapter.conversationTitle(), 'Deployment plan');
});

test('ChatGPT: stable keys survive a re-render of the same turn', () => {
  const page = loadPage(fixture('chatgpt-thread.html'), 'https://chatgpt.com/c/abc');
  const turn = page.adapter.turnContainers()[0];
  const before = page.adapter.stableKey(turn);
  // React swaps class names constantly; identity must not depend on them.
  turn.className = 'totally-different-classes';
  assert.equal(page.adapter.stableKey(turn), before);
});

test('ChatGPT: DOM extraction keeps list nesting and list-item code', () => {
  const page = loadPage(fixture('chatgpt-thread.html'), 'https://chatgpt.com/c/abc');
  const turn = page.adapter.turnContainers()[0];
  const body = page.adapter.messageBody(page.adapter.assistantNodes(turn)[0]);
  const blocks = page.extract.fromMessage(body, {});

  const list = findBlock(blocks, 'list');
  assert.ok(list, 'the ordered list is extracted');
  assert.equal(list.ordered, true);
  assert.equal(list.items.length, 2);

  assert.ok(findBlock(list.items[0].blocks, 'code'), 'step 1 owns its code block');
  assert.ok(findBlock(list.items[1].blocks, 'list'), 'step 2 owns its nested bullet list');
});

test('ChatGPT: table alignment and nested inline marks are extracted', () => {
  const page = loadPage(fixture('chatgpt-thread.html'), 'https://chatgpt.com/c/abc');
  const turn = page.adapter.turnContainers()[0];
  const blocks = page.extract.fromMessage(page.adapter.messageBody(page.adapter.assistantNodes(turn)[0]), {});

  const table = findBlock(blocks, 'table');
  assert.deepEqual(plain(table.align), ['left', 'right']);

  const flat = JSON.stringify(blocks);
  assert.ok(flat.includes('"type":"link"'), 'links are preserved');
  assert.ok(flat.includes('"type":"em"'), 'emphasis nested inside strong is preserved');
});

test('ChatGPT: extension UI is excluded from extracted content', () => {
  const page = loadPage(fixture('chatgpt-thread.html'), 'https://chatgpt.com/c/abc');
  const body = page.document.querySelector('[data-message-author-role="assistant"] .markdown');
  const injected = page.document.createElement('div');
  injected.setAttribute('data-cgx-ui', 'true');
  injected.textContent = 'EXPORT CONTROL';
  body.appendChild(injected);

  const blocks = page.extract.fromMessage(body, {});
  assert.ok(!page.IR.blocksToPlainText(blocks).includes('EXPORT CONTROL'));
});

// ---------------------------------------------------------------- Claude

test('Claude: registry resolves the adapter and flags virtualization', () => {
  const page = loadPage(fixture('claude-thread.html'), 'https://claude.ai/chat/xyz');
  assert.equal(page.adapter.id, 'claude');
  assert.equal(page.adapter.virtualized, true, 'Claude must be treated as virtualized (F-04)');
});

test('Claude: turns pair inside their container rather than by document order', () => {
  const page = loadPage(fixture('claude-thread.html'), 'https://claude.ai/chat/xyz');
  const turns = page.adapter.turnContainers();
  assert.equal(turns.length, 2);
  assert.equal(page.adapter.userNode(turns[0]).textContent.trim(), 'Summarise the findings.');
  assert.equal(page.adapter.assistantNodes(turns[0]).length, 1);
});

test('Claude: title strips the site suffix', () => {
  const page = loadPage(fixture('claude-thread.html'), 'https://claude.ai/chat/xyz');
  assert.equal(page.adapter.conversationTitle(), 'Research notes');
});

test('F-03: a streaming answer is reported as streaming', () => {
  const page = loadPage(fixture('claude-thread.html'), 'https://claude.ai/chat/xyz');
  const turns = page.adapter.turnContainers();
  assert.equal(page.adapter.isStreaming(page.adapter.assistantNodes(turns[0])[0]), false);
  assert.equal(page.adapter.isStreaming(page.adapter.assistantNodes(turns[1])[0]), true);
});

test('F-31: a hover-revealed (opacity 0) action row is still found', () => {
  const page = loadPage(fixture('claude-thread.html'), 'https://claude.ai/chat/xyz');
  const answer = page.adapter.assistantNodes(page.adapter.turnContainers()[0])[0];
  const row = page.adapter.answerActionRow(answer);
  assert.ok(row, 'opacity:0 must not be treated as absent on Claude');
  assert.ok(row.querySelector('button[aria-label="Copy"]'));
});

test('Claude: nested lists and Unicode survive DOM extraction', () => {
  const page = loadPage(fixture('claude-thread.html'), 'https://claude.ai/chat/xyz');
  const answer = page.adapter.assistantNodes(page.adapter.turnContainers()[0])[0];
  const blocks = page.extract.fromMessage(page.adapter.messageBody(answer), {});

  const list = findBlock(blocks, 'list');
  assert.ok(findBlock(list.items[0].blocks, 'list'), 'nested bullet survives');
  assert.ok(findBlock(blocks, 'code'), 'the fenced code block survives');

  const text = page.IR.blocksToPlainText(blocks);
  assert.ok(text.includes('සිංහල'));
  assert.ok(text.includes('한국어'));
});

test('Claude: selector diagnostics record which tier matched', () => {
  const page = loadPage(fixture('claude-thread.html'), 'https://claude.ai/chat/xyz');
  page.adapter.turnContainers();
  const snapshot = page.window.ThreadExporterAdapterKit.diagnostics.snapshot();
  assert.ok(Object.keys(snapshot.tierHits).some(key => key.startsWith('claude.turns#')));
});

test('an unsupported host resolves to no adapter', () => {
  const page = loadPage('<html><body></body></html>', 'https://example.com/');
  assert.equal(page.adapter, null);
});
