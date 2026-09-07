const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, fixture, plain } = require('./helpers/harness.js');

function artifactText(page, card) {
  const block = page.extract.artifactBlock(card);
  return page.IR.blocksToPlainText(block.blocks);
}

test('Claude discovers a title-only visual artifact card without artifact wording', () => {
  const page = loadPage(
    `<html><body>
      <div data-test-render-count="1"><div data-testid="user-message"><p>Q</p></div></div>
      <div data-test-render-count="2"><div class="font-claude-response">
        <button class="rounded-card"><svg width="16" height="16"></svg><span>Research report</span></button>
      </div></div>
    </body></html>`,
    'https://claude.ai/chat/modern'
  );
  const answer = page.adapter.messages().find(message => message.role === 'assistant').node;
  assert.equal(page.adapter.artifacts(answer).length, 1,
    'a card-like title button with an icon inside an assistant answer must remain discoverable');
});

test('Claude capture correlates multiple title-only cards to distinct panel bodies', async () => {
  const page = loadPage(fixture('claude-artifact-modern.html'), 'https://claude.ai/chat/modern');
  const answer = page.adapter.messages().find(message => message.role === 'assistant').node;
  const panel = page.document.querySelector('.right-side-artifact-panel');
  const content = panel.querySelector('[data-testid="artifact-content"]');

  for (const button of answer.querySelectorAll('button')) {
    button.addEventListener('click', () => {
      panel.hidden = false;
      const kind = button.getAttribute('data-cgx-fixture-artifact');
      content.innerHTML = kind === 'report'
        ? '<article class="prose"><h2>Projects and Artifacts</h2><p>Scheduled Customize Pinned. REPORT BODY.</p></article>'
        : '<pre><code class="language-python">def main():\n    return "CODE BODY"</code></pre>';
    });
  }

  const cards = await page.adapter.captureArtifacts(answer);
  assert.equal(cards.length, 2);
  assert.ok(artifactText(page, cards[0]).includes('REPORT BODY.'));
  assert.ok(!artifactText(page, cards[0]).includes('CODE BODY'));
  assert.ok(artifactText(page, cards[1]).includes('CODE BODY'));
  assert.ok(!artifactText(page, cards[1]).includes('REPORT BODY.'));
  assert.ok(!artifactText(page, cards[0]).includes('View all conversations'));
});

test('Claude captures Markdown attachment body from an accessible text URL', async () => {
  const page = loadPage(fixture('claude-artifact-modern.html'), 'https://claude.ai/chat/modern');
  const question = page.adapter.messages().find(message => message.role === 'user').node;
  const items = await page.adapter.captureAttachments(question);
  const md = items.find(item => /audit-notes\.md/i.test(
    item.getAttribute('aria-label') || item.textContent || ''
  ));
  assert.ok(md, 'Markdown attachment is discovered');
  assert.ok(md.__cgxAttachmentContent, 'Markdown body is materialized for export');
  const text = page.extract.preservedText(md.__cgxAttachmentContent);
  assert.ok(text.includes('# Audit Notes'));
  assert.ok(text.includes('print("ok")'));
});

test('PDF replaces unsupported emoji scalars with readable fallback instead of a blank glyph', () => {
  const page = loadPage('<html><body></body></html>', 'https://chatgpt.com/c/emoji');
  const turns = [{
    index: 0,
    question: { blocks: [{ type: 'paragraph', inline: [{ type: 'text', text: 'Q' }] }] },
    answers: [{
      blocks: [{ type: 'paragraph', inline: [{ type: 'text', text: 'unsupported \u{1FFFF} marker' }] }]
    }]
  }];
  const definition = page.exporter.buildPdfDefinition({ title: 'T', platformLabel: 'ChatGPT' }, turns);
  const raw = JSON.stringify(definition);
  assert.ok(raw.includes('[U+1FFFF]'), 'unsupported scalar must be made visible as a textual fallback');
  assert.ok(!raw.includes('\u{1FFFF}'), 'unsupported glyph must not be sent to pdfmake');
});

test('PDF keeps source code exact and lets long questions paginate', () => {
  const page = loadPage('<html><body></body></html>', 'https://chatgpt.com/c/code');
  const longCode = 'const value = "' + 'abcdefghij'.repeat(80) + '";';
  const longQuestion = 'question '.repeat(3000);
  const definition = page.exporter.buildPdfDefinition(
    { title: 'T', platformLabel: 'ChatGPT' },
    [{
      index: 0,
      question: { blocks: [{ type: 'paragraph', inline: [{ type: 'text', text: longQuestion }] }] },
      answers: [{ blocks: [{ type: 'code', lang: 'js', text: longCode, diagram: false }] }]
    }]
  );

  const find = (node, predicate) => {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = find(child, predicate);
        if (hit) return hit;
      }
      return null;
    }
    if (predicate(node)) return node;
    for (const value of Object.values(node)) {
      const hit = find(value, predicate);
      if (hit) return hit;
    }
    return null;
  };

  const code = find(definition.content, node => node.cgxPreformatted);
  assert.equal(code.cgxPreformatted.text, longCode);
  assert.ok(!/[↴↳]/u.test(code.cgxPreformatted.text));

  const question = definition.content.find(node =>
    Array.isArray(node.stack) && node.stack.some(child => child?.tocText)
  );
  assert.ok(question);
  assert.notEqual(question.unbreakable, true);
});


test('ChatGPT captures an assistant-generated Markdown file from an accessible data URL', async () => {
  const page = loadPage(
    `<html><body><main>
      <article data-testid="conversation-turn-1">
        <div data-message-author-role="user"><div class="markdown"><p>Create report.</p></div></div>
      </article>
      <article data-testid="conversation-turn-2">
        <div data-message-author-role="assistant"><div class="markdown">
          <p>Done.</p>
          <div class="file-card">
            <a download="full-report.md"
               href="data:text/markdown,%23%20Full%20Report%0A%0A-%20finding%0A%0A%60%60%60js%0Aconsole.log(%22ok%22)%0A%60%60%60">
              full-report.md
            </a>
          </div>
        </div></div>
      </article>
    </main></body></html>`,
    'https://chatgpt.com/c/generated-md-data'
  );

  const assistant = page.adapter.messages().find(message => message.role === 'assistant').node;
  const items = page.adapter.attachments(assistant);
  assert.equal(items.length, 1, 'generated Markdown link is discovered');

  const captured = await page.adapter.captureAttachments(assistant);
  assert.ok(captured[0].__cgxAttachmentContent, 'generated Markdown body is snapshotted');
  const text = page.extract.preservedText(captured[0].__cgxAttachmentContent);
  assert.ok(text.includes('# Full Report'));
  assert.ok(text.includes('console.log("ok")'));
});
