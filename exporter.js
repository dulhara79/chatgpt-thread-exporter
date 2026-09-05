(() => {
  'use strict';

  const APP_NAME = 'ChatGPT Thread Exporter';
  const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const mathRenderer = globalThis.ChatGPTMath || null;

  const PAGE_SIZES = Object.freeze({
    A4: { css: 'A4', width: 11906, height: 16838 },
    Letter: { css: 'Letter', width: 12240, height: 15840 },
    Legal: { css: 'Legal', width: 12240, height: 20160 }
  });

  function normalizePageSize(value) {
    const key = String(value || 'A4').toLowerCase();
    if (key === 'letter') return 'Letter';
    if (key === 'legal') return 'Legal';
    return 'A4';
  }

  function shouldIncludeImage(meta = {}) {
    const src = String(meta.src || '').trim();
    if (!src || /^javascript:/i.test(src)) return false;
    const haystack = [src, meta.alt || '', meta.className || '', meta.role || ''].join(' ').toLowerCase();
    if (/google\.com\/s2\/favicons|favicon|apple-touch-icon|avatar|profile[-_ ]?image|toolbar[-_ ]?icon|tracking[-_ ]?pixel/.test(haystack)) return false;
    const width = Number(meta.width || 0);
    const height = Number(meta.height || 0);
    if (width > 0 && height > 0 && width <= 64 && height <= 64) return false;
    if (width > 0 && height > 0 && width * height < 4096) return false;
    return true;
  }

  function normalizeText(text) {
    return (text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function safeFilename(title) {
    const cleaned = (title || 'ChatGPT Conversation')
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100);
    return cleaned || 'ChatGPT Conversation';
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  function xmlEscape(value) {
    return String(value || '').replace(/[<>&"']/g, ch => ({
      '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'
    }[ch]));
  }

  function formatDate(date = new Date()) {
    try {
      return new Intl.DateTimeFormat(undefined, {
        year: 'numeric', month: 'long', day: '2-digit',
        hour: '2-digit', minute: '2-digit'
      }).format(date);
    } catch {
      return date.toLocaleString();
    }
  }

  function documentTitle(data, turns) {
    if (turns.length === 1 && Number.isFinite(turns[0].index)) {
      return `${data.title} — Q&A ${turns[0].index + 1}`;
    }
    return data.title || 'ChatGPT Conversation';
  }

  function exportFilename(data, turns, extension) {
    let title = safeFilename(data.title || 'ChatGPT Conversation');
    if (turns.length === 1 && Number.isFinite(turns[0].index)) {
      title += ` - QA ${turns[0].index + 1}`;
    }
    return `${title}.${extension}`;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    (document.body || document.documentElement).appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 6000);
  }

  // ---------------- Markdown document ----------------

  function createMarkdown(data, turns) {
    const title = documentTitle(data, turns);
    const lines = ['# ' + title, ''];
    turns.forEach((turn, idx) => {
      const n = Number.isFinite(turn.index) ? turn.index + 1 : idx + 1;
      lines.push('## Question ' + n, '', turn.question.markdown || turn.question.text || '', '');
      const answers = (turn.answers || []).filter(a => a.text || a.markdown);
      answers.forEach((answer, answerIndex) => {
        lines.push(answers.length > 1 ? '## Answer ' + (answerIndex + 1) : '## Answer', '', answer.markdown || answer.text || '', '');
      });
      if (idx < turns.length - 1) lines.push('---', '');
    });
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  }

  // ---------------- Shared Markdown parser ----------------

  function parseTableRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map(cell => cell.trim());
  }

  function isTableSeparator(line) {
    const cells = parseTableRow(line);
    return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell.replace(/\s/g, '')));
  }

  function parseMarkdownBlocks(markdown) {
    const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    let i = 0;

    while (i < lines.length) {
      const raw = lines[i];
      const fence = raw.match(/^```\s*([^`]*)$/);
      if (fence) {
        const lang = fence[1].trim();
        const code = [];
        i += 1;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) {
          code.push(lines[i]);
          i += 1;
        }
        if (i < lines.length) i += 1;
        blocks.push({ type: 'code', lang, text: code.join('\n') });
        continue;
      }

      if (/^\s*\|?.+\|.+\|?\s*$/.test(raw) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        const rows = [parseTableRow(raw)];
        i += 2;
        while (i < lines.length && /^\s*\|?.+\|.+\|?\s*$/.test(lines[i])) {
          rows.push(parseTableRow(lines[i]));
          i += 1;
        }
        const width = Math.max(...rows.map(r => r.length));
        blocks.push({
          type: 'table',
          rows: rows.map(r => [...r, ...Array(Math.max(0, width - r.length)).fill('')])
        });
        continue;
      }

      const heading = raw.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
        i += 1;
        continue;
      }

      const ordered = raw.match(/^\s*(\d+)\.\s+(.*)$/);
      if (ordered) {
        blocks.push({ type: 'list', ordered: true, marker: Number(ordered[1]), text: ordered[2] });
        i += 1;
        continue;
      }

      const bullet = raw.match(/^\s*[-*+]\s+(.*)$/);
      if (bullet) {
        blocks.push({ type: 'list', ordered: false, text: bullet[1] });
        i += 1;
        continue;
      }

      const quote = raw.match(/^>\s?(.*)$/);
      if (quote) {
        const quoteLines = [quote[1]];
        i += 1;
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^>\s?/, ''));
          i += 1;
        }
        blocks.push({ type: 'quote', text: quoteLines.join('\n') });
        continue;
      }

      if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(raw)) {
        blocks.push({ type: 'rule' });
        i += 1;
        continue;
      }

      if (!raw.trim()) {
        blocks.push({ type: 'blank' });
        i += 1;
        continue;
      }

      const paragraph = [raw];
      i += 1;
      while (i < lines.length && lines[i].trim() &&
        !/^```/.test(lines[i]) &&
        !/^(#{1,6})\s+/.test(lines[i]) &&
        !/^\s*(?:\d+\.|[-*+])\s+/.test(lines[i]) &&
        !/^>\s?/.test(lines[i]) &&
        !(i + 1 < lines.length && /^\s*\|?.+\|.+\|?\s*$/.test(lines[i]) && isTableSeparator(lines[i + 1]))) {
        paragraph.push(lines[i]);
        i += 1;
      }
      blocks.push({ type: 'text', text: paragraph.join('\n') });
    }
    return blocks;
  }

  function renderMathHtml(tex, display = false) {
    if (mathRenderer?.toMathML) return mathRenderer.toMathML(tex, display);
    return '<span class="math-fallback">' + escapeHtml(tex) + '</span>';
  }
  function inlineToHtml(text) {
    const source = String(text || '');
    const tokens = [];
    let placeholderIndex = 0;
    const stash = html => {
      const key = `\u0000CGX${placeholderIndex++}\u0000`;
      tokens.push([key, html]);
      return key;
    };

    let value = source
      .replace(/`([^`]+)`/g, (_, code) => stash('<code class="inline-code">' + escapeHtml(code) + '</code>'))
      .replace(/!\[([^\]]*)\]\((https?:\/\/[^)]+|data:image\/[^)]+)\)/g, (_, alt, src) => stash('<figure class="media"><img src="' + escapeHtml(src) + '" alt="' + escapeHtml(alt || 'Image') + '" referrerpolicy="no-referrer"></figure>'))
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_, label, href) => stash('<a href="' + escapeHtml(href) + '">' + escapeHtml(label) + '</a>'))
      .replace(/\\\[([\s\S]*?)\\\]/g, (_, tex) => stash('<div class="math-display">' + renderMathHtml(tex.trim(), true) + '</div>'))
      .replace(/\$\$([\s\S]*?)\$\$/g, (_, tex) => stash('<div class="math-display">' + renderMathHtml(tex.trim(), true) + '</div>'))
      .replace(/\\\((.*?)\\\)/g, (_, tex) => stash('<span class="math-inline">' + renderMathHtml(tex.trim(), false) + '</span>'))
      .replace(/\$([^$\n]+)\$/g, (_, tex) => stash('<span class="math-inline">' + renderMathHtml(tex.trim(), false) + '</span>'));

    value = escapeHtml(value)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
      .replace(/_([^_\n]+)_/g, '<em>$1</em>')
      .replace(/\n/g, '<br>');

    for (const [key, html] of tokens) value = value.replace(escapeHtml(key), html);
    return value;
  }

  function blocksToHtml(markdown) {
    const html = [];
    let listType = null;

    const closeList = () => {
      if (listType) html.push(listType === 'ol' ? '</ol>' : '</ul>');
      listType = null;
    };

    for (const block of parseMarkdownBlocks(markdown)) {
      if (block.type !== 'list') closeList();

      if (block.type === 'blank') continue;
      if (block.type === 'heading') {
        const level = Math.min(6, block.level + 2);
        html.push(`<h${level}>${inlineToHtml(block.text)}</h${level}>`);
      } else if (block.type === 'text') {
        html.push(`<p>${inlineToHtml(block.text)}</p>`);
      } else if (block.type === 'quote') {
        html.push(`<blockquote>${inlineToHtml(block.text)}</blockquote>`);
      } else if (block.type === 'rule') {
        html.push('<hr>');
      } else if (block.type === 'code') {
        const diagram = /^(?:mermaid|diagram|flowchart|graphviz|dot|plantuml|ascii|text)$/i.test(block.lang || '') || /[┌┐└┘├┤┬┴┼│─▼▲►◄→←]/.test(block.text || '');
        const cls = diagram ? 'code-wrap diagram-wrap' : 'code-wrap';
        const preCls = diagram ? ' class="diagram-code"' : '';
        html.push(`<div class="${cls}">${block.lang ? `<div class="code-lang">${escapeHtml(block.lang)}</div>` : ''}<pre${preCls}><code>${escapeHtml(block.text)}</code></pre></div>`);
      } else if (block.type === 'list') {
        const wanted = block.ordered ? 'ol' : 'ul';
        if (listType !== wanted) {
          closeList();
          html.push(block.ordered ? '<ol start="' + (block.marker || 1) + '">' : '<ul>');
          listType = wanted;
        }
        html.push(block.ordered ? '<li value="' + (block.marker || 1) + '">' + inlineToHtml(block.text) + '</li>' : '<li>' + inlineToHtml(block.text) + '</li>');
      } else if (block.type === 'table') {
        const [head, ...rows] = block.rows;
        html.push('<div class="table-wrap"><table><thead><tr>');
        head.forEach(cell => html.push(`<th>${inlineToHtml(cell)}</th>`));
        html.push('</tr></thead><tbody>');
        rows.forEach(row => {
          html.push('<tr>');
          row.forEach(cell => html.push(`<td>${inlineToHtml(cell)}</td>`));
          html.push('</tr>');
        });
        html.push('</tbody></table></div>');
      }
    }
    closeList();
    return html.join('');
  }

  // ---------------- Print-ready PDF HTML ----------------

  function buildPrintHtml(data, turns, options = {}) {
    const title = documentTitle(data, turns);
    const pageSize = normalizePageSize(options.pageSize);
    const sections = [];

    turns.forEach((turn, idx) => {
      const n = Number.isFinite(turn.index) ? turn.index + 1 : idx + 1;
      const qNo = String(n).padStart(2, '0');
      sections.push(`
        <section class="qa-section">
          <div class="section-label">QUESTION ${qNo}</div>
          <div class="question-content">${blocksToHtml(turn.question.markdown || turn.question.text)}</div>`);

      const answers = (turn.answers || []).filter(a => a.text || a.markdown);
      answers.forEach((answer, answerIndex) => {
        sections.push(`
          <div class="answer-header">${answers.length > 1 ? `ANSWER ${String(answerIndex + 1).padStart(2, '0')}` : 'ANSWER'}</div>
          <div class="answer-content">${blocksToHtml(answer.markdown || answer.text)}</div>`);
      });
      sections.push('</section>');
    });

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
@page {
  size: ${pageSize};
  margin: 18mm 18mm 18mm 18mm;
  @bottom-left { content: "${APP_NAME}"; font: 8.5pt Arial, sans-serif; color: #6b7280; }
  @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 8.5pt Arial, sans-serif; color: #6b7280; }
}
* { box-sizing: border-box; }
html, body { padding: 0; margin: 0; }
body {
  color: #243142;
  background: #fff;
  font-family: "Aptos", "Segoe UI", "Nirmala UI", "Noto Sans Sinhala", "Noto Sans Tamil", "Malgun Gothic", Arial, sans-serif;
  font-size: 10.5pt;
  line-height: 1.52;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.document { width: 100%; max-width: 174mm; margin: 0 auto; }
.document-header { margin-bottom: 9mm; padding-bottom: 4.5mm; border-bottom: 1.1pt solid #1E3A5F; }
.kicker { font-size: 8pt; font-weight: 700; letter-spacing: .11em; color: #65758B; margin-bottom: 2.5mm; }
h1 { font-size: 23pt; line-height: 1.16; letter-spacing: -.015em; margin: 0; font-weight: 700; color: #183B56; }
.qa-section { padding: 0 0 7mm; margin: 0 0 8mm; border-bottom: .55pt solid #D8E1EB; break-inside: auto; }
.qa-section:last-child { border-bottom: 0; margin-bottom: 0; }
.section-label, .answer-header { font-size: 8.2pt; font-weight: 700; letter-spacing: .09em; color: #5A6B7E; margin: 0 0 2.5mm; text-transform: uppercase; }
.answer-header { margin-top: 6mm; color: #1E3A5F; }
.question-content { background: #F7F9FC; border-left: 2.5pt solid #2E5B88; padding: 3.5mm 4.2mm; margin-bottom: 4.5mm; }
.answer-content { padding-left: .5mm; }
h3 { font-size: 14pt; margin: 5.5mm 0 2.2mm; line-height: 1.24; color: #183B56; border-bottom: .45pt solid #E2E8F0; padding-bottom: 1.4mm; }
h4 { font-size: 12pt; margin: 4.5mm 0 1.8mm; line-height: 1.28; color: #264C70; }
h5, h6 { font-size: 10.8pt; margin: 4mm 0 1.4mm; color: #334E68; }
p { margin: 0 0 3mm; orphans: 3; widows: 3; }
ul, ol { margin: 1.4mm 0 3.5mm 5.5mm; padding-left: 5mm; }
li { margin: 1mm 0; }
blockquote { margin: 3.5mm 0; padding: 2.8mm 4mm; border-left: 2.4pt solid #6B87A3; background: #F8FAFC; color: #405268; }
hr { border: 0; border-top: .6pt solid #d1d5db; margin: 5mm 0; }
.inline-code { font-family: "Cascadia Mono", Consolas, "Courier New", monospace; font-size: 9pt; background: #F1F5F9; padding: .25mm .9mm; border-radius: .8mm; }
.code-wrap { margin: 4mm 0; break-inside: avoid; }
.code-lang { font: 700 7.4pt/1.2 "Cascadia Mono", Consolas, monospace; letter-spacing: .07em; text-transform: uppercase; color: #64748B; margin: 0 0 1.3mm; }
pre { margin: 0; padding: 3.6mm; white-space: pre-wrap; overflow-wrap: anywhere; background: #F4F6F8; border: .5pt solid #D8E1EB; border-radius: 1.5mm; font: 8.6pt/1.45 "Cascadia Mono", Consolas, "Courier New", monospace; color: #243142; }
.diagram-wrap { background: #FBFCFE; border: .55pt solid #D8E1EB; border-radius: 1.5mm; padding: 2mm; }
.diagram-wrap .code-lang { margin: 0 1mm 1.5mm; }
pre.diagram-code { background: #FFFFFF; border: 0; padding: 3mm 2.5mm; white-space: pre; overflow: hidden; overflow-wrap: normal; word-break: normal; font-size: 7.8pt; line-height: 1.36; text-align: left; }
a { color: #1E5A8A; text-decoration: underline; text-underline-offset: 1px; }
.table-wrap { margin: 4mm 0; overflow: hidden; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 9pt; }
th, td { border: .55pt solid #cbd5e1; padding: 2.1mm 2.4mm; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
th { background: #EEF3F8; font-weight: 700; color: #183B56; }
.media { margin: 4mm 0; text-align: center; break-inside: avoid; }
.media img { display: block; max-width: 100%; max-height: 235mm; width: auto; height: auto; object-fit: contain; margin: 0 auto; }
.math-inline { display: inline-flex; align-items: baseline; vertical-align: baseline; font-family: "Cambria Math", "STIX Two Math", "Times New Roman", serif; }
.math-inline math { font-size: 1.08em; }
.math-display { margin: 4mm 0; padding: 3.5mm 4mm; display: flex; justify-content: center; align-items: center; overflow-x: auto; overflow-y: hidden; font-family: "Cambria Math", "STIX Two Math", "Times New Roman", serif; font-size: 11.2pt; background: #FBFCFD; border: .5pt solid #D8E1EB; break-inside: avoid; }
.math-display math { font-size: 1.12em; max-width: 100%; }
.math-fallback { white-space: pre-wrap; }
</style>
</head>
<body>
<main class="document">
  <header class="document-header">
    <div class="kicker">CONVERSATION DOCUMENT</div>
    <h1>${escapeHtml(title)}</h1>

  </header>
  ${sections.join('')}

</main>
</body>
</html>`;
  }

  function pdfTextNode(text, extra = {}) {
    const value = String(text || '');
    if (/[^\u0000-\u024F\u2000-\u206F\u2190-\u22FF]/u.test(value) || /\$|\\\(|\\\[|\\frac|\\sqrt|\\sum|\\int/.test(value)) {
      return { cgxRasterText: value, ...extra };
    }
    return { text: value, ...extra };
  }

  function buildPdfDefinition(data, turns, options = {}) {
    const pageSize = normalizePageSize(options.pageSize || 'A4');
    const title = documentTitle(data, turns);
    const content = [{ text: title, style: 'title', margin: [0, 0, 0, 16] }];

    const pushBlocks = markdown => {
      for (const block of parseMarkdownBlocks(markdown)) {
        if (block.type === 'blank') continue;
        if (block.type === 'heading') {
          content.push(pdfTextNode(block.text, { style: block.level <= 2 ? 'h2' : 'h3', margin: [0, 8, 0, 5] }));
        } else if (block.type === 'text') {
          content.push(pdfTextNode(block.text, { margin: [0, 0, 0, 7], lineHeight: 1.28 }));
        } else if (block.type === 'quote') {
          content.push(pdfTextNode(block.text, { margin: [10, 4, 8, 8], color: '#405268', background: '#F8FAFC' }));
        } else if (block.type === 'rule') {
          content.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 480, y2: 0, lineWidth: 0.5, lineColor: '#D1D5DB' }], margin: [0, 5, 0, 8] });
        } else if (block.type === 'code') {
          content.push({ text: block.text || '', fontSize: 8.5, lineHeight: 1.2, background: '#F4F6F8', margin: [7, 6, 7, 8] });
        } else if (block.type === 'list') {
          const item = pdfTextNode(block.text);
          content.push(block.ordered
            ? { ol: [item], start: block.marker || 1, margin: [15, 0, 0, 5] }
            : { ul: [item], margin: [15, 0, 0, 5] });
        } else if (block.type === 'table') {
          const rows = block.rows.map((row, rowIndex) => row.map(cell => pdfTextNode(cell, {
            bold: rowIndex === 0,
            fillColor: rowIndex === 0 ? '#EEF3F8' : undefined,
            margin: [3, 3, 3, 3]
          })));
          content.push({
            table: { headerRows: 1, widths: Array(block.rows[0]?.length || 1).fill('*'), body: rows },
            layout: 'lightHorizontalLines',
            fontSize: 8.5,
            margin: [0, 4, 0, 9]
          });
        }
      }
    };

    turns.forEach((turn, idx) => {
      const n = Number.isFinite(turn.index) ? turn.index + 1 : idx + 1;
      content.push({ text: 'QUESTION ' + String(n).padStart(2, '0'), style: 'label', margin: [0, 8, 0, 5] });

      const qStart = content.length;
      pushBlocks(turn.question.markdown || turn.question.text || '');
      const qBlocks = content.splice(qStart);
      content.push({
        table: { widths: [3, '*'], body: [[{ text: '', fillColor: '#2E5B88' }, { stack: qBlocks, margin: [9, 7, 8, 3], fillColor: '#F7F9FC' }]] },
        layout: 'noBorders',
        margin: [0, 0, 0, 10]
      });

      const answers = (turn.answers || []).filter(a => a.text || a.markdown);
      answers.forEach((answer, answerIndex) => {
        content.push({
          text: answers.length > 1 ? 'ANSWER ' + String(answerIndex + 1).padStart(2, '0') : 'ANSWER',
          style: 'answerLabel',
          margin: [0, 5, 0, 5]
        });
        pushBlocks(answer.markdown || answer.text || '');
      });

      if (idx < turns.length - 1) {
        content.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 480, y2: 0, lineWidth: 0.45, lineColor: '#D8E1EB' }], margin: [0, 8, 0, 10] });
      }
    });

    return {
      pageSize,
      pageMargins: [51, 51, 51, 55],
      info: { title, subject: 'ChatGPT conversation export', creator: APP_NAME },
      defaultStyle: { font: 'Roboto', fontSize: 10.5, color: '#243142', lineHeight: 1.24 },
      styles: {
        title: { fontSize: 23, bold: true, color: '#183B56' },
        h2: { fontSize: 14, bold: true, color: '#183B56' },
        h3: { fontSize: 12, bold: true, color: '#264C70' },
        label: { fontSize: 8.2, bold: true, color: '#5A6B7E', characterSpacing: 0.8 },
        answerLabel: { fontSize: 8.2, bold: true, color: '#1E3A5F', characterSpacing: 0.8 }
      },
      content
    };
  }

  async function exportPdf(data, turns, options = {}) {
    const pageSize = normalizePageSize(options.pageSize || 'A4');
    const definition = buildPdfDefinition(data, turns, { ...options, pageSize });
    const filename = safeFilename(data?.title || 'ChatGPT Conversation');

    if (!globalThis.chrome?.runtime?.sendMessage) {
      throw new Error('PDF export is only available inside the Chrome extension.');
    }

    const timeoutMs = Math.max(30000, Number(options.timeoutMs || 60000));
    let timeoutId;

    const response = await Promise.race([
      chrome.runtime.sendMessage({
        type: 'CGX_EXPORT_PDF',
        definition,
        filename,
        pageSize
      }),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('PDF generation timed out. Please try again.')), timeoutMs);
      })
    ]).finally(() => clearTimeout(timeoutId));

    if (!response?.ok) throw new Error(response?.error || 'PDF generation failed.');
    return response;
  }

  // ---------------- DOCX / OOXML ----------------

  let crcTable;
  function makeCrcTable() {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  }

  function crc32(bytes) {
    crcTable ||= makeCrcTable();
    let c = 0xFFFFFFFF;
    for (const b of bytes) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  const u16 = n => new Uint8Array([n & 255, (n >>> 8) & 255]);
  const u32 = n => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);

  function concatBytes(parts) {
    const length = parts.reduce((sum, p) => sum + p.length, 0);
    const out = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    return out;
  }

  function dosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    const time = ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() / 2) & 31);
    const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, day };
  }

  function zipStore(files) {
    const enc = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    const { time, day } = dosDateTime();

    for (const file of files) {
      const name = enc.encode(file.name);
      const data = typeof file.data === 'string' ? enc.encode(file.data) : file.data;
      const crc = crc32(data);
      const local = concatBytes([
        u32(0x04034B50), u16(20), u16(0x0800), u16(0), u16(time), u16(day),
        u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data
      ]);
      localParts.push(local);

      const central = concatBytes([
        u32(0x02014B50), u16(20), u16(20), u16(0x0800), u16(0), u16(time), u16(day),
        u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0),
        u16(0), u16(0), u32(0), u32(offset), name
      ]);
      centralParts.push(central);
      offset += local.length;
    }

    const central = concatBytes(centralParts);
    const locals = concatBytes(localParts);
    const end = concatBytes([
      u32(0x06054B50), u16(0), u16(0), u16(files.length), u16(files.length),
      u32(central.length), u32(locals.length), u16(0)
    ]);
    return concatBytes([locals, central, end]);
  }

  function wordRun(text, opts = {}) {
    const preserve = /^\s|\s$|\n/.test(text) ? ' xml:space="preserve"' : '';
    const props = [
      opts.bold ? '<w:b/>' : '',
      opts.italic ? '<w:i/>' : '',
      opts.underline ? '<w:u w:val="single"/>' : '',
      opts.color ? `<w:color w:val="${opts.color}"/>` : '',
      opts.size ? `<w:sz w:val="${opts.size}"/><w:szCs w:val="${opts.size}"/>` : '',
      opts.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F4F6F8"/>' : ''
    ].join('');
    const parts = String(text).split('\n');
    const content = parts.map((part, index) => `${index ? '<w:br/>' : ''}<w:t${preserve}>${xmlEscape(part)}</w:t>`).join('');
    return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}${content}</w:r>`;
  }

  function parseInlineTokens(text) {
    const source = String(text || '');
    const tokens = [];
    const re = /(!\[[^\]]*\]\((?:https?:\/\/[^)]+|data:image\/[^)]+)\)|\\\[[\s\S]*?\\\]|\$\$[\s\S]*?\$\$|\\\([^\n]*?\\\)|\$[^$\n]+\$|\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\(https?:\/\/[^)]+\))/g;
    let last = 0;
    let match;
    while ((match = re.exec(source))) {
      if (match.index > last) tokens.push({ type: 'text', text: source.slice(last, match.index) });
      const value = match[0];
      if (value.startsWith('![')) {
        const m = value.match(/^!\[([^\]]*)\]\((https?:\/\/[^)]+|data:image\/[^)]+)\)$/);
        tokens.push({ type: 'image', alt: m?.[1] || 'Image', src: m?.[2] || '' });
      } else if (value.startsWith('\\[')) tokens.push({ type: 'math', text: value.slice(2, -2).trim(), display: true });
      else if (value.charCodeAt(0) === 36 && value.charCodeAt(1) === 36) tokens.push({ type: 'math', text: value.slice(2, -2).trim(), display: true });
      else if (value.startsWith('\\(')) tokens.push({ type: 'math', text: value.slice(2, -2).trim(), display: false });
      else if (value.charCodeAt(0) === 36) tokens.push({ type: 'math', text: value.slice(1, -1).trim(), display: false });
      else if (value.startsWith('**')) tokens.push({ type: 'bold', text: value.slice(2, -2) });
      else if (value.startsWith('__')) tokens.push({ type: 'bold', text: value.slice(2, -2) });
      else if (value.startsWith('`')) tokens.push({ type: 'code', text: value.slice(1, -1) });
      else if (value.startsWith('[')) {
        const m = value.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/);
        tokens.push({ type: 'link', text: m?.[1] || value, href: m?.[2] || '' });
      } else tokens.push({ type: 'italic', text: value.slice(1, -1) });
      last = re.lastIndex;
    }
    if (last < source.length) tokens.push({ type: 'text', text: source.slice(last) });
    return tokens;
  }

  async function fetchDocxImageAssets(turns) {
    const found = new Map();
    const imageRe = /!\[([^\]]*)\]\((https?:\/\/[^)]+|data:image\/[^)]+)\)/g;
    for (const turn of turns) {
      const messages = [turn.question].concat(turn.answers || []);
      for (const message of messages) {
        const source = String(message?.markdown || '');
        let match;
        imageRe.lastIndex = 0;
        while ((match = imageRe.exec(source))) {
          const src = match[2];
          const alt = match[1] || 'Image';
          if (!found.has(src) && shouldIncludeImage({ src, alt, width: 800, height: 500 })) found.set(src, { src, alt });
        }
      }
    }
    const assets = [];
    for (const item of found.values()) {
      try {
        const response = await fetch(item.src, { credentials: 'omit', referrerPolicy: 'no-referrer' });
        if (!response.ok) continue;
        let blob = await response.blob();
        let type = String(blob.type || '').toLowerCase();
        let width = 1000;
        let height = 625;

        if (type.includes('svg')) {
          try {
            const bitmap = await createImageBitmap(blob);
            width = bitmap.width || width;
            height = bitmap.height || height;
            const canvas = document.createElement('canvas');
            const maxWidth = 1800;
            const scale = Math.min(1, maxWidth / Math.max(1, width));
            canvas.width = Math.max(1, Math.round(width * scale));
            canvas.height = Math.max(1, Math.round(height * scale));
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            bitmap.close?.();
            blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png', 1));
            if (!blob) continue;
            type = 'image/png';
            width = canvas.width;
            height = canvas.height;
          } catch {
            continue;
          }
        } else {
          try {
            const bitmap = await createImageBitmap(blob);
            width = bitmap.width || width;
            height = bitmap.height || height;
            bitmap.close?.();
          } catch {}
        }

        const ext = type.includes('png') ? 'png' : (type.includes('jpeg') || type.includes('jpg')) ? 'jpg' : type.includes('gif') ? 'gif' : type.includes('webp') ? 'webp' : '';
        if (!ext) continue;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (!bytes.length) continue;
        assets.push({ src: item.src, alt: item.alt, bytes, ext, name: 'image' + (assets.length + 1) + '.' + ext, width, height });
      } catch {}
    }
    return assets;
  }
  async function createDocxBlob(data, turns, options = {}) {
    const title = documentTitle(data, turns);
    const page = PAGE_SIZES[normalizePageSize(options.pageSize)];
    const hyperlinkRels = [];
    const imageRels = [];
    const numberingDefinitions = [];
    const imageAssets = await fetchDocxImageAssets(turns);
    const imageMap = new Map(imageAssets.map(asset => [asset.src, asset]));
    let hyperlinkId = 10;
    let numberingId = 1;

    function imageDrawing(token) {
      const asset = imageMap.get(token.src);
      if (!asset) {
        const id = 'rId' + hyperlinkId++;
        hyperlinkRels.push('<Relationship Id="' + id + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="' + xmlEscape(token.src) + '" TargetMode="External"/>');
        return '<w:hyperlink r:id="' + id + '">' + wordRun(token.alt || 'Image', { color: '0563C1', underline: true }) + '</w:hyperlink>';
      }
      if (!asset.relId) {
        asset.relId = 'rId' + hyperlinkId++;
        imageRels.push('<Relationship Id="' + asset.relId + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/' + asset.name + '"/>');
      }
      const cx = Math.round(5.8 * 914400);
      const cy = Math.max(1, Math.round(cx * (asset.height / Math.max(1, asset.width))));
      const docPrId = 100 + imageAssets.indexOf(asset);
      return '<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0"><wp:extent cx="' + cx + '" cy="' + cy + '"/><wp:docPr id="' + docPrId + '" name="' + xmlEscape(asset.name) + '" descr="' + xmlEscape(token.alt || 'Image') + '"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="' + xmlEscape(asset.name) + '"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="' + asset.relId + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
    }
    function inlineWordXml(text, base = {}) {
      return parseInlineTokens(text).map(token => {
        if (token.type === 'image' && token.src) return imageDrawing(token);
        if (token.type === 'math') return mathRenderer?.toOmml ? mathRenderer.toOmml(token.text) : wordRun(token.text, { ...base, code: false });
        if (token.type === 'bold') return wordRun(token.text, { ...base, bold: true });
        if (token.type === 'italic') return wordRun(token.text, { ...base, italic: true });
        if (token.type === 'code') return wordRun(token.text, { ...base, code: true });
        if (token.type === 'link' && token.href) {
          const id = `rId${hyperlinkId++}`;
          hyperlinkRels.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEscape(token.href)}" TargetMode="External"/>`);
          return `<w:hyperlink r:id="${id}">${wordRun(token.text, { ...base, color: '0563C1', underline: true })}</w:hyperlink>`;
        }
        return wordRun(token.text, base);
      }).join('');
    }

    function paragraph(content = '', opts = {}) {
      const pPr = [
        opts.style ? `<w:pStyle w:val="${opts.style}"/>` : '',
        opts.align ? `<w:jc w:val="${opts.align}"/>` : '',
        opts.before || opts.after ? `<w:spacing w:before="${opts.before || 0}" w:after="${opts.after || 0}" w:line="${opts.line || 300}" w:lineRule="auto"/>` : '',
        opts.keepNext ? '<w:keepNext/>' : '',
        opts.indent ? `<w:ind w:left="${opts.indent}"/>` : '',
        opts.borderLeft ? `<w:pBdr><w:left w:val="single" w:sz="${opts.borderLeft.size || 18}" w:space="8" w:color="${opts.borderLeft.color || '64748B'}"/></w:pBdr>` : '',
        opts.shading ? `<w:shd w:val="clear" w:color="auto" w:fill="${opts.shading}"/>` : '',
        opts.numId ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${opts.numId}"/></w:numPr>` : ''
      ].join('');
      const body = opts.raw ? content : inlineWordXml(content, opts.run || {});
      return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${body}</w:p>`;
    }

    function codeParagraph(text, lang) {
      const label = lang ? paragraph(lang.toUpperCase(), { style: 'CodeLabel', keepNext: true }) : '';
      const code = paragraph('', {
        raw: true, shading: 'F3F4F6', borderLeft: { color: 'CBD5E1', size: 8 },
        before: 0, after: 160
      });
      const runs = String(text || '').split('\n').map((line, idx) => `${idx ? '<w:br/>' : ''}${wordRun(line || ' ', { code: true, size: 18 })}`).join('');
      return label + code.replace('</w:p>', `${runs}</w:p>`);
    }

    function wordTable(rows, opts = {}) {
      if (!rows?.length) return '';
      const cols = Math.max(...rows.map(r => r.length));
      const totalWidth = opts.width || 9360;
      const colWidth = Math.floor(totalWidth / Math.max(1, cols));
      const grid = Array(cols).fill(`<w:gridCol w:w="${colWidth}"/>`).join('');
      const tableRows = rows.map((row, rIdx) => {
        const cells = [...row, ...Array(Math.max(0, cols - row.length)).fill('')];
        return `<w:tr>${cells.map(cell => `<w:tc><w:tcPr><w:tcW w:w="${colWidth}" w:type="dxa"/>${rIdx === 0 && opts.header !== false ? '<w:shd w:val="clear" w:color="auto" w:fill="EEF3F8"/>' : ''}<w:tcMar><w:top w:w="80" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tcMar></w:tcPr>${paragraph(String(cell), { after: 0, run: rIdx === 0 && opts.header !== false ? { bold: true } : {} })}</w:tc>`).join('')}</w:tr>`;
      }).join('');
      return `<w:tbl><w:tblPr><w:tblW w:w="${totalWidth}" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="CBD5E1"/><w:left w:val="single" w:sz="4" w:color="CBD5E1"/><w:bottom w:val="single" w:sz="4" w:color="CBD5E1"/><w:right w:val="single" w:sz="4" w:color="CBD5E1"/><w:insideH w:val="single" w:sz="4" w:color="CBD5E1"/><w:insideV w:val="single" w:sz="4" w:color="CBD5E1"/></w:tblBorders></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${tableRows}</w:tbl>`;
    }

    function markdownToWordXml(markdown) {
      const parts = [];
      for (const block of parseMarkdownBlocks(markdown)) {
        if (block.type === 'blank') continue;
        if (block.type === 'heading') {
          const style = block.level <= 1 ? 'Heading2' : block.level === 2 ? 'Heading3' : 'Heading4';
          parts.push(paragraph(block.text, { style, keepNext: true }));
        } else if (block.type === 'text') {
          const trimmed = String(block.text || '').trim();
          const displayMatch = trimmed.match(/^\$\$([\s\S]*)\$\$/) || trimmed.match(/^\\\[([\s\S]*)\\\]$/);
          if (displayMatch && mathRenderer?.toOmmlParagraph) parts.push(mathRenderer.toOmmlParagraph(displayMatch[1].trim()));
          else parts.push(paragraph(block.text, { after: 150, line: 300 }));
        } else if (block.type === 'quote') {
          parts.push(paragraph(block.text, { after: 160, indent: 360, shading: 'F8FAFC', borderLeft: { color: '94A3B8', size: 16 } }));
        } else if (block.type === 'list') {
          const id = numberingId++;
          numberingDefinitions.push({ id, ordered: block.ordered, start: Number(block.marker || 1) || 1 });
          parts.push(paragraph(inlineWordXml(block.text), { raw: true, after: 70, numId: id }));
        } else if (block.type === 'rule') {
          parts.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="6" w:color="D1D5DB"/></w:pBdr><w:spacing w:before="100" w:after="100"/></w:pPr></w:p>');
        } else if (block.type === 'code') {
          parts.push(codeParagraph(block.text, block.lang));
        } else if (block.type === 'table') {
          parts.push(wordTable(block.rows));
          parts.push(paragraph(' ', { after: 80 }));
        }
      }
      return parts.join('');
    }

    function boxedContentXml(contentXml) {
      return `<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblBorders><w:left w:val="single" w:sz="20" w:color="2E5B88"/><w:top w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="9360"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="9360" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="F7F9FC"/><w:tcMar><w:top w:w="150" w:type="dxa"/><w:left w:w="180" w:type="dxa"/><w:bottom w:w="120" w:type="dxa"/><w:right w:w="180" w:type="dxa"/></w:tcMar></w:tcPr>${contentXml || paragraph(' ')}</w:tc></w:tr></w:tbl>`;
    }

    const body = [];
    body.push(paragraph('CONVERSATION DOCUMENT', { style: 'Kicker', keepNext: true }));
    body.push(paragraph(title, { style: 'Title', keepNext: true }));

    turns.forEach((turn, idx) => {
      const n = Number.isFinite(turn.index) ? turn.index + 1 : idx + 1;
      body.push(paragraph(`QUESTION ${String(n).padStart(2, '0')}`, { style: 'SectionLabel', keepNext: true }));
      body.push(boxedContentXml(markdownToWordXml(turn.question.markdown || turn.question.text)));

      const answers = (turn.answers || []).filter(a => a.text || a.markdown);
      answers.forEach((answer, answerIndex) => {
        body.push(paragraph(answers.length > 1 ? `ANSWER ${String(answerIndex + 1).padStart(2, '0')}` : 'ANSWER', { style: 'AnswerLabel', keepNext: true, before: 180 }));
        body.push(markdownToWordXml(answer.markdown || answer.text));
      });

      if (idx < turns.length - 1) {
        body.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="8" w:color="D1D5DB"/></w:pBdr><w:spacing w:before="160" w:after="220"/></w:pPr></w:p>');
      }
    });

    const sectPr = `<w:sectPr>
      <w:headerReference w:type="default" r:id="rId2"/>
      <w:footerReference w:type="default" r:id="rId3"/>
      <w:pgSz w:w="${page.width}" w:h="${page.height}"/>
      <w:pgMar w:top="1077" w:right="964" w:bottom="1077" w:left="964" w:header="425" w:footer="425" w:gutter="0"/>
    </w:sectPr>`;

    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
<w:body>${body.join('')}${sectPr}</w:body></w:document>`;

    const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="Malgun Gothic" w:cs="Nirmala UI"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="Malgun Gothic" w:cs="Nirmala UI"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:color w:val="243142"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="40" w:after="260"/><w:keepNext/></w:pPr><w:rPr><w:b/><w:sz w:val="42"/><w:szCs w:val="42"/><w:color w:val="183B56"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Kicker"><w:name w:val="Kicker"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="90"/><w:keepNext/></w:pPr><w:rPr><w:b/><w:sz w:val="17"/><w:szCs w:val="17"/><w:color w:val="64748B"/><w:spacing w:val="20"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="SectionLabel"><w:name w:val="Section Label"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="160" w:after="100"/><w:keepNext/></w:pPr><w:rPr><w:b/><w:sz w:val="17"/><w:szCs w:val="17"/><w:color w:val="5A6B7E"/><w:spacing w:val="16"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="AnswerLabel"><w:name w:val="Answer Label"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="220" w:after="100"/><w:keepNext/></w:pPr><w:rPr><w:b/><w:sz w:val="17"/><w:szCs w:val="17"/><w:color w:val="1E3A5F"/><w:spacing w:val="16"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="Heading 2"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="220" w:after="100"/><w:keepNext/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/><w:color w:val="243142"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="Heading 3"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="180" w:after="90"/><w:keepNext/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/><w:szCs w:val="24"/><w:color w:val="243142"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="Heading 4"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="150" w:after="80"/><w:keepNext/></w:pPr><w:rPr><w:b/><w:sz w:val="22"/><w:szCs w:val="22"/><w:color w:val="243142"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="CodeLabel"><w:name w:val="Code Label"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="100" w:after="50"/><w:keepNext/></w:pPr><w:rPr><w:b/><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="15"/><w:szCs w:val="15"/><w:color w:val="64748B"/></w:rPr></w:style>
</w:styles>`;

    const headerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="4" w:color="D1D5DB"/></w:pBdr><w:spacing w:after="60"/></w:pPr>${wordRun(APP_NAME.toUpperCase(), { bold: true, size: 15, color: '6B7280' })}</w:p></w:hdr>`;

    const footerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="right"/><w:pBdr><w:top w:val="single" w:sz="4" w:space="4" w:color="E5E7EB"/></w:pBdr><w:spacing w:before="60"/></w:pPr>${wordRun('Page ', { size: 16, color: '6B7280' })}<w:fldSimple w:instr="PAGE">${wordRun('1', { size: 16, color: '6B7280' })}</w:fldSimple>${wordRun(' of ', { size: 16, color: '6B7280' })}<w:fldSimple w:instr="NUMPAGES">${wordRun('1', { size: 16, color: '6B7280' })}</w:fldSimple></w:p></w:ftr>`;

    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Default Extension="gif" ContentType="image/gif"/>
  <Default Extension="webp" ContentType="image/webp"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
  <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

    const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

    const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
  <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
  ${hyperlinkRels.join('\n  ')}
  ${imageRels.join('\n  ')}
</Relationships>`;

    const settingsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:updateFields w:val="true"/><w:defaultTabStop w:val="720"/></w:settings>`;

    const numberingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${numberingDefinitions.map(def => `<w:abstractNum w:abstractNumId="${def.id}"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="${def.start}"/><w:numFmt w:val="${def.ordered ? 'decimal' : 'bullet'}"/><w:lvlText w:val="${def.ordered ? '%1.' : '•'}"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="720"/></w:tabs><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="${def.id}"><w:abstractNumId w:val="${def.id}"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="${def.start}"/></w:lvlOverride></w:num>`).join('')}</w:numbering>`;

    const now = new Date().toISOString();
    const coreXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${xmlEscape(title)}</dc:title>
  <dc:subject>ChatGPT conversation export</dc:subject>
  <dc:creator>${APP_NAME}</dc:creator>
  <dc:description>Exported locally from ${xmlEscape(data.url || '')}</dc:description>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;

    const bytes = zipStore([
      { name: '[Content_Types].xml', data: contentTypes },
      { name: '_rels/.rels', data: rootRels },
      { name: 'docProps/core.xml', data: coreXml },
      { name: 'word/document.xml', data: documentXml },
      { name: 'word/styles.xml', data: stylesXml },
      { name: 'word/numbering.xml', data: numberingXml },
      { name: 'word/header1.xml', data: headerXml },
      { name: 'word/footer1.xml', data: footerXml },
      { name: 'word/settings.xml', data: settingsXml },
      { name: 'word/_rels/document.xml.rels', data: documentRels },
      ...imageAssets.map(asset => ({ name: 'word/media/' + asset.name, data: asset.bytes }))
    ]);

    return new Blob([bytes], { type: MIME_DOCX });
  }

  function exportMarkdown(data, turns) {
    const blob = new Blob([createMarkdown(data, turns)], { type: 'text/markdown;charset=utf-8' });
    downloadBlob(blob, exportFilename(data, turns, 'md'));
  }

  async function exportDocx(data, turns, options = {}) {
    downloadBlob(await createDocxBlob(data, turns, options), exportFilename(data, turns, 'docx'));
  }

  globalThis.ChatGPTExporter = Object.freeze({
    normalizeText,
    normalizePageSize,
    shouldIncludeImage,
    PAGE_SIZES,
    safeFilename,
    exportFilename,
    createMarkdown,
    createDocxBlob,
    buildPrintHtml,
    buildPdfDefinition,
    exportMarkdown,
    exportDocx,
    exportPdf,
    downloadBlob
  });
})();
