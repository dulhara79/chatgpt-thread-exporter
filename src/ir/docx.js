/**
 * IR -> WordprocessingML body.
 *
 * Fixes carried over from the audit:
 *   F-05/07  nested lists via w:ilvl, block content inside list items
 *   F-06     exactly two abstract numbering definitions (bullet + decimal),
 *            nine levels each, one w:num per *list* rather than per item
 *   F-09     repeating header rows, fixed table layout, non-splitting rows
 *   F-11     TOC field + outline levels
 */
(() => {
  'use strict';

  const IR = globalThis.ThreadExporterIR;
  const MAX_LIST_LEVEL = 8;

  const ABSTRACT_BULLET = 0;
  const ABSTRACT_DECIMAL = 1;

  function xmlEscape(value) {
    return String(value == null ? '' : value).replace(/[<>&"']/g, ch => ({
      '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'
    }[ch]));
  }

  /**
   * Word rejects most C0 control characters outright — a single stray one makes
   * the whole package "unreadable content".
   */
  function sanitize(value) {
    return String(value == null ? '' : value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  }

  function run(text, opts = {}) {
    const value = sanitize(text);
    const preserve = /^\s|\s$|\n/.test(value) ? ' xml:space="preserve"' : '';
    const props = [
      opts.bold ? '<w:b/>' : '',
      opts.italic ? '<w:i/>' : '',
      opts.strike ? '<w:strike/>' : '',
      opts.underline ? '<w:u w:val="single"/>' : '',
      opts.color ? `<w:color w:val="${opts.color}"/>` : '',
      opts.size ? `<w:sz w:val="${opts.size}"/><w:szCs w:val="${opts.size}"/>` : '',
      opts.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas" w:cs="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F4F6F8"/>' : ''
    ].join('');
    const content = value.split('\n')
      .map((part, index) => `${index ? '<w:br/>' : ''}<w:t${preserve}>${xmlEscape(part)}</w:t>`)
      .join('');
    return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}${content}</w:r>`;
  }

  /**
   * @typedef {Object} DocxContext
   * @property {(href: string) => string} hyperlinkRel   returns an rId
   * @property {(token: {src: string, alt: string}) => string} imageXml
   * @property {(ordered: boolean, start: number) => number} allocateNumbering
   * @property {(tex: string) => string} ommlInline
   * @property {(tex: string) => string} ommlParagraph
   */

  function inlineXml(inline, ctx, inherited = {}) {
    return (inline || []).map(node => {
      switch (node.type) {
        case 'text': return run(node.text, inherited);
        case 'break': return '<w:r><w:br/></w:r>';
        case 'code': return run(node.text, { ...inherited, code: true, size: 18 });
        case 'strong': return inlineXml(node.children, ctx, { ...inherited, bold: true });
        case 'em': return inlineXml(node.children, ctx, { ...inherited, italic: true });
        case 'del': return inlineXml(node.children, ctx, { ...inherited, strike: true });
        case 'link': {
          const id = ctx.hyperlinkRel(node.href || '');
          const inner = inlineXml(node.children, ctx, { ...inherited, color: '0563C1', underline: true });
          return `<w:hyperlink r:id="${id}">${inner}</w:hyperlink>`;
        }
        case 'image': return ctx.imageXml({ src: node.src, alt: node.alt || 'Image' });
        case 'math': return ctx.ommlInline(node.tex || '');
        default: return '';
      }
    }).join('');
  }

  function paragraph(contentXml, opts = {}) {
    const numPr = opts.numId
      ? `<w:numPr><w:ilvl w:val="${opts.level || 0}"/><w:numId w:val="${opts.numId}"/></w:numPr>`
      : '';
    const pPr = [
      opts.style ? `<w:pStyle w:val="${opts.style}"/>` : '',
      numPr,
      opts.align ? `<w:jc w:val="${opts.align}"/>` : '',
      (opts.before || opts.after || opts.line)
        ? `<w:spacing w:before="${opts.before || 0}" w:after="${opts.after == null ? 140 : opts.after}" w:line="${opts.line || 300}" w:lineRule="auto"/>`
        : '',
      opts.keepNext ? '<w:keepNext/>' : '',
      opts.keepLines ? '<w:keepLines/>' : '',
      opts.indent ? `<w:ind w:left="${opts.indent}"/>` : '',
      opts.borderLeft ? `<w:pBdr><w:left w:val="single" w:sz="${opts.borderLeft.size || 18}" w:space="8" w:color="${opts.borderLeft.color || '64748B'}"/></w:pBdr>` : '',
      opts.shading ? `<w:shd w:val="clear" w:color="auto" w:fill="${opts.shading}"/>` : ''
    ].join('');
    return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${contentXml || ''}</w:p>`;
  }

  function codeXml(block, ctx, indent = 0) {
    const label = block.lang
      ? paragraph(run(String(block.lang).toUpperCase()), { style: 'CodeLabel', keepNext: true, indent: indent || undefined })
      : '';
    const lines = String(block.text || '').split('\n');
    // One paragraph per line keeps shading contiguous and lets Word break a
    // long block across pages sensibly.
    const body = lines.map((line, index) => paragraph(
      run(line || ' ', { code: true, size: 18 }),
      {
        shading: 'F3F4F6',
        borderLeft: { color: 'CBD5E1', size: 8 },
        before: 0,
        after: index === lines.length - 1 ? 160 : 0,
        line: 240,
        keepLines: true,
        indent: indent || undefined
      }
    )).join('');
    return label + body;
  }

  function tableXml(block, ctx, opts = {}) {
    const width = Math.max(block.head?.length || 0, ...(block.rows || []).map(r => r.length), 1);
    const totalWidth = opts.width || (9360 - (opts.indent || 0));
    const colWidth = Math.floor(totalWidth / width);
    const align = [...(block.align || []), ...Array(width).fill(null)].slice(0, width);
    const grid = Array(width).fill(`<w:gridCol w:w="${colWidth}"/>`).join('');

    const renderRow = (row, isHeader) => {
      const cells = [...(row || []), ...Array(Math.max(0, width - (row?.length || 0))).fill({ blocks: [] })];
      const cellXml = cells.map((cell, index) => {
        const inner = blocksToXml(cell.blocks, ctx, {
          inTable: true,
          runBase: isHeader ? { bold: true } : {},
          align: align[index] || undefined
        }) || paragraph('', { after: 0 });
        return `<w:tc><w:tcPr><w:tcW w:w="${colWidth}" w:type="dxa"/>` +
          (isHeader ? '<w:shd w:val="clear" w:color="auto" w:fill="EEF3F8"/>' : '') +
          '<w:tcMar><w:top w:w="80" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tcMar>' +
          `</w:tcPr>${inner}</w:tc>`;
      }).join('');
      // tblHeader repeats the header on every page the table spans;
      // cantSplit stops a single row being torn across the seam.
      const trPr = `<w:trPr>${isHeader ? '<w:tblHeader/>' : ''}<w:cantSplit/></w:trPr>`;
      return `<w:tr>${trPr}${cellXml}</w:tr>`;
    };

    const rows = [renderRow(block.head, true), ...(block.rows || []).map(row => renderRow(row, false))].join('');

    return '<w:tbl><w:tblPr>' +
      `<w:tblW w:w="${totalWidth}" w:type="dxa"/>` +
      (opts.indent ? `<w:tblInd w:w="${opts.indent}" w:type="dxa"/>` : '') +
      '<w:tblLayout w:type="fixed"/>' +
      '<w:tblBorders>' +
      ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
        .map(side => `<w:${side} w:val="single" w:sz="4" w:color="CBD5E1"/>`).join('') +
      '</w:tblBorders></w:tblPr>' +
      `<w:tblGrid>${grid}</w:tblGrid>${rows}</w:tbl>`;
  }

  /**
   * Emits list items as flat paragraphs carrying `w:ilvl`, which is how Word
   * models nesting. One `w:num` is allocated per list, not per item.
   */
  function listXml(block, ctx, level, opts) {
    const numId = ctx.allocateNumbering(Boolean(block.ordered), Number(block.start || 1) || 1);
    const out = [];

    for (const item of block.items || []) {
      const blocks = item.blocks || [];
      let first = true;

      for (const child of blocks) {
        if (child.type === 'list') {
          out.push(listXml(child, ctx, Math.min(level + 1, MAX_LIST_LEVEL), opts));
          continue;
        }
        if (child.type === 'paragraph') {
          const prefix = item.checked === undefined ? '' : (item.checked ? '\u2611 ' : '\u2610 ');
          const inner = (prefix ? run(prefix) : '') + inlineXml(child.inline, ctx, opts.runBase);
          out.push(paragraph(inner, first
            ? { numId, level, after: 70, line: 290 }
            : { indent: 720 * (level + 1), after: 70, line: 290 }));
          first = false;
          continue;
        }
        // Non-paragraph block content inside a list item (code, table, quote,
        // image) is emitted at the item's indent instead of being orphaned at
        // the left margin.
        out.push(blocksToXml([child], ctx, { ...opts, indentBase: 720 * (level + 1) }));
        first = false;
      }

      if (!blocks.length) out.push(paragraph('', { numId, level, after: 70 }));
    }

    return out.join('');
  }

  function blocksToXml(blocks, ctx, opts = {}) {
    const parts = [];
    const runBase = opts.runBase || {};

    for (const block of blocks || []) {
      switch (block.type) {
        case 'heading': {
          const level = Math.min(Math.max(block.level, 1), 4);
          const style = level <= 1 ? 'Heading2' : level === 2 ? 'Heading3' : 'Heading4';
          parts.push(paragraph(inlineXml(block.inline, ctx, runBase), { style, keepNext: true }));
          break;
        }

        case 'paragraph':
          parts.push(paragraph(inlineXml(block.inline, ctx, runBase), {
            after: opts.inTable ? 0 : 150,
            line: 300,
            align: opts.align,
            indent: opts.indentBase
          }));
          break;

        case 'code':
          parts.push(codeXml(block, ctx, opts.indentBase || 0));
          break;

        case 'list':
          parts.push(listXml(block, ctx, 0, { runBase }));
          break;

        case 'quote':
          parts.push(blocksToXml(block.blocks, ctx, {
            ...opts,
            quote: true,
            indentBase: (opts.indentBase || 0) + 360
          }));
          break;

        case 'table':
          parts.push(tableXml(block, ctx, { indent: opts.indentBase || 0 }));
          parts.push(paragraph('', { after: 80 }));
          break;

        case 'rule':
          parts.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="6" w:color="D1D5DB"/></w:pBdr><w:spacing w:before="100" w:after="100"/></w:pPr></w:p>');
          break;

        case 'image':
          parts.push(paragraph(ctx.imageXml({ src: block.src, alt: block.alt || 'Image' }), { after: 140 }));
          break;

        case 'math':
          parts.push(ctx.ommlParagraph(block.tex || ''));
          break;

        case 'artifact':
          parts.push(paragraph(run('ARTIFACT · ' + (block.title || 'Untitled')), { style: 'SectionLabel', keepNext: true }));
          parts.push(blocksToXml(block.blocks, ctx, opts));
          break;

        case 'thinking':
          parts.push(paragraph(run('THINKING'), { style: 'SectionLabel', keepNext: true }));
          parts.push(blocksToXml(block.blocks, ctx, {
            ...opts,
            runBase: { ...runBase, color: '64748B' },
            indentBase: (opts.indentBase || 0) + 360
          }));
          break;

        default:
          break;
      }
    }

    return parts.join('');
  }

  /**
   * Two abstract definitions, nine levels each. This is what makes the lists
   * behave as real Word lists (promote/demote, renumber, continue).
   */
  function abstractNumbering() {
    const level = (index, ordered) => {
      const indent = 720 * (index + 1);
      const bullets = ['\u2022', '\u25E6', '\u25AA'];
      const formats = ['decimal', 'lowerLetter', 'lowerRoman'];
      return '<w:lvl w:ilvl="' + index + '">' +
        '<w:start w:val="1"/>' +
        (ordered
          ? `<w:numFmt w:val="${formats[index % 3]}"/><w:lvlText w:val="%${index + 1}."/>`
          : `<w:numFmt w:val="bullet"/><w:lvlText w:val="${bullets[index % 3]}"/>`) +
        '<w:lvlJc w:val="left"/>' +
        `<w:pPr><w:ind w:left="${indent}" w:hanging="360"/></w:pPr>` +
        (ordered ? '' : '<w:rPr><w:rFonts w:ascii="Segoe UI Symbol" w:hAnsi="Segoe UI Symbol" w:hint="default"/></w:rPr>') +
        '</w:lvl>';
    };

    const build = (id, ordered) =>
      `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="hybridMultilevel"/>` +
      Array.from({ length: MAX_LIST_LEVEL + 1 }, (_, index) => level(index, ordered)).join('') +
      '</w:abstractNum>';

    return build(ABSTRACT_BULLET, false) + build(ABSTRACT_DECIMAL, true);
  }

  /**
   * @param {{id: number, ordered: boolean, start: number}[]} instances
   */
  function numberingXml(instances) {
    const nums = instances.map(instance => {
      const abstractId = instance.ordered ? ABSTRACT_DECIMAL : ABSTRACT_BULLET;
      const override = instance.ordered && instance.start !== 1
        ? `<w:lvlOverride w:ilvl="0"><w:startOverride w:val="${instance.start}"/></w:lvlOverride>`
        : '';
      return `<w:num w:numId="${instance.id}"><w:abstractNumId w:val="${abstractId}"/>${override}</w:num>`;
    }).join('');

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      abstractNumbering() + nums + '</w:numbering>';
  }

  /** A TOC field Word populates on open (settings.xml sets updateFields). */
  function tocFieldXml() {
    return '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr>' + run('Contents') + '</w:p>' +
      '<w:p><w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>' +
      '<w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
      run('Right-click and choose "Update Field" if this table is empty.', { color: '64748B', size: 18 }) +
      '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>' +
      '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  }

  globalThis.ThreadExporterDocxIR = Object.freeze({
    blocksToXml,
    inlineXml,
    paragraph,
    run,
    numberingXml,
    tocFieldXml,
    xmlEscape,
    sanitize,
    MAX_LIST_LEVEL
  });
})();
