/**
 * IR -> pdfmake document definition.
 *
 * Fixes carried over from the audit:
 *   F-05/07  nested lists and block content inside list items
 *   F-08     code no longer clipped: wrapped at >= 8 pt with a continuation mark
 *   F-10     question boxes are `unbreakable`, labels keep with their content
 *   F-11     TOC via pdfmake's toc/tocItem
 *   F-13     table column alignment honoured
 */
(() => {
  'use strict';

  const IR = globalThis.ThreadExporterIR;

  const MIN_CODE_FONT = 8;
  const MAX_CODE_FONT = 8.5;
  const CONTENT_WIDTH = { A4: 493, Letter: 510, Legal: 510 };

  // ---------------- font runs ----------------

  function fontForCodePoint(codePoint, previous = 'latin') {
    if (codePoint >= 0x0D80 && codePoint <= 0x0DFF) return 'sinhala';
    if (codePoint >= 0x0B80 && codePoint <= 0x0BFF) return 'tamil';
    if (
      (codePoint >= 0x1100 && codePoint <= 0x11FF) ||
      (codePoint >= 0x3130 && codePoint <= 0x318F) ||
      (codePoint >= 0xA960 && codePoint <= 0xA97F) ||
      (codePoint >= 0xAC00 && codePoint <= 0xD7AF) ||
      (codePoint >= 0xD7B0 && codePoint <= 0xD7FF)
    ) return 'korean';
    if ((codePoint >= 0x1F000 && codePoint <= 0x1FAFF) || (codePoint >= 0x1FC00 && codePoint <= 0x1FFFF)) return 'emoji';
    if (
      (codePoint >= 0x2190 && codePoint <= 0x2BFF) ||
      (codePoint >= 0x2300 && codePoint <= 0x23FF) ||
      (codePoint >= 0x2500 && codePoint <= 0x27FF)
    ) return 'symbols';
    if ((codePoint >= 0x0300 && codePoint <= 0x036F) || codePoint === 0x200D || codePoint === 0xFE0E || codePoint === 0xFE0F) {
      return previous;
    }
    return 'latin';
  }

  function pdfSafeText(text) {
    return String(text || '')
      .replace(/\u0000/g, '')
      .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
      // pdfmake can render a missing-glyph rectangle for variation selectors
      // and ZWJ even though they are shaping controls, not visible glyphs.
      // The bundled monochrome emoji font renders the base emoji safely; a
      // complex ZWJ sequence therefore degrades to adjacent emoji rather than
      // showing a blank square in the exported PDF.
      .replace(/[\u200D\uFE0E\uFE0F]/g, '');
  }

  function splitFontRuns(text, base = {}) {
    const runs = [];
    let current = null;
    for (const char of Array.from(pdfSafeText(text))) {
      const font = fontForCodePoint(char.codePointAt(0), current?.cgxFont || 'latin');
      if (current && current.cgxFont === font) current.text += char;
      else {
        current = { text: char, cgxFont: font, ...base };
        runs.push(current);
      }
    }
    return runs;
  }

  // ---------------- inline ----------------

  function inlineRuns(inline, inherited = {}) {
    const runs = [];
    for (const node of inline || []) {
      switch (node.type) {
        case 'text':
          runs.push(...splitFontRuns(node.text, inherited));
          break;
        case 'break':
          runs.push({ text: '\n', ...inherited });
          break;
        case 'code':
          runs.push({ text: String(node.text || ''), cgxFont: 'mono', fontSize: 9, background: '#F1F5F9', ...inherited });
          break;
        case 'strong':
          runs.push(...inlineRuns(node.children, { ...inherited, bold: true }));
          break;
        case 'em':
          runs.push(...inlineRuns(node.children, { ...inherited, italics: true }));
          break;
        case 'del':
          runs.push(...inlineRuns(node.children, { ...inherited, decoration: 'lineThrough' }));
          break;
        case 'link':
          runs.push(...inlineRuns(node.children, {
            ...inherited,
            link: node.href || undefined,
            color: '#1E5A8A',
            decoration: 'underline'
          }));
          break;
        case 'math':
          runs.push({ text: '', cgxMathInline: { tex: node.tex || '' } });
          break;
        case 'image':
          // Images are lifted to block level by `inlineImages`.
          break;
        default:
          break;
      }
    }
    return runs;
  }

  function inlineImages(inline, margin = [0, 4, 0, 8]) {
    const out = [];
    for (const node of inline || []) {
      if (node.type === 'image' && node.src) {
        out.push({ cgxImage: { src: node.src, alt: node.alt || 'Image' }, margin });
      } else if (node.children) {
        out.push(...inlineImages(node.children, margin));
      }
    }
    return out;
  }

  function textNode(inline, extra = {}) {
    const runs = inlineRuns(inline);
    return { text: runs.length ? runs : [{ text: '' }], ...extra };
  }

  // ---------------- code ----------------

  /**
   * Character diagrams keep their exact columns (no-wrap, shrink to fit).
   * Real code wraps at a legible size with a continuation marker rather than
   * being silently clipped off the right edge.
   */
  function codeNode(block, pageSize) {
    const text = pdfSafeText(block.text || '');
    const width = CONTENT_WIDTH[pageSize] || CONTENT_WIDTH.A4;
    const longest = Math.max(1, ...text.split('\n').map(line => Array.from(line).length));

    if (block.diagram) {
      // Landscape gives a wide diagram ~1.42x more room before it has to shrink.
      const landscapeWidth = (pageSize === 'A4' ? 700 : 720);
      const fittedPortrait = Math.min(MAX_CODE_FONT, width / (longest * 0.61));
      const useLandscape = fittedPortrait < 7;
      const fitted = useLandscape
        ? Math.min(MAX_CODE_FONT, landscapeWidth / (longest * 0.61))
        : fittedPortrait;

      return {
        cgxPreformatted: {
          text,
          diagram: true,
          language: block.lang || '',
          // 5.5pt was below print legibility; a diagram that still will not fit
          // is better rotated than shrunk into unreadability.
          fontSize: Math.max(6, fitted),
          landscape: useLandscape
        },
        margin: [7, 6, 7, 8],
        background: '#F4F6F8'
      };
    }

    // Preserve source text byte-for-byte at the IR boundary. The previous
    // implementation inserted ↴/↳ continuation characters into long lines,
    // so copying code from the PDF produced source that never existed in the
    // conversation. pdf-worker.js already allows non-diagram lines to wrap.
    return {
      cgxPreformatted: {
        text,
        diagram: false,
        language: block.lang || '',
        fontSize: MIN_CODE_FONT,
        landscape: false
      },
      margin: [7, 6, 7, 8],
      background: '#F4F6F8'
    };
  }

  // ---------------- blocks ----------------

  function listItemNodes(item, pageSize) {
    const stack = blocksToNodes(item.blocks, pageSize);
    if (item.checked !== undefined) {
      const mark = item.checked ? '\u2611 ' : '\u2610 ';
      const first = stack[0];
      if (first && Array.isArray(first.text)) first.text = [{ text: mark, cgxFont: 'symbols' }, ...first.text];
    }
    if (stack.length === 1) return stack[0];
    return { stack };
  }

  function listNode(block, pageSize) {
    const items = (block.items || []).map(item => listItemNodes(item, pageSize));
    const node = block.ordered
      ? { ol: items, start: Number(block.start || 1) || 1 }
      : { ul: items };
    node.margin = [10, 0, 0, block.tight === false ? 7 : 4];
    if (block.items?.some(item => item.checked !== undefined)) {
      // Task lists carry their own glyph; suppress the bullet.
      node.type = 'none';
    }
    return node;
  }

  function tableNode(block, pageSize) {
    const width = Math.max(block.head?.length || 0, ...(block.rows || []).map(r => r.length), 1);
    const align = [...(block.align || []), ...Array(width).fill(null)].slice(0, width);

    const renderRow = (row, isHeader) => {
      const cells = [...(row || []), ...Array(Math.max(0, width - (row?.length || 0))).fill({ blocks: [] })];
      return cells.map((cell, index) => {
        const stack = blocksToNodes(cell.blocks, pageSize, { bold: isHeader });
        // Only set keys that have a value: an explicit `undefined` is dropped
        // by JSON when the definition crosses extension messaging, which would
        // make the sent document differ from the built one.
        const cellNode = { stack: stack.length ? stack : [{ text: '' }], margin: [3, 3, 3, 3] };
        if (isHeader) cellNode.fillColor = '#EEF3F8';
        if (align[index]) cellNode.alignment = align[index];
        return cellNode;
      });
    };

    const body = [renderRow(block.head, true), ...(block.rows || []).map(row => renderRow(row, false))];

    return {
      table: {
        headerRows: 1,
        // Repeat the header on every page the table spans.
        keepWithHeaderRows: 1,
        dontBreakRows: true,
        widths: Array(width).fill('*'),
        body
      },
      layout: 'lightHorizontalLines',
      fontSize: 8.5,
      margin: [0, 4, 0, 9]
    };
  }

  function blocksToNodes(blocks, pageSize, inherited = {}) {
    const out = [];

    for (const block of blocks || []) {
      switch (block.type) {
        case 'heading': {
          const style = block.level <= 2 ? 'h2' : block.level === 3 ? 'h3' : 'h4';
          out.push(textNode(block.inline, {
            style,
            margin: [0, 8, 0, 5],
            // Never let a heading orphan at the foot of a page.
            unbreakable: true
          }));
          out.push(...inlineImages(block.inline));
          break;
        }

        case 'paragraph': {
          const node = textNode(block.inline, { margin: [0, 0, 0, 7], lineHeight: 1.28, ...inherited });
          if (node.text.some(run => run.text || run.cgxMathInline)) out.push(node);
          out.push(...inlineImages(block.inline));
          break;
        }

        case 'code': {
          const node = codeNode(block, pageSize);
          out.push(node);
          if (node.cgxPreformatted?.landscape) {
            // pdfmake applies pageOrientation from that page onward, so the
            // following node has to switch it back or the rest of the document
            // stays rotated.
            out.push({ text: '', pageBreak: 'after', pageOrientation: 'portrait', cgxRestoreOrientation: true });
          }
          break;
        }

        case 'list':
          out.push(listNode(block, pageSize));
          break;

        case 'quote':
          out.push({
            stack: blocksToNodes(block.blocks, pageSize, { color: '#405268' }),
            margin: [10, 4, 8, 8],
            background: '#F8FAFC'
          });
          break;

        case 'table':
          out.push(tableNode(block, pageSize));
          break;

        case 'rule':
          out.push({
            canvas: [{ type: 'line', x1: 0, y1: 0, x2: 480, y2: 0, lineWidth: 0.5, lineColor: '#D1D5DB' }],
            margin: [0, 5, 0, 8]
          });
          break;

        case 'image':
          out.push({ cgxImage: { src: block.src, alt: block.alt || 'Image' }, margin: [0, 4, 0, 8] });
          break;

        case 'math':
          out.push({ cgxMath: { tex: block.tex || '', display: true } });
          break;

        case 'artifact':
          out.push({
            unbreakable: false,
            stack: [
              { text: splitFontRuns('ARTIFACT · ' + (block.title || 'Untitled')), style: 'label', margin: [0, 6, 0, 4] },
              ...blocksToNodes(block.blocks, pageSize)
            ],
            margin: [8, 4, 8, 8],
            background: '#FAFAFA'
          });
          break;

        case 'thinking':
          out.push({
            stack: [
              { text: splitFontRuns('THINKING'), style: 'label', margin: [0, 4, 0, 3] },
              ...blocksToNodes(block.blocks, pageSize, { color: '#64748B', fontSize: 9.5 })
            ],
            margin: [10, 4, 8, 8],
            background: '#F8FAFC'
          });
          break;

        default:
          break;
      }
    }

    return out;
  }

  /**
   * @param {{title: string, url?: string, platform?: string, platformLabel?: string}} data
   * @param {object[]} turns  each with {index, question:{blocks}, answers:[{blocks}]}
   * @param {{pageSize?: string, appName?: string, includeToc?: boolean}} options
   */
  function buildDefinition(data, turns, options = {}) {
    const pageSize = options.pageSize || 'A4';
    const appName = options.appName || 'AI Thread Exporter';
    const title = options.documentTitle || data.title || 'Conversation';
    const single = turns.length === 1;
    const includeToc = options.includeToc !== false && turns.length >= 4;

    const content = [
      { text: splitFontRuns(title), style: 'title', margin: [0, 0, 0, includeToc ? 12 : 16] }
    ];

    if (includeToc) {
      content.push({
        toc: {
          title: { text: splitFontRuns('Contents'), style: 'h2', margin: [0, 0, 0, 6] }
        },
        margin: [0, 0, 0, 14]
      });
      content.push({ text: '', pageBreak: 'after' });
    }

    turns.forEach((turn, index) => {
      const n = Number.isFinite(turn.index) ? turn.index + 1 : index + 1;
      const label = 'QUESTION ' + String(n).padStart(2, '0');
      const heading = IR.blocksToPlainText(turn.question.blocks || []).split('\n')[0].slice(0, 80) || label;

      const questionNodes = blocksToNodes(turn.question.blocks || [], pageSize);
      content.push({
        // The label remains a single unbreakable node, but the question body
        // is allowed to paginate. Making the entire box unbreakable can make a
        // long pasted prompt taller than a page and break layout.
        stack: [
          {
            text: splitFontRuns(label),
            style: 'label',
            margin: [0, 8, 0, 5],
            tocItem: includeToc,
            tocStyle: { fontSize: 10 },
            tocMargin: [0, 2, 0, 2]
          },
          {
            table: {
              widths: [3, '*'],
              body: [[
                { text: '', fillColor: '#2E5B88' },
                { stack: questionNodes.length ? questionNodes : [{ text: '' }], margin: [9, 7, 8, 3], fillColor: '#F7F9FC' }
              ]]
            },
            layout: 'noBorders',
            margin: [0, 0, 0, 10]
          }
        ]
      });
      // pdfmake reads the TOC entry text from the node carrying `tocItem`;
      // give it the question's own first line rather than the generic label.
      content[content.length - 1].stack[0].tocText = heading;

      const answers = (turn.answers || []).filter(answer => (answer.blocks || []).length);
      answers.forEach((answer, answerIndex) => {
        content.push({
          text: splitFontRuns(answers.length > 1 ? 'ANSWER ' + String(answerIndex + 1).padStart(2, '0') : 'ANSWER'),
          style: 'answerLabel',
          margin: [0, 5, 0, 5],
          unbreakable: true
        });
        content.push(...blocksToNodes(answer.blocks, pageSize));
      });

      if (index < turns.length - 1) {
        content.push({
          canvas: [{ type: 'line', x1: 0, y1: 0, x2: 480, y2: 0, lineWidth: 0.45, lineColor: '#D8E1EB' }],
          margin: [0, 8, 0, 10]
        });
      }
    });

    return {
      pageSize,
      pageMargins: [51, 51, 51, 55],
      info: {
        title,
        author: appName,
        subject: (data.platformLabel || 'AI') + ' conversation export',
        creator: appName,
        producer: appName
      },
      // Consumed by the offscreen renderer for the page footer.
      cgxFooterLabel: appName,
      cgxSingleTurn: single,
      defaultStyle: { font: 'Roboto', fontSize: 10.5, color: '#243142', lineHeight: 1.24 },
      styles: {
        title: { fontSize: 23, bold: true, color: '#183B56' },
        h2: { fontSize: 14, bold: true, color: '#183B56' },
        h3: { fontSize: 12, bold: true, color: '#264C70' },
        h4: { fontSize: 11, bold: true, color: '#334E6B' },
        label: { fontSize: 8.2, bold: true, color: '#5A6B7E', characterSpacing: 0.8 },
        answerLabel: { fontSize: 8.2, bold: true, color: '#1E3A5F', characterSpacing: 0.8 }
      },
      content
    };
  }

  globalThis.ThreadExporterPdfIR = Object.freeze({
    buildDefinition,
    blocksToNodes,
    splitFontRuns,
    inlineRuns
  });
})();
