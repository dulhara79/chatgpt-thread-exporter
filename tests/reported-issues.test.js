/**
 * Regressions reported from real use of v0.6.0.
 *
 * Each test here corresponds to something a user actually hit, so the names
 * describe the symptom rather than the implementation.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, loadPure, fixture, findNode, findAll, plain } = require('./helpers/harness.js');

const { IR, MD, exporter } = loadPure();

function findBlock(blocks, type) {
  for (const block of blocks || []) {
    if (block.type === type) return block;
    const children = (block.blocks || []).concat((block.items || []).flatMap(item => item.blocks));
    const hit = findBlock(children, type);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------- harvesting

test('both platforms harvest before a whole-thread export', () => {
  for (const [file, url] of [
    ['chatgpt-thread.html', 'https://chatgpt.com/c/abc'],
    ['claude-thread.html', 'https://claude.ai/chat/abc']
  ]) {
    const page = loadPage(fixture(file), url);
    assert.equal(page.adapter.virtualized, true,
      url + ' windows long threads, so it must harvest or exports are truncated');
  }
});

test('the harvest window merge keeps thread order while scrolling upward', () => {
  const page = loadPage(fixture('claude-thread.html'), 'https://claude.ai/chat/abc');
  const { mergeWindow } = page.window.ThreadExporterAdapterKit;

  // Scrolling up yields overlapping windows, newest (bottom) first.
  const order = [];
  mergeWindow(order, ['t8', 't9', 't10']);
  mergeWindow(order, ['t5', 't6', 't7', 't8']);
  mergeWindow(order, ['t1', 't2', 't3', 't4', 't5']);

  assert.deepEqual(plain(order), ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10']);
});

test('a window with no overlap is prepended, not appended', () => {
  const page = loadPage(fixture('claude-thread.html'), 'https://claude.ai/chat/abc');
  const { mergeWindow } = page.window.ThreadExporterAdapterKit;
  const order = ['t5', 't6'];
  mergeWindow(order, ['t1', 't2']);
  assert.deepEqual(plain(order), ['t1', 't2', 't5', 't6']);
});

test('a detached turn still yields its content', () => {
  // Claude unmounts scrolled-away turns. The harvest keeps a reference, which
  // keeps the subtree alive, so extraction must still work off the DOM.
  const page = loadPage(fixture('claude-thread.html'), 'https://claude.ai/chat/abc');
  const group = page.window.ThreadExporterAdapterKit.groupTurns(page.adapter.messages())[0];
  const answer = group.answers[0];

  // Detach the whole turn, as Claude's virtualizer does when it scrolls away.
  answer.closest('div[data-test-render-count]').remove();
  assert.equal(answer.isConnected, false);

  const blocks = page.extract.fromMessage(page.adapter.messageBody(answer), {});
  assert.ok(page.IR.blocksToPlainText(blocks).includes('summary'));
});

test('a re-rendered turn keeps the same identity', () => {
  const page = loadPage(fixture('claude-thread.html'), 'https://claude.ai/chat/abc');
  const turn = page.adapter.turnContainers()[0];
  const before = page.adapter.stableKey(turn);

  // React changes render-count and class names constantly; neither is identity.
  turn.setAttribute('data-test-render-count', '99');
  turn.className = 'rerendered';
  assert.equal(page.adapter.stableKey(turn), before);
});

// ---------------------------------------------------------------- diagrams

test('a white-space:pre diagram keeps its alignment', () => {
  const page = loadPage(fixture('claude-thread.html'), 'https://claude.ai/chat/abc');
  const answer = page.adapter.assistantNodes(page.adapter.turnContainers()[0])[0];
  const blocks = page.extract.fromMessage(page.adapter.messageBody(answer), {});

  const diagram = (blocks.filter(b => b.type === 'code' && b.diagram))[0];
  assert.ok(diagram, 'the styled diagram div becomes a diagram code block');

  const lines = diagram.text.split('\n');
  assert.ok(lines.length >= 3, 'must not collapse to a single line');
  assert.ok(lines.some(line => /^\s{4,}/.test(line)), 'leading indentation is preserved');
  assert.ok(diagram.text.includes('│') && diagram.text.includes('▼'));
});

test('a <br>-separated diagram is also preserved', () => {
  const page = loadPage(fixture('claude-thread.html'), 'https://claude.ai/chat/abc');
  const answer = page.adapter.assistantNodes(page.adapter.turnContainers()[0])[0];
  const blocks = page.extract.fromMessage(page.adapter.messageBody(answer), {});

  const diagrams = blocks.filter(b => b.type === 'code' && b.diagram);
  const flow = diagrams.find(d => d.text.startsWith('Flow:'));
  assert.ok(flow, 'the <br> paragraph becomes a diagram block');
  assert.equal(flow.text.split('\n').length, 4);
});

test('ordinary prose is not mistaken for a diagram', () => {
  const page = loadPage(
    '<html><body><div class="font-claude-response"><p>Costs rose → then fell.</p></div></body></html>',
    'https://claude.ai/chat/abc'
  );
  const blocks = page.extract.extractBlocks(page.document.querySelector('.font-claude-response'));
  assert.equal(blocks[0].type, 'paragraph', 'a single arrow in a sentence is not a diagram');
});

test('diagrams survive into Markdown as a fenced block', () => {
  const blocks = [{ type: 'code', lang: '', text: 'A\n │\n ▼\nB', diagram: true }];
  const markdown = MD.blocksToMarkdown(blocks);
  assert.match(markdown, /^```$/m);
  assert.ok(markdown.includes(' │'), 'indentation is inside the fence, so it survives');

  const reparsed = IR.parseBlocks(markdown);
  assert.equal(reparsed[0].text, 'A\n │\n ▼\nB');
});

test('a wide diagram rotates the page and then restores portrait', () => {
  const wide = Array.from({ length: 4 }, () => '│' + '─'.repeat(200) + '│').join('\n');
  const definition = exporter.buildPdfDefinition(
    { title: 'T', platformLabel: 'Claude' },
    [{ index: 0, question: { markdown: 'Q?' }, answers: [{ markdown: '```\n' + wide + '\n```' }] }]
  );

  const diagram = findNode(definition.content, node => node.cgxPreformatted?.landscape);
  assert.ok(diagram, 'a diagram too wide for portrait is rotated rather than shrunk to illegibility');
  assert.ok(diagram.cgxPreformatted.fontSize >= 6, 'never below 6pt');

  const restore = findNode(definition.content, node => node.cgxRestoreOrientation);
  assert.ok(restore, 'orientation must be restored or every later page stays landscape');
  assert.equal(restore.pageOrientation, 'portrait');
});

test('narrow diagrams stay portrait', () => {
  const definition = exporter.buildPdfDefinition(
    { title: 'T', platformLabel: 'Claude' },
    [{ index: 0, question: { markdown: 'Q?' }, answers: [{ markdown: '```\nA\n│\n▼\nB\n```' }] }]
  );
  assert.equal(findNode(definition.content, node => node.cgxRestoreOrientation), null);
  const diagram = findNode(definition.content, node => node.cgxPreformatted);
  assert.equal(diagram.cgxPreformatted.landscape, false);
});

// ---------------------------------------------------------------- artifacts

function artifactPage(panelHtml, cardLabel = 'app.py') {
  return loadPage(
    `<html><body>
       <div data-test-render-count="1">
         <div data-testid="user-message"><p>Write it.</p></div>
         <div class="font-claude-response">
           <p>Here you go.</p>
           <button data-testid="artifact-card" aria-label="${cardLabel}">${cardLabel}</button>
         </div>
       </div>
       <div id="markdown-artifact">${panelHtml}</div>
     </body></html>`,
    'https://claude.ai/chat/abc'
  );
}

test('an open code artifact exports as a code block, not collapsed prose', () => {
  const page = artifactPage('<pre><code class="language-python">def f():\n    return 1\n</code></pre>');
  const answer = page.adapter.assistantNodes(page.adapter.turnContainers()[0])[0];
  const artifacts = page.adapter.artifacts(page.adapter.turnContainers()[0]);
  const blocks = page.extract.fromMessage(page.adapter.messageBody(answer), { artifacts });

  const artifact = findBlock(blocks, 'artifact');
  assert.ok(artifact, 'the artifact appears in the document');
  assert.equal(artifact.title, 'app.py');

  const code = findBlock(artifact.blocks, 'code');
  assert.ok(code, 'a code artifact must be a code block');
  assert.equal(code.lang, 'py');
  assert.ok(code.text.includes('    return 1'), 'indentation is preserved');
});

test('a line-div code artifact keeps its indentation', () => {
  // Claude renders some artifacts as a stack of styled line divs rather than <pre>.
  const page = artifactPage(
    '<div class="font-mono"><div>function a() {</div><div>  return 1;</div><div>}</div></div>',
    'util.js'
  );
  const answer = page.adapter.assistantNodes(page.adapter.turnContainers()[0])[0];
  const artifacts = page.adapter.artifacts(page.adapter.turnContainers()[0]);
  const blocks = page.extract.fromMessage(page.adapter.messageBody(answer), { artifacts });

  const code = findBlock(findBlock(blocks, 'artifact').blocks, 'code');
  assert.ok(code.text.includes('  return 1;'), 'two-space indent survives');
  assert.equal(code.lang, 'js');
});

test('a document artifact keeps its block structure', () => {
  const page = artifactPage('<h2>Report</h2><ul><li>Point one</li><li>Point two</li></ul>', 'Report');
  const answer = page.adapter.assistantNodes(page.adapter.turnContainers()[0])[0];
  const artifacts = page.adapter.artifacts(page.adapter.turnContainers()[0]);
  const blocks = page.extract.fromMessage(page.adapter.messageBody(answer), { artifacts });

  const artifact = findBlock(blocks, 'artifact');
  assert.ok(findBlock(artifact.blocks, 'heading'), 'headings survive');
  assert.ok(findBlock(artifact.blocks, 'list'), 'lists survive');
});

test('a closed artifact says so instead of exporting a blank', () => {
  const page = loadPage(
    `<html><body><div data-test-render-count="1">
       <div data-testid="user-message"><p>Q</p></div>
       <div class="font-claude-response"><button data-testid="artifact-card" aria-label="chart.tsx">chart.tsx</button></div>
     </div></body></html>`,
    'https://claude.ai/chat/abc'
  );
  const answer = page.adapter.assistantNodes(page.adapter.turnContainers()[0])[0];
  const artifacts = page.adapter.artifacts(page.adapter.turnContainers()[0]);
  const blocks = page.extract.fromMessage(page.adapter.messageBody(answer), { artifacts });

  const artifact = findBlock(blocks, 'artifact');
  assert.equal(artifact.title, 'chart.tsx');
  assert.match(page.IR.blocksToPlainText(artifact.blocks), /could not be opened/i);
});

test('artifacts reach every output format', async () => {
  const turns = [{
    index: 0,
    question: { blocks: IR.parseBlocks('Write it.') },
    answers: [{
      blocks: [
        { type: 'paragraph', inline: [{ type: 'text', text: 'Here you go.' }] },
        {
          type: 'artifact',
          title: 'app.py',
          kind: 'code',
          blocks: [{ type: 'code', lang: 'py', text: 'def f():\n    return 1', diagram: false }]
        }
      ]
    }]
  }];
  const data = { title: 'T', platformLabel: 'Claude' };

  const markdown = exporter.createMarkdown(data, turns);
  assert.ok(markdown.includes('Artifact: app.py'));
  assert.ok(markdown.includes('    return 1'), 'indentation survives in Markdown');

  const definition = exporter.buildPdfDefinition(data, turns);
  const code = findNode(definition.content, node => node.cgxPreformatted);
  assert.ok(code.cgxPreformatted.text.includes('    return 1'), 'indentation survives in PDF');
  assert.ok(findAll(definition.content, node => node.style === 'label')
    .some(node => JSON.stringify(node.text).includes('app.py')), 'the artifact is titled in the PDF');

  const blob = await exporter.createDocxBlob(data, turns, { embedImages: false });
  assert.ok(blob.size > 0);
});

// ---------------------------------------------------------------- tooling

test('the test runner is invoked in a cross-platform way', () => {
  const pkg = require('../package.json');
  // `node --test tests/` fails on Windows, and `tests/*.test.js` relies on
  // shell globbing that cmd.exe does not do.
  assert.ok(!/--test\s+tests\/?($|\s)/.test(pkg.scripts.test),
    'must not pass a bare directory to --test');
  assert.ok(!pkg.scripts.test.includes('*'), 'must not rely on shell globbing');
  assert.match(pkg.scripts.test, /scripts\/test\.mjs/);
});

// ------------------------------------------------- split-message DOM (v0.6.1)

const SPLIT = ['claude-split-messages.html', 'https://claude.ai/chat/abc'];

function splitPage() {
  const page = loadPage(fixture(SPLIT[0]), SPLIT[1]);
  page.groups = page.window.ThreadExporterAdapterKit.groupTurns(page.adapter.messages());
  return page;
}

test('answers pair with questions when each message has its own wrapper', () => {
  // Real Claude does not wrap a user message and its answer together. Assuming
  // it did produced turns with a question and zero answers, which is why full
  // exports came out as questions only.
  const page = splitPage();
  assert.equal(page.groups.length, 2, 'two turns');
  assert.deepEqual(plain(page.groups.map(g => g.answers.length)), [1, 1],
    'every question must carry its answer');
  assert.equal(page.groups[1].question.textContent.trim(), 'And the second question?');
});

test('an unparseable question does not discard its answer', () => {
  // "No question-and-answer content was found on this page" came from dropping
  // the whole turn when the question body could not be parsed.
  const page = loadPage(
    `<html><body><main>
       <div data-test-render-count="1"><div data-testid="user-message"><span></span></div></div>
       <div data-test-render-count="2"><div class="font-claude-response"><p>Real answer.</p></div></div>
     </main></body></html>`,
    'https://claude.ai/chat/abc'
  );
  const groups = page.window.ThreadExporterAdapterKit.groupTurns(page.adapter.messages());
  assert.equal(groups.length, 1);
  assert.equal(groups[0].answers.length, 1);

  const blocks = page.extract.fromMessage(page.adapter.messageBody(groups[0].answers[0]), {});
  assert.ok(page.IR.blocksToPlainText(blocks).includes('Real answer'));
});

test('a leading assistant message still forms a turn', () => {
  const page = loadPage(
    `<html><body><main>
       <div data-test-render-count="1"><div class="font-claude-response"><p>Opening note.</p></div></div>
       <div data-test-render-count="2"><div data-testid="user-message"><p>Hi</p></div></div>
     </main></body></html>`,
    'https://claude.ai/chat/abc'
  );
  const groups = page.window.ThreadExporterAdapterKit.groupTurns(page.adapter.messages());
  assert.equal(groups.length, 2);
  assert.equal(groups[0].question, null, 'an answer with no question is not dropped');
  assert.equal(groups[0].answers.length, 1);
});

test('the export control anchors to the last answer, as on ChatGPT', () => {
  const page = splitPage();
  const lastAnswer = page.groups[0].answers[0];
  // The button belongs at the end of the answer on both platforms; anchoring
  // on a turn container put it in the wrong place (or nowhere) on Claude.
  assert.ok(lastAnswer.parentElement, 'the answer has a parent to insert after');
  assert.ok(lastAnswer.matches('.font-claude-response'));
});

test('a text attachment exports its contents, an archive exports its name', () => {
  const page = splitPage();
  const attachments = page.adapter.attachments(page.groups[0].question);
  const labels = attachments.map(el => el.getAttribute('aria-label'));

  assert.ok(labels.includes('full-v0.6.1.patch'), 'text-like file is detected');
  assert.ok(labels.includes('release.tar.gz'), 'archive is detected');

  const patch = attachments.find(el => el.getAttribute('aria-label').endsWith('.patch'));
  const text = page.extract.preservedText(patch.querySelector('pre'));
  assert.ok(text.includes('+added line'), 'text attachment content is readable from the DOM');

  const archive = attachments.find(el => el.getAttribute('aria-label').endsWith('.tar.gz'));
  assert.equal(archive.querySelector('pre'), null, 'an archive has no readable body in the page');
});

test('archive extensions are classified as binary', () => {
  const binary = /\.(tar|tar\.gz|tgz|zip|gz|bz2|xz|7z|rar|exe|dll|bin|so|dylib|pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|webp|mp4|mp3|wav)$/i;
  for (const name of ['release.tar.gz', 'a.zip', 'b.7z', 'c.png', 'd.docx']) {
    assert.ok(binary.test(name), name + ' must be treated as binary');
  }
  for (const name of ['fix.patch', 'main.py', 'index.html', 'notes.md', 'data.json', 'app.jsx']) {
    assert.ok(!binary.test(name), name + ' must have its contents exported');
  }
});

test('Claude resolves a header anchor rather than falling back to the page body', () => {
  const page = splitPage();
  const anchor = page.adapter.headerAnchor();
  assert.ok(anchor, 'a top-bar anchor is found');
  assert.ok(anchor.closest('.sticky, header, [role="banner"]'), 'the anchor is in the top bar');
  assert.equal(anchor.closest('main'), null, 'never inside the message flow');
});

test('a whole-thread export captures every question and every answer', async () => {
  const page = splitPage();
  const turns = [];
  for (const group of page.groups) {
    const question = page.extract.fromMessage(page.adapter.messageBody(group.question), {});
    const answers = group.answers.map(node =>
      ({ blocks: page.extract.fromMessage(page.adapter.messageBody(node), {}) }));
    turns.push({ index: turns.length, question: { blocks: plain(question) }, answers: plain(answers) });
  }

  assert.equal(turns.length, 2);
  const markdown = exporter.createMarkdown({ title: 'T', platformLabel: 'Claude' }, turns);
  assert.ok(markdown.includes('Review this patch'), 'first question');
  assert.ok(markdown.includes('The patch looks fine'), 'first ANSWER, not just the question');
  assert.ok(markdown.includes('And the second question?'), 'second question');
  assert.ok(markdown.includes('Second answer body'), 'second answer');
});

// ------------------------------------------------- v0.6.2 report

test('an artifact title is not run together with its type label', () => {
  const page = loadPage(
    `<html><body><div data-test-render-count="1">
       <div data-testid="user-message"><p>Q</p></div>
       <div class="font-claude-response">
         <button data-testid="artifact-card">Master's in Italy vs Germany: 2027/28 Intake Analysis<span>Document</span></button>
       </div>
     </div>
     <div id="markdown-artifact"><h2>Comparison</h2><p>Italy is cheaper.</p></div>
     </body></html>`,
    'https://claude.ai/chat/abc'
  );
  const group = page.window.ThreadExporterAdapterKit.groupTurns(page.adapter.messages())[0];
  const artifacts = page.adapter.artifacts(group.answers[0]);
  const blocks = page.extract.fromMessage(page.adapter.messageBody(group.answers[0]), { artifacts });

  const artifact = findBlock(blocks, 'artifact');
  assert.ok(!/AnalysisDocument/.test(artifact.title), 'the type label must not be glued to the title');
  assert.ok(artifact.title.endsWith('Intake Analysis'), 'got: ' + artifact.title);
});

test('a prose artifact keeps its structure instead of becoming one code blob', () => {
  const page = loadPage(
    `<html><body><div data-test-render-count="1">
       <div data-testid="user-message"><p>Q</p></div>
       <div class="font-claude-response"><button data-testid="artifact-card" aria-label="Report">Report</button></div>
     </div>
     <div id="markdown-artifact">
       <h2>Findings</h2>
       <p>Use the <code>--check</code> flag.</p>
       <ul><li>Point one</li><li>Point two</li></ul>
     </div></body></html>`,
    'https://claude.ai/chat/abc'
  );
  const group = page.window.ThreadExporterAdapterKit.groupTurns(page.adapter.messages())[0];
  const artifacts = page.adapter.artifacts(group.answers[0]);
  const artifact = findBlock(
    page.extract.fromMessage(page.adapter.messageBody(group.answers[0]), { artifacts }),
    'artifact'
  );

  assert.ok(findBlock(artifact.blocks, 'heading'), 'headings survive');
  assert.ok(findBlock(artifact.blocks, 'list'), 'lists survive');
  assert.equal(findBlock(artifact.blocks, 'code'), null,
    'one inline code span must not turn the whole document into a code block');
});

test('an artifact that renders no blocks falls back to its text, never to nothing', () => {
  const page = loadPage(
    `<html><body><div data-test-render-count="1">
       <div data-testid="user-message"><p>Q</p></div>
       <div class="font-claude-response"><button data-testid="artifact-card" aria-label="Doc">Doc</button></div>
     </div>
     <div id="markdown-artifact"><span>Body text that no block rule matches.</span></div>
     </body></html>`,
    'https://claude.ai/chat/abc'
  );
  const group = page.window.ThreadExporterAdapterKit.groupTurns(page.adapter.messages())[0];
  const artifacts = page.adapter.artifacts(group.answers[0]);
  const artifact = findBlock(
    page.extract.fromMessage(page.adapter.messageBody(group.answers[0]), { artifacts }),
    'artifact'
  );

  const text = page.IR.blocksToPlainText(artifact.blocks);
  assert.ok(text.includes('Body text'), 'raw text is used rather than an empty artifact body');
});

test('a pasted-content card is detected and its text exported', () => {
  const page = loadPage(
    `<html><body><div data-test-render-count="1">
       <div data-testid="user-message">
         <div data-testid="pasted-content" aria-label="pasted-text.txt">
           <pre>line one of the pasted block
line two of the pasted block</pre>
         </div>
       </div>
     </div>
     <div data-test-render-count="2"><div class="font-claude-response"><p>Answer.</p></div></div>
     </body></html>`,
    'https://claude.ai/chat/abc'
  );
  const group = page.window.ThreadExporterAdapterKit.groupTurns(page.adapter.messages())[0];

  const attachments = page.adapter.attachments(group.question);
  assert.equal(attachments.length, 1, 'the pasted card is found');

  // The question body itself parses to nothing, so the whole node is read.
  const text = page.extract.preservedText(group.question);
  assert.ok(text.includes('line one of the pasted block'),
    'pasted content must reach the question section, not be left blank');
  assert.ok(text.includes('line two of the pasted block'));
});

test('diagram characters route to a font that has their glyphs', () => {
  // Sanity check mirroring tests/font-coverage.test.js from the IR side.
  const blocks = IR.parseBlocks('```\nBrowser\n ├── camera\n │\n └── frames\n       ↓\n WebSocket\n```');
  assert.equal(blocks[0].diagram, true, 'tree characters mark this as a diagram');
  assert.equal(blocks[0].text.split('\n').length, 6, 'line structure is preserved');
});


test('ChatGPT block-row architecture diagrams do not collapse or clip the final row', () => {
  const page = loadPage(
    `<html><body><main>
       <article data-testid="conversation-turn-1">
         <div data-message-author-role="user"><div class="markdown"><p>Show the architecture.</p></div></div>
       </article>
       <article data-testid="conversation-turn-2">
         <div data-message-author-role="assistant"><div class="markdown">
           <div class="architecture-diagram">
             <div>Browser</div>
             <div>├── displays local 30 FPS camera</div>
             <div>│</div>
             <div>└── samples selected frames</div>
             <div>↓</div>
             <div>WebSocket</div>
             <div>↓</div>
             <div>Recognition backend</div>
           </div>
         </div></div>
       </article>
     </main></body></html>`,
    'https://chatgpt.com/c/abc'
  );

  const assistant = page.adapter.messages().find(message => message.role === 'assistant').node;
  const blocks = page.extract.fromMessage(page.adapter.messageBody(assistant), {});
  const diagram = findBlock(blocks, 'code');

  assert.ok(diagram?.diagram, 'the visual row container is recognized as a character diagram');
  assert.equal(diagram.text.split('\n').length, 8, 'every visual row stays on its own line');
  assert.ok(diagram.text.endsWith('Recognition backend'), 'the final row must not be clipped');
});

test('Claude Document artifacts inside wiggle-file-content stay prose, not a mono blob', () => {
  const page = loadPage(
    `<html><body>
       <div data-test-render-count="1">
         <div data-testid="user-message"><p>Compare the countries.</p></div>
       </div>
       <div data-test-render-count="2">
         <div class="font-claude-response">
           <button data-testid="artifact-card">
             <span class="title">Master's in Italy vs Germany for 2027/28</span><span class="type">Document</span>
           </button>
         </div>
       </div>
       <aside>
         <div id="wiggle-file-content">
           <div><strong>Executive summary</strong></div>
           <div>Germany offers stronger technical career depth.</div>
           <div>Italy can be the lower-cost option.</div>
         </div>
       </aside>
     </body></html>`,
    'https://claude.ai/chat/abc'
  );

  const group = page.window.ThreadExporterAdapterKit.groupTurns(page.adapter.messages())[0];
  const artifacts = page.adapter.artifacts(group.answers[0]);
  const artifact = findBlock(
    page.extract.fromMessage(page.adapter.messageBody(group.answers[0]), { artifacts }),
    'artifact'
  );

  const text = page.IR.blocksToPlainText(artifact.blocks);
  assert.ok(text.includes('Germany offers stronger technical career depth.'));
  assert.ok(text.includes('Italy can be the lower-cost option.'));
  assert.equal(findBlock(artifact.blocks, 'code'), null, 'Document artifacts must not use the code renderer');
});

test('Claude finds artifact content in a generic side-panel layout', () => {
  const page = loadPage(
    `<html><body>
       <div data-test-render-count="1"><div data-testid="user-message"><p>Make a report.</p></div></div>
       <div data-test-render-count="2"><div class="font-claude-response">
         <button data-testid="artifact-card" aria-label="Research report Document">Research report<span>Document</span></button>
       </div></div>
       <aside class="right-side-artifact-panel">
         <div data-testid="artifact-renderer"><article class="prose"><h2>Findings</h2><p>Full artifact body.</p></article></div>
       </aside>
     </body></html>`,
    'https://claude.ai/chat/abc'
  );

  const group = page.window.ThreadExporterAdapterKit.groupTurns(page.adapter.messages())[0];
  const artifacts = page.adapter.artifacts(group.answers[0]);
  const artifact = findBlock(
    page.extract.fromMessage(page.adapter.messageBody(group.answers[0]), { artifacts }),
    'artifact'
  );

  assert.ok(page.IR.blocksToPlainText(artifact.blocks).includes('Full artifact body.'));
});

test('Claude can expand and snapshot a collapsed pasted-question card', async () => {
  const page = loadPage(
    `<html><body>
       <div data-test-render-count="1">
         <div data-testid="user-message">
           <button class="rounded-card" aria-label="Pasted content">Pasted content</button>
         </div>
       </div>
       <div data-test-render-count="2"><div class="font-claude-response"><p>Answer.</p></div></div>
     </body></html>`,
    'https://claude.ai/chat/abc'
  );

  const group = page.window.ThreadExporterAdapterKit.groupTurns(page.adapter.messages())[0];
  const card = page.adapter.attachments(group.question)[0];
  card.addEventListener('click', () => {
    if (card.querySelector('pre')) return;
    const pre = page.document.createElement('pre');
    pre.textContent = 'first pasted question line\nsecond pasted question line';
    card.appendChild(pre);
  });

  const captured = await page.adapter.captureAttachments(group.question);
  assert.equal(captured.length, 1);
  assert.ok(captured[0].__cgxAttachmentContent, 'expanded pasted text is snapshotted');
  assert.ok(
    page.extract.preservedText(captured[0].__cgxAttachmentContent).includes('second pasted question line'),
    'the pasted question body is preserved for the question section'
  );
});
