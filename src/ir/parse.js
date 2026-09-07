/**
 * Markdown -> IR.
 *
 * This replaces the old flat `parseMarkdownBlocks` / `parseInlineTokens` pair.
 * It exists for two reasons:
 *   1. as the fallback path when a turn arrives with only a `markdown` string
 *      (legacy payloads, the popup, tests);
 *   2. because Claude and ChatGPT both emit Markdown inside code fences and
 *      artifact bodies that we still need to structure.
 *
 * The DOM extractor (`src/ir/extract.js`) produces the same IR directly and is
 * the preferred path — see the audit note about the lossy Markdown hop.
 *
 * Block nodes:
 *   {type:'heading',   level, inline}
 *   {type:'paragraph', inline}
 *   {type:'list',      ordered, start, tight, items:[{blocks, checked}]}
 *   {type:'code',      lang, text, diagram}
 *   {type:'quote',     blocks}
 *   {type:'table',     align:(left|center|right|null)[], head:Cell[], rows:Cell[][]}
 *   {type:'rule'}
 *   {type:'image',     src, alt, width, height}
 *   {type:'math',      tex, display:true}
 *   {type:'artifact',  title, kind, blocks}
 *   {type:'thinking',  blocks}
 * Cell = {blocks}
 *
 * Inline nodes:
 *   {type:'text', text} {type:'code', text} {type:'break'}
 *   {type:'strong'|'em'|'del', children}
 *   {type:'link', href, children}
 *   {type:'math', tex, display:false}
 *   {type:'image', src, alt}
 */
(() => {
  'use strict';

  const DIAGRAM_LANGS = /^(?:text|txt|ascii|diagram|flowchart|mermaid|graphviz|dot|plantuml)$/i;
  const DIAGRAM_CHARS = /[┌┐└┘├┤┬┴┼│─━┃┏┓┗┛┣┫┳┻╋╭╮╰╯▼▲►◄→←⇒⇐]/u;

  function isDiagram(lang, text) {
    if (DIAGRAM_LANGS.test(String(lang || '').trim())) return true;
    return DIAGRAM_CHARS.test(String(text || ''));
  }

  // ------------------------------------------------------------------
  // Inline
  // ------------------------------------------------------------------

  const PUNCT = /[\s!-/:-@[-`{-~]/;

  function isAlnum(ch) {
    return Boolean(ch) && !PUNCT.test(ch);
  }

  /**
   * Recursive-descent inline scanner. Unlike the old single alternation regex,
   * delimiters nest: `**bold with *italic* inside**` produces
   * strong[text, em[text], text].
   */
  function parseInline(source) {
    const src = String(source || '');
    const out = [];
    let buffer = '';

    const flush = () => {
      if (buffer) {
        out.push({ type: 'text', text: buffer });
        buffer = '';
      }
    };

    let i = 0;
    while (i < src.length) {
      const ch = src[i];

      // Backslash escapes.
      if (ch === '\\' && i + 1 < src.length) {
        const next = src[i + 1];
        if (next === '\n') {
          flush();
          out.push({ type: 'break' });
          i += 2;
          continue;
        }
        if (PUNCT.test(next)) {
          buffer += next;
          i += 2;
          continue;
        }
      }

      // Hard break: two or more trailing spaces before a newline.
      if (ch === '\n') {
        if (/ {2,}$/.test(buffer)) {
          buffer = buffer.replace(/ +$/, '');
          flush();
          out.push({ type: 'break' });
        } else {
          buffer += '\n';
        }
        i += 1;
        continue;
      }

      // Code span: a run of N backticks closes on the next run of exactly N.
      if (ch === '`') {
        const run = /^`+/.exec(src.slice(i))[0];
        const close = src.indexOf(run, i + run.length);
        if (close > -1) {
          const inner = src.slice(i + run.length, close);
          flush();
          out.push({ type: 'code', text: inner.replace(/^ (.*) $/, '$1') });
          i = close + run.length;
          continue;
        }
      }

      // Display math.
      if (src.startsWith('$$', i)) {
        const close = src.indexOf('$$', i + 2);
        if (close > -1) {
          flush();
          out.push({ type: 'math', tex: src.slice(i + 2, close).trim(), display: true });
          i = close + 2;
          continue;
        }
      }
      if (src.startsWith('\\[', i)) {
        const close = src.indexOf('\\]', i + 2);
        if (close > -1) {
          flush();
          out.push({ type: 'math', tex: src.slice(i + 2, close).trim(), display: true });
          i = close + 2;
          continue;
        }
      }
      if (src.startsWith('\\(', i)) {
        const close = src.indexOf('\\)', i + 2);
        if (close > -1) {
          flush();
          out.push({ type: 'math', tex: src.slice(i + 2, close).trim(), display: false });
          i = close + 2;
          continue;
        }
      }
      // Inline math: `$x$` with no space just inside the delimiters, which
      // keeps prices ("$5 and $6") from being swallowed.
      if (ch === '$' && src[i + 1] && src[i + 1] !== ' ' && src[i + 1] !== '$') {
        const close = src.indexOf('$', i + 1);
        if (close > -1 && src[close - 1] !== ' ' && !src.slice(i + 1, close).includes('\n')) {
          flush();
          out.push({ type: 'math', tex: src.slice(i + 1, close).trim(), display: false });
          i = close + 1;
          continue;
        }
      }

      // Image.
      if (ch === '!' && src[i + 1] === '[') {
        const parsed = parseLinkish(src, i + 1);
        if (parsed) {
          flush();
          out.push({ type: 'image', alt: parsed.label, src: parsed.href });
          i = parsed.end;
          continue;
        }
      }

      // Link (children parsed recursively).
      if (ch === '[') {
        const parsed = parseLinkish(src, i);
        if (parsed) {
          flush();
          out.push({ type: 'link', href: parsed.href, children: parseInline(parsed.label) });
          i = parsed.end;
          continue;
        }
      }

      // Autolink.
      if (ch === '<') {
        const match = /^<((?:https?:\/\/|mailto:)[^\s>]+)>/.exec(src.slice(i));
        if (match) {
          flush();
          out.push({ type: 'link', href: match[1], children: [{ type: 'text', text: match[1] }] });
          i += match[0].length;
          continue;
        }
      }

      // Strikethrough.
      if (src.startsWith('~~', i)) {
        const close = src.indexOf('~~', i + 2);
        if (close > -1) {
          flush();
          out.push({ type: 'del', children: parseInline(src.slice(i + 2, close)) });
          i = close + 2;
          continue;
        }
      }

      // Strong then emphasis. Longest delimiter wins so `***x***` nests.
      if (ch === '*' || ch === '_') {
        const emphasis = parseEmphasis(src, i, ch);
        if (emphasis) {
          flush();
          out.push(emphasis.node);
          i = emphasis.end;
          continue;
        }
      }

      buffer += ch;
      i += 1;
    }

    flush();
    return out;
  }

  /** Parses `[label](href)` starting at the `[`. Handles nested brackets. */
  function parseLinkish(src, start) {
    if (src[start] !== '[') return null;
    let depth = 0;
    let i = start;
    for (; i < src.length; i++) {
      if (src[i] === '\\') { i += 1; continue; }
      if (src[i] === '[') depth += 1;
      else if (src[i] === ']') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0 || src[i] !== ']') return null;
    const label = src.slice(start + 1, i);
    if (src[i + 1] !== '(') return null;

    let paren = 0;
    let j = i + 1;
    for (; j < src.length; j++) {
      if (src[j] === '\\') { j += 1; continue; }
      if (src[j] === '(') paren += 1;
      else if (src[j] === ')') {
        paren -= 1;
        if (paren === 0) break;
      }
    }
    if (paren !== 0 || src[j] !== ')') return null;

    const target = src.slice(i + 2, j).trim();
    // Strip an optional title: [x](url "title")
    const href = target.replace(/\s+"[^"]*"$/, '').replace(/\s+'[^']*'$/, '').trim();
    return { label, href, end: j + 1 };
  }

  function parseEmphasis(src, start, marker) {
    const run = marker === '*' ? /^\*+/.exec(src.slice(start))[0] : /^_+/.exec(src.slice(start))[0];
    const width = Math.min(run.length, 2);
    const delim = marker.repeat(width);

    // `_` must not fire inside snake_case_identifiers.
    if (marker === '_' && isAlnum(src[start - 1])) return null;

    let search = start + width;
    while (search < src.length) {
      const close = src.indexOf(delim, search);
      if (close < 0) return null;
      const after = src[close + delim.length];
      const before = src[close - 1];
      if (before === '\\') { search = close + delim.length; continue; }
      if (before === ' ' || before === undefined) { search = close + delim.length; continue; }
      if (marker === '_' && isAlnum(after)) { search = close + delim.length; continue; }
      const inner = src.slice(start + width, close);
      if (!inner.trim()) return null;
      return {
        node: { type: width === 2 ? 'strong' : 'em', children: parseInline(inner) },
        end: close + delim.length
      };
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Blocks
  // ------------------------------------------------------------------

  const FENCE_RE = /^(\s*)(`{3,}|~{3,})\s*([^`~]*)$/;
  const ATX_RE = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const HR_RE = /^ {0,3}(?:-{3,}|_{3,}|\*{3,})\s*$/;
  const BULLET_RE = /^(\s*)([-*+])(\s+)(.*)$/;
  const ORDERED_RE = /^(\s*)(\d{1,9})([.)])(\s+)(.*)$/;
  const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
  const SETEXT_RE = /^ {0,3}(=+|-+)\s*$/;

  function indentOf(line) {
    const match = /^\s*/.exec(line)[0];
    let width = 0;
    for (const ch of match) width += ch === '\t' ? 4 : 1;
    return width;
  }

  function dedent(lines, amount) {
    return lines.map(line => {
      let removed = 0;
      let i = 0;
      while (i < line.length && removed < amount) {
        if (line[i] === ' ') removed += 1;
        else if (line[i] === '\t') removed += 4;
        else break;
        i += 1;
      }
      return line.slice(i);
    });
  }

  function isTableSeparator(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed.includes('-')) return false;
    return /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/.test(trimmed);
  }

  function splitRow(line) {
    const trimmed = String(line || '').trim().replace(/^\|/, '').replace(/\|$/, '');
    const cells = [];
    let current = '';
    for (let i = 0; i < trimmed.length; i++) {
      if (trimmed[i] === '\\' && trimmed[i + 1] === '|') { current += '|'; i += 1; continue; }
      if (trimmed[i] === '|') { cells.push(current.trim()); current = ''; continue; }
      current += trimmed[i];
    }
    cells.push(current.trim());
    return cells;
  }

  function alignmentsFrom(line) {
    return splitRow(line).map(cell => {
      const left = cell.startsWith(':');
      const right = cell.endsWith(':');
      if (left && right) return 'center';
      if (right) return 'right';
      if (left) return 'left';
      return null;
    });
  }

  function parseBlocks(markdown) {
    const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
    return parseLines(lines);
  }

  function parseLines(lines) {
    const blocks = [];
    let paragraph = [];
    let i = 0;

    const flushParagraph = () => {
      if (!paragraph.length) return;
      const text = paragraph.join('\n').trim();
      paragraph = [];
      if (text) blocks.push({ type: 'paragraph', inline: parseInline(text) });
    };

    while (i < lines.length) {
      const line = lines[i];

      // Fenced code.
      const fence = FENCE_RE.exec(line);
      if (fence) {
        flushParagraph();
        const marker = fence[2][0];
        const width = fence[2].length;
        const lang = fence[3].trim();
        const baseIndent = fence[1].length;
        const body = [];
        i += 1;
        const closeRe = new RegExp('^\\s*' + (marker === '`' ? '`' : '~') + '{' + width + ',}\\s*$');
        while (i < lines.length && !closeRe.test(lines[i])) {
          body.push(lines[i].slice(0, baseIndent).trim() ? lines[i] : lines[i].slice(baseIndent));
          i += 1;
        }
        if (i < lines.length) i += 1;
        const text = body.join('\n').replace(/\s+$/, '');
        blocks.push({ type: 'code', lang, text, diagram: isDiagram(lang, text) });
        continue;
      }

      // Table.
      if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        flushParagraph();
        const align = alignmentsFrom(lines[i + 1]);
        const head = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          rows.push(splitRow(lines[i]));
          i += 1;
        }
        const width = Math.max(head.length, ...rows.map(r => r.length), 1);
        const pad = row => {
          const filled = [...row, ...Array(Math.max(0, width - row.length)).fill('')];
          return filled.map(cell => ({ blocks: [{ type: 'paragraph', inline: parseInline(cell) }] }));
        };
        blocks.push({
          type: 'table',
          align: [...align, ...Array(Math.max(0, width - align.length)).fill(null)],
          head: pad(head),
          rows: rows.map(pad)
        });
        continue;
      }

      // ATX heading.
      const atx = ATX_RE.exec(line);
      if (atx) {
        flushParagraph();
        blocks.push({ type: 'heading', level: atx[1].length, inline: parseInline(atx[2]) });
        i += 1;
        continue;
      }

      // Setext heading — must be checked before the horizontal rule, or a
      // `---` underline silently demotes a heading to a rule.
      const setext = SETEXT_RE.exec(line);
      if (setext && paragraph.length) {
        const text = paragraph.join(' ').trim();
        paragraph = [];
        blocks.push({ type: 'heading', level: setext[1][0] === '=' ? 1 : 2, inline: parseInline(text) });
        i += 1;
        continue;
      }

      // Horizontal rule.
      if (HR_RE.test(line)) {
        flushParagraph();
        blocks.push({ type: 'rule' });
        i += 1;
        continue;
      }

      // Blockquote.
      if (QUOTE_RE.test(line)) {
        flushParagraph();
        const body = [];
        while (i < lines.length && (QUOTE_RE.test(lines[i]) || (lines[i].trim() && body.length && !isBlockStart(lines[i])))) {
          const match = QUOTE_RE.exec(lines[i]);
          body.push(match ? match[1] : lines[i]);
          i += 1;
        }
        blocks.push({ type: 'quote', blocks: parseLines(body) });
        continue;
      }

      // Lists — the recursion here is what makes nesting work.
      if (BULLET_RE.test(line) || ORDERED_RE.test(line)) {
        flushParagraph();
        const list = consumeList(lines, i);
        blocks.push(list.block);
        i = list.next;
        continue;
      }

      if (!line.trim()) {
        flushParagraph();
        i += 1;
        continue;
      }

      paragraph.push(line);
      i += 1;
    }

    flushParagraph();
    return blocks;
  }

  function isBlockStart(line) {
    return Boolean(
      FENCE_RE.exec(line) || ATX_RE.test(line) || HR_RE.test(line) ||
      BULLET_RE.test(line) || ORDERED_RE.test(line)
    );
  }

  function listSignature(line) {
    const ordered = ORDERED_RE.exec(line);
    if (ordered) {
      return {
        ordered: true,
        indent: indentOf(line),
        start: Number(ordered[2]),
        markerWidth: ordered[2].length + ordered[3].length + ordered[4].length,
        content: ordered[5]
      };
    }
    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      return {
        ordered: false,
        indent: indentOf(line),
        start: 1,
        markerWidth: bullet[2].length + bullet[3].length,
        content: bullet[4]
      };
    }
    return null;
  }

  /**
   * Consumes one whole list. Each item's continuation lines (deeper-indented
   * blocks, fenced code, nested lists, extra paragraphs) are gathered, dedented,
   * and re-parsed recursively — this is what keeps a code block inside a
   * numbered step attached to that step.
   */
  function consumeList(lines, start) {
    const first = listSignature(lines[start]);
    const baseIndent = first.indent;
    // A marker at or beyond the first item's content column is *nested* content
    // of the preceding item, not a sibling. Getting this boundary wrong is what
    // flattens nested lists.
    const siblingLimit = first.indent + first.markerWidth;
    const items = [];
    let tight = true;
    let i = start;

    while (i < lines.length) {
      const signature = listSignature(lines[i]);
      if (!signature || signature.indent >= siblingLimit || signature.indent < baseIndent) break;
      if (signature.ordered !== first.ordered) break;

      const contentIndent = signature.indent + signature.markerWidth;
      const itemLines = [signature.content];
      i += 1;

      let trailingBlank = 0;
      while (i < lines.length) {
        const current = lines[i];
        if (!current.trim()) {
          trailingBlank += 1;
          itemLines.push('');
          i += 1;
          continue;
        }
        const nextSignature = listSignature(current);
        const currentIndent = indentOf(current);

        // Only a marker shallower than this item's content column is a sibling;
        // anything at or past that column is a nested list belonging to us.
        if (nextSignature && currentIndent < contentIndent) break;
        // A non-indented, non-list line after a blank ends the whole list.
        if (currentIndent < contentIndent - 1) {
          if (trailingBlank > 0) break;
          // Lazy continuation of the item's paragraph.
          itemLines.push(current.trim());
          i += 1;
          trailingBlank = 0;
          continue;
        }
        if (trailingBlank > 0) tight = false;
        itemLines.push(current);
        i += 1;
        trailingBlank = 0;
      }

      while (itemLines.length && !itemLines[itemLines.length - 1].trim()) itemLines.pop();

      const dedented = dedent(itemLines, contentIndent);
      // The first line was already stripped of its marker, so restore its text.
      dedented[0] = signature.content;

      let checked;
      const task = /^\[([ xX])\]\s+(.*)$/.exec(dedented[0]);
      if (task) {
        checked = task[1].toLowerCase() === 'x';
        dedented[0] = task[2];
      }

      const itemBlocks = parseLines(dedented);
      items.push(checked === undefined ? { blocks: itemBlocks } : { blocks: itemBlocks, checked });
    }

    return {
      block: {
        type: 'list',
        ordered: first.ordered,
        start: first.ordered ? first.start : 1,
        tight,
        items
      },
      next: i
    };
  }

  // ------------------------------------------------------------------
  // Utilities shared by the renderers
  // ------------------------------------------------------------------

  function inlineToPlainText(inline) {
    return (inline || []).map(node => {
      switch (node.type) {
        case 'text': return node.text || '';
        case 'code': return node.text || '';
        case 'math': return node.tex || '';
        case 'break': return '\n';
        case 'image': return node.alt || '';
        case 'strong': case 'em': case 'del': case 'link':
          return inlineToPlainText(node.children);
        default: return '';
      }
    }).join('');
  }

  function blocksToPlainText(blocks) {
    return (blocks || []).map(block => {
      switch (block.type) {
        case 'heading': case 'paragraph': return inlineToPlainText(block.inline);
        case 'code': return block.text || '';
        case 'quote': return blocksToPlainText(block.blocks);
        case 'artifact': case 'thinking': return blocksToPlainText(block.blocks);
        case 'list':
          return (block.items || []).map(item => blocksToPlainText(item.blocks)).join('\n');
        case 'table':
          return [block.head, ...(block.rows || [])]
            .filter(Boolean)
            .map(row => (row || []).map(cell => blocksToPlainText(cell.blocks)).join(' ')).join('\n');
        case 'image': return block.alt || '';
        case 'math': return block.tex || '';
        default: return '';
      }
    }).filter(Boolean).join('\n\n');
  }

  /** True when a block tree carries no renderable content. */
  function isEmpty(blocks) {
    return !blocksToPlainText(blocks).trim() && !hasImage(blocks);
  }

  function hasImage(blocks) {
    return (blocks || []).some(block => {
      if (block.type === 'image') return true;
      if (block.blocks) return hasImage(block.blocks);
      if (block.items) return block.items.some(item => hasImage(item.blocks));
      if (block.inline) return block.inline.some(node => node.type === 'image');
      return false;
    });
  }

  globalThis.ThreadExporterIR = Object.freeze({
    parseBlocks,
    parseInline,
    inlineToPlainText,
    blocksToPlainText,
    isEmpty,
    hasImage,
    isDiagram
  });
})();
