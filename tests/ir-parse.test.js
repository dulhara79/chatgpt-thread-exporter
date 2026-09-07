const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPure } = require('./helpers/harness.js');

const { IR, MD } = loadPure();

/** Walks to the first block of a given type, at any depth. */
function findBlock(blocks, type) {
  for (const block of blocks || []) {
    if (block.type === type) return block;
    const children = block.blocks || (block.items || []).flatMap(item => item.blocks) || [];
    const hit = findBlock(children, type);
    if (hit) return hit;
  }
  return null;
}

test('F-05: nested bullet lists keep their depth', () => {
  const blocks = IR.parseBlocks('- Parent\n  - Child A\n  - Child B\n    - Deep\n- Second');

  assert.equal(blocks.length, 1, 'one list, not one list per item');
  const list = blocks[0];
  assert.equal(list.type, 'list');
  assert.equal(list.items.length, 2, 'Parent and Second are the only top-level items');

  const sublist = findBlock(list.items[0].blocks, 'list');
  assert.ok(sublist, 'Parent owns a nested list');
  assert.equal(sublist.items.length, 2);

  const deep = findBlock(sublist.items[1].blocks, 'list');
  assert.ok(deep, 'three levels of nesting survive');
  assert.equal(IR.blocksToPlainText(deep.items[0].blocks).trim(), 'Deep');
});

test('F-07: a code block inside a numbered step stays inside that step', () => {
  const blocks = IR.parseBlocks('1. Step one\n   ```js\n   const a = 1;\n   ```\n2. Step two');

  assert.equal(blocks.length, 1, 'the code block must not be lifted to the top level');
  const list = blocks[0];
  assert.equal(list.items.length, 2);

  const code = findBlock(list.items[0].blocks, 'code');
  assert.ok(code, 'step one owns the code block');
  assert.equal(code.lang, 'js');
  assert.equal(code.text, 'const a = 1;');
});

test('ordered lists preserve their start value', () => {
  const [list] = IR.parseBlocks('5. five\n6. six');
  assert.equal(list.ordered, true);
  assert.equal(list.start, 5);
  assert.equal(list.items.length, 2);
});

test('task lists round-trip their checked state', () => {
  const [list] = IR.parseBlocks('- [x] done\n- [ ] todo');
  assert.equal(list.items[0].checked, true);
  assert.equal(list.items[1].checked, false);
});

test('F-13: table column alignment is preserved', () => {
  const [table] = IR.parseBlocks('| L | C | R |\n|:--|:-:|--:|\n| a | b | c |');
  assert.equal(table.type, 'table');
  assert.deepEqual(table.align, ['left', 'center', 'right']);
  assert.equal(table.rows.length, 1);
});

test('F-13: a setext underline makes a heading, not a horizontal rule', () => {
  const blocks = IR.parseBlocks('My Heading\n---\n\nBody text.');
  assert.equal(blocks[0].type, 'heading');
  assert.equal(blocks[0].level, 2);
  assert.equal(IR.inlineToPlainText(blocks[0].inline), 'My Heading');
});

test('F-14: emphasis nests instead of swallowing its delimiters', () => {
  const [node] = IR.parseInline('**bold with *italic* inside**');
  assert.equal(node.type, 'strong');
  assert.equal(node.children[1].type, 'em');
  assert.equal(IR.inlineToPlainText([node]), 'bold with italic inside');
});

test('F-14: double-backtick code spans can contain a backtick', () => {
  const nodes = IR.parseInline('use ``a`b`` here');
  const code = nodes.find(node => node.type === 'code');
  assert.equal(code.text, 'a`b');
});

test('F-14: underscores inside identifiers are not emphasis', () => {
  const nodes = IR.parseInline('call snake_case_name now');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].type, 'text');
  assert.equal(nodes[0].text, 'call snake_case_name now');
});

test('F-14: non-https links and autolinks are preserved', () => {
  const relative = IR.parseInline('[docs](/help/page)').find(n => n.type === 'link');
  assert.equal(relative.href, '/help/page');
  const auto = IR.parseInline('<mailto:a@b.com>').find(n => n.type === 'link');
  assert.equal(auto.href, 'mailto:a@b.com');
});

test('escaped markdown characters are rendered literally', () => {
  const nodes = IR.parseInline('a \\*not italic\\* b');
  assert.equal(IR.inlineToPlainText(nodes), 'a *not italic* b');
});

test('inline math is detected but bare currency is not', () => {
  const math = IR.parseInline('$E = mc^2$').find(n => n.type === 'math');
  assert.equal(math.tex, 'E = mc^2');
  const money = IR.parseInline('costs $5 and $6 total');
  assert.equal(money.every(node => node.type === 'text'), true);
});

test('tilde and long code fences both close correctly', () => {
  const [tilde] = IR.parseBlocks('~~~python\nx = 1\n~~~');
  assert.equal(tilde.type, 'code');
  assert.equal(tilde.lang, 'python');
  const [long] = IR.parseBlocks('````\ninner ``` fence\n````');
  assert.equal(long.text, 'inner ``` fence');
});

test('character diagrams are flagged for the exact-columns path', () => {
  const [block] = IR.parseBlocks('```\nA\n│\n▼\nB\n```');
  assert.equal(block.diagram, true);
  const [code] = IR.parseBlocks('```js\nconst a = 1;\n```');
  assert.equal(code.diagram, false);
});

test('Markdown round-trips nesting through the IR', () => {
  const source = '- Parent\n  - Child\n\n1. Step\n   ```js\n   x\n   ```\n';
  const rendered = MD.blocksToMarkdown(IR.parseBlocks(source));
  const reparsed = IR.parseBlocks(rendered);

  const list = reparsed[0];
  assert.ok(findBlock(list.items[0].blocks, 'list'), 'nesting survives a round-trip');
  assert.ok(findBlock(reparsed[1].items[0].blocks, 'code'), 'list-item code survives a round-trip');
});

test('multilingual and emoji content passes through unchanged', () => {
  const text = 'සිංහල English தமிழ் 한국어 😀 ∑ α → ✓';
  assert.equal(IR.blocksToPlainText(IR.parseBlocks(text)), text);
});
