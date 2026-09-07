/**
 * DOM -> IR.
 *
 * This replaces `markdownFromElement`. The old path serialised the DOM to a
 * Markdown *string* and re-parsed it, which destroyed every nesting relationship
 * on the way through. Walking straight to the block tree keeps `li > ul`,
 * `li > pre` and `li > p` intact.
 */
(() => {
  'use strict';

  const IR = globalThis.ThreadExporterIR;
  const MAX_INLINE_SVG_CHARS = 1000000;

  const SKIP_SELECTOR = [
    'script', 'style', 'noscript', 'template',
    '[data-cgx-ui]',
    '[data-testid*="copy" i]',
    '[data-testid*="feedback" i]',
    '[aria-hidden="true"][class*="sr-only"]',
    '.sr-only'
  ].join(', ');

  const BLOCK_TAGS = new Set([
    'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'pre', 'blockquote',
    'table', 'hr', 'figure', 'figcaption', 'details', 'dl', 'dt', 'dd'
  ]);

  function normalizeWhitespace(text) {
    return String(text || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ');
  }

  const DIAGRAM_CHARS = /[┌┐└┘├┤┬┴┼│─━┃┏┓┗┛┣┫┳┻╋╭╮╰╯▼▲►◄→←⇒⇐]/u;

  /**
   * Text with runs of spaces and line breaks intact.
   *
   * `normalizeWhitespace` collapses runs of spaces, which is right for prose
   * and fatal for character diagrams — it is what turned box-drawing art into
   * a single unaligned line. Used wherever layout is carried by whitespace.
   */
  function preservedText(el) {
    const out = [];
    const walk = node => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) {
          out.push(String(child.nodeValue || '').replace(/\u00a0/g, ' '));
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        if (child.matches?.(SKIP_SELECTOR)) continue;
        const tag = child.tagName.toLowerCase();
        if (tag === 'br') { out.push('\n'); continue; }
        walk(child);
        if (['p', 'div', 'li', 'tr'].includes(tag)) out.push('\n');
      }
    };
    walk(el);
    return out.join('').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
  }

  function computedWhiteSpace(el) {
    try {
      return String(el.ownerDocument?.defaultView?.getComputedStyle(el)?.whiteSpace || '');
    } catch {
      return '';
    }
  }

  /**
   * True when an element carries a character diagram outside a <pre>.
   *
   * Both platforms sometimes emit box-drawing art as a styled div or a
   * paragraph full of <br>, where collapsing whitespace destroys the alignment.
   */
  function looksLikeCharacterDiagram(el) {
    if (!(el instanceof Element)) return false;
    if (el.tagName.toLowerCase() === 'pre') return false;
    if (el.querySelector('pre, table, ul, ol, img')) return false;

    const text = el.textContent || '';
    if (!DIAGRAM_CHARS.test(text)) return false;

    const preserved = computedWhiteSpace(el).startsWith('pre');
    const multiline = el.querySelectorAll('br').length >= 2 || /\n\s*\S[\s\S]*\n/.test(text);
    if (!preserved && !multiline) return false;

    return preservedText(el).split('\n').filter(line => line.trim()).length >= 2;
  }

  function shouldIncludeImage(meta) {
    const helper = globalThis.ThreadExporter?.shouldIncludeImage;
    if (typeof helper === 'function') return helper(meta);
    return Boolean(meta.src);
  }

  function isMathElement(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'math' || tag === 'mjx-container') return true;
    const cls = String(el.getAttribute?.('class') || '').toLowerCase();
    return cls.includes('katex') || cls.includes('mathjax');
  }

  function texOf(el) {
    const annotation = el.querySelector?.(
      'annotation[encoding="application/x-tex"], annotation[encoding="application/tex"]'
    );
    return normalizeWhitespace(
      annotation?.textContent ||
      el.getAttribute?.('data-tex') ||
      el.getAttribute?.('data-latex') ||
      el.getAttribute?.('aria-label') ||
      el.textContent || ''
    ).trim();
  }

  function isDisplayMath(el) {
    const cls = String(el.getAttribute?.('class') || '').toLowerCase();
    return cls.includes('katex-display') ||
      el.getAttribute?.('display') === 'block' ||
      el.getAttribute?.('mode') === 'display';
  }

  function svgToImage(el) {
    const viewBox = String(el.getAttribute('viewBox') || '').trim().split(/[ ,]+/).map(Number);
    const width = Number(el.getAttribute('width')) || (viewBox.length === 4 ? Math.abs(viewBox[2]) : 0);
    const height = Number(el.getAttribute('height')) || (viewBox.length === 4 ? Math.abs(viewBox[3]) : 0);
    const textCount = el.querySelectorAll('text, foreignObject').length;
    const shapeCount = el.querySelectorAll('path, rect, circle, ellipse, polygon, polyline, line').length;
    const meaningful = (width >= 160 && height >= 80) || textCount >= 2 || shapeCount >= 8;
    if (!meaningful) return null;
    try {
      const serialized = new XMLSerializer().serializeToString(el);
      if (serialized.length > MAX_INLINE_SVG_CHARS) return null;
      const encoded = btoa(unescape(encodeURIComponent(serialized)));
      return {
        type: 'image',
        src: 'data:image/svg+xml;base64,' + encoded,
        alt: 'Diagram',
        width: width || 0,
        height: height || 0
      };
    } catch {
      return null;
    }
  }

  function imageFrom(el) {
    const meta = {
      src: el.currentSrc || el.getAttribute('src') || '',
      alt: el.getAttribute('alt') || el.getAttribute('aria-label') || 'Image',
      width: el.naturalWidth || Number(el.getAttribute('width')) || el.getBoundingClientRect?.().width || 0,
      height: el.naturalHeight || Number(el.getAttribute('height')) || el.getBoundingClientRect?.().height || 0,
      className: String(el.getAttribute('class') || ''),
      role: el.getAttribute('role') || ''
    };
    if (!shouldIncludeImage(meta)) return null;
    return { type: 'image', src: meta.src, alt: meta.alt, width: meta.width, height: meta.height };
  }

  // ------------------------------------------------------------------
  // Inline extraction
  // ------------------------------------------------------------------

  /**
   * Inline nodes for ONE element, keeping that element's own wrapper.
   *
   * Kept separate from `extractInline` (which walks children) so that block
   * level fallthrough can hand a single `<strong>` or `<a>` here without
   * silently descending past it and losing the mark.
   */
  function inlineNodesFor(el) {
    if (el.matches?.(SKIP_SELECTOR)) return [];
    const tag = el.tagName.toLowerCase();

    if (tag === 'br') return [{ type: 'break' }];

    if (isMathElement(el)) {
      const tex = texOf(el);
      return tex ? [{ type: 'math', tex, display: false }] : [];
    }
    if (tag === 'strong' || tag === 'b') return [{ type: 'strong', children: extractInline(el) }];
    if (tag === 'em' || tag === 'i') return [{ type: 'em', children: extractInline(el) }];
    if (tag === 'del' || tag === 's' || tag === 'strike') return [{ type: 'del', children: extractInline(el) }];
    if (tag === 'code') return [{ type: 'code', text: normalizeWhitespace(el.textContent) }];
    if (tag === 'a') {
      const href = el.getAttribute('href') || '';
      const children = extractInline(el);
      if (href && !/^javascript:/i.test(href)) return [{ type: 'link', href, children }];
      return children;
    }
    if (tag === 'img') {
      const image = imageFrom(el);
      return image ? [{ type: 'image', src: image.src, alt: image.alt }] : [];
    }
    if (tag === 'svg') {
      const image = svgToImage(el);
      return image ? [{ type: 'image', src: image.src, alt: image.alt }] : [];
    }
    // Unknown wrapper: descend.
    return extractInline(el);
  }

  function extractInline(node, out = []) {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = normalizeWhitespace(child.nodeValue);
        if (text) out.push({ type: 'text', text });
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      out.push(...inlineNodesFor(child));
    }
    return out;
  }

  function trimInline(inline) {
    const nodes = inline.slice();
    while (nodes.length && nodes[0].type === 'text' && !nodes[0].text.trim()) nodes.shift();
    while (nodes.length && nodes[nodes.length - 1].type === 'text' && !nodes[nodes.length - 1].text.trim()) nodes.pop();
    if (nodes.length) {
      if (nodes[0].type === 'text') nodes[0] = { ...nodes[0], text: nodes[0].text.replace(/^\s+/, '') };
      const last = nodes.length - 1;
      if (nodes[last].type === 'text') nodes[last] = { ...nodes[last], text: nodes[last].text.replace(/\s+$/, '') };
    }
    return nodes;
  }

  function inlineHasContent(inline) {
    return inline.some(node =>
      (node.type === 'text' && node.text.trim()) ||
      node.type === 'code' || node.type === 'math' || node.type === 'image' ||
      ((node.type === 'strong' || node.type === 'em' || node.type === 'del' || node.type === 'link') &&
        inlineHasContent(node.children || []))
    );
  }

  // ------------------------------------------------------------------
  // Block extraction
  // ------------------------------------------------------------------

  function codeBlockFrom(el) {
    const codeEl = el.querySelector('code');
    // textContent on <pre> already preserves whitespace; keep it verbatim.
    const text = String(codeEl?.textContent ?? el.textContent ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+$/, '');
    const cls = String(codeEl?.getAttribute('class') || el.getAttribute('class') || '');
    const lang = (cls.match(/language-([\w-]+)/i)?.[1] || el.getAttribute('data-language') || '').trim();
    return { type: 'code', lang, text, diagram: IR.isDiagram(lang, text) };
  }

  function tableFrom(el) {
    const rowEls = Array.from(el.querySelectorAll('tr'));
    if (!rowEls.length) return null;

    const parseRow = tr => Array.from(tr.querySelectorAll('th,td')).map(cell => ({
      blocks: extractBlocks(cell, { inlineOnly: true })
    }));

    const headRow = el.querySelector('thead tr') || rowEls[0];
    const bodyRows = rowEls.filter(tr => tr !== headRow);
    const head = parseRow(headRow);
    const rows = bodyRows.map(parseRow);
    const width = Math.max(head.length, ...rows.map(r => r.length), 1);

    const align = Array.from(headRow.querySelectorAll('th,td')).map(cell => {
      const value = (cell.getAttribute('align') || cell.style?.textAlign || '').toLowerCase();
      return value === 'center' || value === 'right' || value === 'left' ? value : null;
    });

    const pad = row => [...row, ...Array(Math.max(0, width - row.length)).fill(null)]
      .map(cell => cell || { blocks: [] });

    return {
      type: 'table',
      align: [...align, ...Array(Math.max(0, width - align.length)).fill(null)],
      head: pad(head),
      rows: rows.map(pad)
    };
  }

  function listFrom(el) {
    const ordered = el.tagName.toLowerCase() === 'ol';
    const start = Number(el.getAttribute('start') || 1) || 1;
    const items = Array.from(el.children)
      .filter(child => child.tagName?.toLowerCase() === 'li')
      .map(li => {
        const blocks = extractBlocks(li);
        const checkbox = li.querySelector(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]');
        if (checkbox) return { blocks, checked: checkbox.checked || checkbox.hasAttribute('checked') };
        return { blocks };
      });
    return { type: 'list', ordered, start, tight: true, items };
  }

  /**
   * @param {Element} root
   * @param {{inlineOnly?: boolean}} [options]
   * @returns {object[]} block IR
   */
  function extractBlocks(root, options = {}) {
    if (!(root instanceof Element)) return [];
    const blocks = [];
    let pending = [];

    const flush = () => {
      const inline = trimInline(pending);
      pending = [];
      if (inlineHasContent(inline)) blocks.push({ type: 'paragraph', inline });
    };

    for (const child of Array.from(root.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = normalizeWhitespace(child.nodeValue);
        if (text) pending.push({ type: 'text', text });
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      if (child.matches?.(SKIP_SELECTOR)) continue;

      const tag = child.tagName.toLowerCase();

      // Display math is a block; inline math stays in the run.
      if (isMathElement(child)) {
        const tex = texOf(child);
        if (!tex) continue;
        if (isDisplayMath(child)) {
          flush();
          blocks.push({ type: 'math', tex, display: true });
        } else {
          pending.push({ type: 'math', tex, display: false });
        }
        continue;
      }

      if (options.inlineOnly && !['ul', 'ol', 'pre', 'table', 'blockquote'].includes(tag)) {
        pending.push(...inlineNodesFor(child));
        continue;
      }

      // A character diagram outside <pre> must become a code block, or its
      // alignment is destroyed by whitespace collapsing.
      if (looksLikeCharacterDiagram(child)) {
        flush();
        const text = preservedText(child);
        blocks.push({ type: 'code', lang: '', text, diagram: true });
        continue;
      }

      if (/^h[1-6]$/.test(tag)) {
        flush();
        const inline = trimInline(extractInline(child));
        if (inlineHasContent(inline)) blocks.push({ type: 'heading', level: Number(tag[1]), inline });
        continue;
      }
      if (tag === 'pre') {
        flush();
        blocks.push(codeBlockFrom(child));
        continue;
      }
      if (tag === 'ul' || tag === 'ol') {
        flush();
        const list = listFrom(child);
        if (list.items.length) blocks.push(list);
        continue;
      }
      if (tag === 'blockquote') {
        flush();
        const inner = extractBlocks(child);
        if (inner.length) blocks.push({ type: 'quote', blocks: inner });
        continue;
      }
      if (tag === 'table') {
        flush();
        const table = tableFrom(child);
        if (table) blocks.push(table);
        continue;
      }
      if (tag === 'hr') {
        flush();
        blocks.push({ type: 'rule' });
        continue;
      }
      if (tag === 'img') {
        const image = imageFrom(child);
        if (image) { flush(); blocks.push(image); }
        continue;
      }
      if (tag === 'svg') {
        const image = svgToImage(child);
        if (image) { flush(); blocks.push(image); }
        continue;
      }
      if (tag === 'br') {
        pending.push({ type: 'break' });
        continue;
      }
      if (tag === 'input' && child.getAttribute('type') === 'checkbox') {
        // Consumed by listFrom() as the item's checked state.
        continue;
      }

      if (BLOCK_TAGS.has(tag)) {
        // A structural wrapper. Descend, but keep any inline run we were
        // building so a `<div>` used purely for layout does not split a
        // sentence into two paragraphs.
        const inner = extractBlocks(child, options);
        if (!inner.length) continue;
        if (inner.length === 1 && inner[0].type === 'paragraph' && !pending.length && tag === 'div') {
          blocks.push(inner[0]);
        } else {
          flush();
          blocks.push(...inner);
        }
        continue;
      }

      pending.push(...inlineNodesFor(child));
    }

    flush();
    return blocks;
  }

  /** Collapses runs of empty paragraphs the site's layout divs leave behind. */
  function tidy(blocks) {
    return (blocks || []).filter(block => {
      if (block.type === 'paragraph') return inlineHasContent(block.inline);
      if (block.type === 'list') return block.items.some(item => tidy(item.blocks).length);
      return true;
    }).map(block => {
      if (block.type === 'list') {
        return { ...block, items: block.items.map(item => ({ ...item, blocks: tidy(item.blocks) })) };
      }
      if (block.type === 'quote' || block.type === 'artifact' || block.type === 'thinking') {
        return { ...block, blocks: tidy(block.blocks) };
      }
      return block;
    });
  }

  /** Guesses a language from an artifact title or panel class names. */
  function artifactLanguage(title, panel) {
    const fromTitle = /\.(jsx?|tsx?|py|java|rb|go|rs|c|cpp|cs|php|sh|sql|html|css|json|ya?ml|xml|md)$/i.exec(title || '');
    if (fromTitle) return fromTitle[1].toLowerCase();
    const cls = String(panel?.getAttribute?.('class') || '');
    return (cls.match(/language-([\w-]+)/i)?.[1] || '').toLowerCase();
  }

  /**
   * A Claude artifact.
   *
   * Code and file artifacts render in the panel as a stack of styled line
   * divs, so extracting them as prose loses the indentation entirely. Those
   * are emitted as a single code block with whitespace preserved; document and
   * markdown artifacts keep their normal block structure.
   */
  /**
   * Artifact title.
   *
   * A card's textContent is the title AND its type label AND often a line
   * count, all run together — "…Intake AnalysisDocument". Prefer an explicit
   * title element, then the first line only, then strip a trailing type word.
   */
  function artifactTitle(card) {
    const explicit = card.querySelector?.('[class*="title" i], h1, h2, h3')?.textContent;
    const raw = String(
      explicit ||
      card.getAttribute?.('aria-label') ||
      (typeof preservedText === 'function' ? preservedText(card) : card.textContent) ||
      'Artifact'
    );

    let title = normalizeWhitespace(raw.split('\n')[0]).trim();
    // Strip a type label the card appends with no separator.
    title = title.replace(
      /(Document|Code|React component|HTML|SVG|Diagram|Markdown|Text)$/,
      ''
    ).trim();
    title = title.replace(/\s*[·•|]\s*\d+\s*lines?$/i, '').trim();
    return title.slice(0, 120) || 'Artifact';
  }

  function artifactBlock(card) {
    const title = artifactTitle(card);
    const panel = card.__cgxArtifactPanel;
    const kind = card.getAttribute?.('data-artifact-type') || '';

    if (!panel) {
      return {
        type: 'artifact',
        title,
        kind,
        blocks: [{
          type: 'paragraph',
          inline: [{
            type: 'em',
            children: [{
              type: 'text',
              text: 'This artifact could not be opened at export time. Open it in the side panel and export again.'
            }]
          }]
        }]
      };
    }

    const panelText = String(panel.textContent || '').trim();
    const codeText = String(panel.querySelector?.('pre, code')?.textContent || '').trim();

    // Only treat the panel as code when code is the DOMINANT content. A prose
    // document containing one inline `code` span was being flattened into a
    // single monospaced blob, which is how a written report came out unreadable.
    const monoWrapper = panel.querySelector?.(
      '[class*="font-mono" i], [class*="code-block" i], [class*="cm-content" i]'
    );
    const structural = panel.querySelector?.('table, ul, ol, h1, h2, h3, h4');
    const monoish =
      panel.id === 'wiggle-file-content' ||
      Boolean(monoWrapper) ||
      /font-mono|code-block/i.test(String(panel.getAttribute?.('class') || '')) ||
      (codeText.length > 0 && panelText.length > 0 && codeText.length / panelText.length > 0.6);

    if (monoish && !structural) {
      const pre = panel.querySelector('pre');
      const text = pre ? codeBlockFrom(pre).text : preservedText(monoWrapper || panel);
      if (text.trim()) {
        return {
          type: 'artifact',
          title,
          kind: kind || 'code',
          blocks: [{ type: 'code', lang: artifactLanguage(title, panel), text, diagram: false }]
        };
      }
    }

    let inner = tidy(extractBlocks(panel));

    // The panel rendered but produced no blocks — a virtualised or
    // canvas-backed view. Fall back to its raw text rather than emitting an
    // artifact with an empty body.
    if (!inner.length) {
      const fallback = preservedText(panel).trim();
      if (fallback) {
        inner = fallback.split(/\n{2,}/).map(part => ({
          type: 'paragraph',
          inline: [{ type: 'text', text: part.replace(/\n/g, ' ').trim() }]
        })).filter(block => block.inline[0].text);
      }
    }

    return {
      type: 'artifact',
      title,
      kind,
      blocks: inner.length ? inner : [{
        type: 'paragraph',
        inline: [{
          type: 'em',
          children: [{
            type: 'text',
            text: 'This artifact rendered no readable content. Open it in the side panel and export again.'
          }]
        }]
      }]
    };
  }

  /**
   * Extracts a whole message body, plus any adapter-provided extras.
   *
   * @param {Element} body
   * @param {{artifacts?: Element[], thinking?: Element[], includeThinking?: boolean, includeArtifacts?: boolean}} [extras]
   */
  function fromMessage(body, extras = {}) {
    const blocks = tidy(extractBlocks(body));

    if (extras.includeThinking && extras.thinking?.length) {
      for (const node of extras.thinking) {
        const inner = tidy(extractBlocks(node));
        if (inner.length) blocks.unshift({ type: 'thinking', blocks: inner });
      }
    }

    if (extras.includeArtifacts !== false && extras.artifacts?.length) {
      for (const card of extras.artifacts) {
        blocks.push(artifactBlock(card));
      }
    }

    return blocks;
  }

  globalThis.ThreadExporterExtract = Object.freeze({
    artifactBlock,
    preservedText,
    looksLikeCharacterDiagram,
    extractBlocks,
    extractInline,
    inlineNodesFor,
    fromMessage,
    tidy
  });
})();
