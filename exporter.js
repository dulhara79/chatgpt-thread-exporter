(() => {
  'use strict';

  const APP_NAME = 'ChatGPT Thread Exporter';
  const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

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
      return `${data.title} â€” Q&A ${turns[0].index + 1}`;
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
    const lines = [
      `# ${title}`,
      '',
      '**Document type:** ChatGPT Conversation Export  ',
      `**Source:** ${data.url || ''}  `,
      `**Exported:** ${formatDate(new Date())}  `,
      `**Scope:** ${turns.length === 1 ? 'Single question and answer' : `Complete conversation (${turns.length} Q&A turns)`}`,
      '',
      '---',
      ''
    ];

    turns.forEach((turn, idx) => {
      const n = Number.isFinite(turn.index) ? turn.index + 1 : idx + 1;
      lines.push(`## Question ${String(n).padStart(2, '0')}`, '', turn.question.markdown || turn.question.text || '', '');
      const answers = (turn.answers || []).filter(a => a.text || a.markdown);
      answers.forEach((answer, answerIndex) => {
        lines.push(answers.length > 1 ? `## Answer ${String(answerIndex + 1).padStart(2, '0')}` : '## Answer', '', answer.markdown || answer.text || '', '');
      });
      if (idx < turns.length - 1) lines.push('---', '');
    });

    lines.push('---', '', `*Generated locally by ${APP_NAME}.*`, '');
    return lines.join('\n').trimEnd() + '\n';
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
        blocks.push({ type: 'list', ordered: true, marker: ordered[1], text: ordered[2] });
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
      .replace(/`([^`]+)`/g, (_, code) => stash(`<code class="inline-code">${escapeHtml(code)}</code>`))
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_, label, href) => stash(`<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`));

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
        html.push(`<div class="code-wrap">${block.lang ? `<div class="code-lang">${escapeHtml(block.lang)}</div>` : ''}<pre><code>${escapeHtml(block.text)}</code></pre></div>`);
      } else if (block.type === 'list') {
        const wanted = block.ordered ? 'ol' : 'ul';
        if (listType !== wanted) {
          closeList();
          html.push(wanted === 'ol' ? '<ol>' : '<ul>');
          listType = wanted;
        }
        html.push(`<li>${inlineToHtml(block.text)}</li>`);
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

  function buildPrintHtml(data, turns) {
    const title = documentTitle(data, turns);
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

    const scope = turns.length === 1 ? 'Single question and answer' : `Complete conversation Â· ${turns.length} Q&A turns`;
    const exported = formatDate(new Date());

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
@page {
  size: A4;
  margin: 19mm 17mm 19mm 17mm;
  @bottom-left { content: "${APP_NAME}"; font: 8.5pt Arial, sans-serif; color: #6b7280; }
  @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 8.5pt Arial, sans-serif; color: #6b7280; }
}
* { box-sizing: border-box; }
html, body { padding: 0; margin: 0; }
body {
  color: #111827;
  background: #fff;
  font-family: "Aptos", "Segoe UI", Arial, "Noto Sans", "Noto Sans Sinhala", sans-serif;
  font-size: 10.5pt;
  line-height: 1.55;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.document { max-width: 178mm; margin: 0 auto; }
.document-header { margin-bottom: 11mm; padding-bottom: 5mm; border-bottom: 1.2pt solid #111827; }
.kicker { font-size: 8.5pt; font-weight: 700; letter-spacing: .12em; color: #4b5563; margin-bottom: 3mm; }
h1 { font-size: 22pt; line-height: 1.18; letter-spacing: -.02em; margin: 0 0 5mm; font-weight: 700; color: #111827; }
.meta-grid { width: 100%; border-collapse: collapse; font-size: 8.8pt; color: #4b5563; }
.meta-grid th { text-align: left; width: 23mm; padding: 1.1mm 3mm 1.1mm 0; color: #111827; font-weight: 650; vertical-align: top; }
.meta-grid td { padding: 1.1mm 0; overflow-wrap: anywhere; vertical-align: top; }
.qa-section { padding: 0 0 8mm; margin: 0 0 9mm; border-bottom: .6pt solid #d1d5db; break-inside: auto; }
.qa-section:last-child { border-bottom: 0; margin-bottom: 0; }
.section-label, .answer-header { font-size: 8.5pt; font-weight: 750; letter-spacing: .10em; color: #374151; margin: 0 0 3mm; }
.answer-header { margin-top: 7mm; color: #065f46; }
.question-content { background: #f8fafc; border-left: 3pt solid #64748b; padding: 4mm 4.5mm; margin-bottom: 5mm; }
.answer-content { padding-left: .5mm; }
h3 { font-size: 14pt; margin: 6mm 0 2.5mm; line-height: 1.25; color: #111827; }
h4 { font-size: 12pt; margin: 5mm 0 2mm; line-height: 1.3; color: #111827; }
h5, h6 { font-size: 10.5pt; margin: 4mm 0 1.5mm; color: #111827; }
p { margin: 0 0 3.2mm; orphans: 3; widows: 3; }
ul, ol { margin: 1.5mm 0 4mm 6mm; padding-left: 5mm; }
li { margin: 1mm 0; }
blockquote { margin: 3.5mm 0; padding: 2.5mm 4mm; border-left: 2.5pt solid #9ca3af; background: #f9fafb; color: #374151; }
hr { border: 0; border-top: .6pt solid #d1d5db; margin: 5mm 0; }
.inline-code { font-family: Consolas, "SFMono-Regular", monospace; font-size: 9.2pt; background: #f3f4f6; padding: .3mm 1mm; border-radius: 1mm; }
.code-wrap { margin: 4mm 0; break-inside: avoid; }
.code-lang { font: 700 7.5pt/1.2 Consolas, monospace; letter-spacing: .08em; text-transform: uppercase; color: #4b5563; margin: 0 0 1.5mm; }
pre { margin: 0; padding: 4mm; white-space: pre-wrap; overflow-wrap: anywhere; background: #f3f4f6; border: .5pt solid #d1d5db; border-radius: 2mm; font: 8.7pt/1.48 Consolas, "Courier New", monospace; }
a { color: #1d4ed8; text-decoration: underline; text-underline-offset: 1px; }
.table-wrap { margin: 4mm 0; overflow: hidden; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 9pt; }
th, td { border: .55pt solid #cbd5e1; padding: 2.1mm 2.4mm; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
th { background: #f1f5f9; font-weight: 700; color: #111827; }
.document-end { margin-top: 10mm; padding-top: 3mm; border-top: .6pt solid #d1d5db; font-size: 8pt; color: #6b7280; }
@media print { .document-end { display: none; } }
</style>
</head>
<body>
<main class="document">
  <header class="document-header">
    <div class="kicker">CHATGPT CONVERSATION EXPORT</div>
    <h1>${escapeHtml(title)}</h1>
    <table class="meta-grid" role="presentation">
      <tr><th>Scope</th><td>${escapeHtml(scope)}</td></tr>
      <tr><th>Source</th><td>${escapeHtml(data.url || '')}</td></tr>
      <tr><th>Exported</th><td>${escapeHtml(exported)}</td></tr>
    </table>
  </header>
  ${sections.join('')}
  <div class="document-end">Generated locally by ${APP_NAME}. Conversation content is reproduced from the currently open ChatGPT thread.</div>
</main>
</body>
</html>`;
  }

  function exportPdf(data, turns) {
    const html = buildPrintHtml(data, turns);
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, '_blank');
    if (!win) {
      URL.revokeObjectURL(url);
      throw new Error('The browser blocked the print window. Allow pop-ups for ChatGPT and try again.');
    }
    const cleanup = () => setTimeout(() => URL.revokeObjectURL(url), 15000);
    win.addEventListener('load', () => {
      setTimeout(() => {
        try { win.focus(); win.print(); } finally { cleanup(); }
      }, 250);
    }, { once: true });
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
    return (c ^ 0xFFFFFFF) >>> 0;
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
      opts.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/>' : ''
    ].join('');
    const parts = String(text).split('\n');
    const content = parts.map((part, index) => `${index ? '<w:br/>' : ''}<w:t${preserve}>${xmlEscape(part)}</w:t>`).join('');
    return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}${content}</w:r>`;
  }

  function parseInlineTokens(text) {
    const source = String(text || '');
    const tokens = [];
    const re = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\(https?:\/\/[^)]+\))/g;
    let last = 0;
    let match;
    while ((match = re.exec(source))) {
      if (match.index > last) tokens.push({ type: 'text', text: source.slice(last, match.index) });
      const value = match[0];
      if (value.startsWith('**')) tokens.push({ type: 'bold', text: value.slice(2, -2) });
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

  function createDocxBlob(data, turns) {
    const title = documentTitle(data, turns);
    const hyperlinkRels = [];
    let hyperlinkId = 10;

    function inlineWordXml(text, base = {}) {
      return parseInlineTokens(text).map(token => {
        if (token.type === 'bold') return wordRun(token.text, { ...base, bold: true });
        if (token.type === 'italic') return wordRun(token.text, { ...base, italic: true });
        if (token.type === 'code') return wordRun(token.text, { ...base, code: true });
        if (token.type === 'link' && token.href) {
          const id = `rid${hyperlinkId++}`;
          hyperlinkRels.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEscape(token.href)}" TargetMode="External"/>`);
          return `<w:hyperlink r:id="${id}">${wordRun(token.text, { ...base, color: '0563C1', underline: true })}</w:hyperlink>`;
        }
        return wordRun(token.text, base);
      }).join('');
    }

    function paragraph(content = '', opts = {}) {
      const pPrHHÂˆÜËœİ[HÈÎœİ[HÎ˜[H‰ÛÜËœİ[_H‹Ï˜ˆ	ÉËˆÜË˜[YÛˆÈÎš˜ÈÎ˜[H‰ÛÜË˜[YÛŸH‹Ï˜ˆ	ÉËˆÜË˜™Y›Ü™HÜË˜Y\ˆÈÎœÜXÚ[™ÈÎ˜™Y›Ü™OH‰ÛÜË˜™Y›Ü™HHˆÎ˜Y\H‰ÛÜË˜Y\ˆHˆÎ›[™OH‰ÛÜË›[™HÌHˆÎ›[™T[OH˜]]È‹Ï˜ˆ	ÉËˆÜËšÙY\™^È	ÏÎšÙY\™^Ï‰Èˆ	ÉËˆÜËš[™[ÈÎš[™Î›YH‰ÛÜËš[™[H‹Ï˜ˆ	ÉËˆÜË˜›Ü™\“YÈÎœ™Î›YÎ˜[HœÚ[™ÛHˆÎœŞH‰ÛÜË˜›Ü™\“YœÚ^™HNHˆÎœÜXÙOHˆÎ˜ÛÛÜH‰ÛÜË˜›Ü™\“Y˜ÛÛÜˆ	ÍÍ‰ßH‹ÏİÎœ™˜ˆ	ÉËˆÜËœÚY[™ÈÈÎœÚÎ˜[H˜ÛX\ˆˆÎ˜ÛÛÜH˜]]ÈˆÎ™š[H‰ÛÜËœÚY[™ßH‹Ï˜ˆ	ÉÂˆKš›Ú[Š	ÉÊNÂˆÛÛœİ›ÙHHÜËœ˜]ÈÈÛÛ[ˆ[›[™UÛÜ™[
ÛÛ[ÜËœ[ˆßJNÂˆ™]\›ˆÎœ‰ÜˆÈÎœ‰ÜŸOİÎœ˜ˆ	ÉßIØ›Ù_OİÎœ˜ÂˆB‚ˆ[˜İ[ÛˆÛÙT\˜YÜ˜\
^[™ÊHÂˆÛÛœİX™[H[™ÈÈ\˜YÜ˜\
[™ËÕ\\Ø\ÙJ
KÈİ[Nˆ	ĞÛÙSX™[	ËÙY\™^ˆYHJHˆ	ÉÎÂˆÛÛœİÛÙHH\˜YÜ˜\
	ÉËÂˆ˜]ÎˆYKÚY[™Îˆ	ÑŒÑ‰Ë›Ü™\“YˆÈÛÛÜˆ	ĞĞ‘QLIËÚ^™NˆKˆ™Y›Ü™NˆY\ˆMŒˆJNÂˆÛÛœİ[œÈHİš[™Ê^	ÉÊKœÜ]
	×‰ÊK›X\

[™KY
HOˆ	ÚYÈ	ÏÎ˜œ‹Ï‰Èˆ	ÉßIİÛÜ™[Š[™H	È	ËÈÛÙNˆYKÚ^™NˆNJ_X
Kš›Ú[Š	ÉÊNÂˆ™]\›ˆX™[
ÈÛÙKœ™\XÙJ	ÏİÎœ‰Ë	Ü[œßOİÎœ˜
NÂˆB‚ˆ[˜İ[ÛˆÛÜ™X›J›İÜËÜÈHßJHÂˆYˆ
\›İÜÏË›[™İ
H™]\›ˆ	ÉÎÂˆÛÛœİÛÛÈHX]›X^
‹‹œ›İÜË›X\
ˆOˆ‹›[™İ
JNÂˆÛÛœİİ[ÚYHÜËÚYLÍŒÂˆÛÛœİÛÛÚYHX]™›ÛÜŠİ[ÚYÈX]›X^
KÛÛÊJNÂˆÛÛœİÜšYH\œ˜^JÛÛÊK™š[
Î™ÜšYÛÛÎÏH‰ØÛÛÚYH‹Ï˜
Kš›Ú[Š	ÉÊNÂˆÛÛœİX›T›İÜÈH›İÜË›X\

›İË’Y
HOˆÂˆÛÛœİÙ[ÈHË‹‹œ›İË‹‹\œ˜^JX]›X^
ÛÛÈH›İË›[™İ
JK™š[
	ÉÊWNÂˆ™]\›ˆÎ‰ØÙ[Ë›X\
Ù[OˆÎÏÎÔÎÕÈÎÏH‰ØÛÛÚYHˆÎ\OH™H‹Ï‰Ü’YOOH	‰ˆÜËšXY\ˆOOH˜[ÙHÈ	ÏÎœÚÎ˜[H˜ÛX\ˆˆÎ˜ÛÛÜH˜]]ÈˆÎ™š[H‘ŒQQH‹Ï‰Èˆ	ÉßOÎÓX\ÎÜÎÏHˆÎ\OH™H‹ÏÎ›YÎÏHŒLˆÎ\OH™H‹ÏÎ˜›İÛHÎÏHˆÎ\OH™H‹ÏÎœšYÚÎÏHŒLˆÎ\OH™H‹ÏİÎÓX\İÎÔ‰Ü\˜YÜ˜\
İš[™ÊÙ[
KÈY\ˆ[ˆ’YOOH	‰ˆÜËšXY\ˆOOH˜[ÙHÈÈ›ÛˆYHHˆßHJ_OİÎÏ˜
Kš›Ú[Š	ÉÊ_OİÎ˜ÂˆJKš›Ú[Š	ÉÊNÂˆ™]\›ˆÎ›Î›Î›ÈÎÏH‰İİ[ÚYHˆÎ\OH™H‹ÏÎ››Ü™\œÏÎÜÎ˜[HœÚ[™ÛHˆÎœŞHˆÎ˜ÛÛÜHĞ‘QLH‹ÏÎ›YÎ˜[HœÚ[™ÛHˆÎœŞHˆÎ˜ÛÛÜHĞ‘QLH‹ÏÎ˜›İÛHÎ˜[HœÚ[™ÛHˆÎœŞHˆÎ˜ÛÛÜHĞ‘QLH‹ÏÎœšYÚÎ˜[HœÚ[™ÛHˆÎœŞHˆÎ˜ÛÛÜHĞ‘QLH‹ÏÎš[œÚYRÎ˜[HœÚ[™ÛHˆÎœŞHˆÎ˜ÛÛÜHĞ‘QLH‹ÏÎš[œÚYUˆÎ˜[HœÚ[™ÛHˆÎœŞHˆÎ˜ÛÛÜHĞ‘QLH‹ÏİÎ››Ü™\œÏİÎ›Î›ÜšY‰ÙÜšYOİÎ›ÜšY‰İX›T›İÜßOİÎ›˜ÂˆB‚ˆ[˜İ[ÛˆX\šÙİÛ•ÕÛÜ™[
X\šÙİÛŠHÂˆÛÛœİ\ÈH×NÂˆ›Üˆ
ÛÛœİ›ØÚÈÙˆ\œÙSX\šÙİÛ›ØÚÜÊX\šÙİÛŠJHÂˆYˆ
›ØÚË\HOOH	Ø›[šÉÊHÛÛ[YNÂˆYˆ
›ØÚË\HOOH	ÚXY[™ÉÊHÂˆÛÛœİİ[HH›ØÚË›]™[HHÈ	ÒXY[™Ì‰Èˆ›ØÚË›]™[OOHˆÈ	ÒXY[™ÌÉÈˆ	ÒXY[™Í	ÎÂˆ\Ëœ\Ú
\˜YÜ˜\
›ØÚË^Èİ[KÙY\™^ˆYHJJNÂˆH[ÙHYˆ
›ØÚË\HOOH	İ^	ÊHÂˆ\Ëœ\Ú
\˜YÜ˜\
›ØÚË^ÈY\ˆML[™NˆÌJJNÂˆH[ÙHYˆ
›ØÚË\HOOH	Ü][İIÊHÂˆ\Ëœ\Ú
\˜YÜ˜\
›ØÚË^ÈY\ˆMŒ[™[ˆÍŒÚY[™Îˆ	ÑQÉË›Ü™\“YˆÈÛÛÜˆ	ÎMLĞ	ËÚ^™NˆMˆHJJNÂˆH[ÙHYˆ
›ØÚË\HOOH	Û\İ	ÊHÂˆÛÛœİ™Yš^H›ØÚË›Ü™\™YÈ	Ø›ØÚË›X\šÙ\ˆ	ÌIßKˆˆ	ø (ˆ	ÎÂˆ\Ëœ\Ú
\˜YÜ˜\
	ÉËÈ˜]ÎˆYKY\ˆÌ[™[ˆÍŒJBˆœ™\XÙJ	ÏİÎœ‰Ë	İÛÜ™[Š™Yš^È›Ûˆ˜[ÙHJ_IÚ[›[™UÛÜ™[
›ØÚË^
_OİÎœ˜
JNÂˆH[ÙHYˆ
›ØÚË\HOOH	Ü[IÊHÂˆ\Ëœ\Ú
	ÏÎœÎœÎœ™Î˜›İÛHÎ˜[HœÚ[™ÛHˆÎœŞHˆÎœÜXÙOHˆˆÎ˜ÛÛÜH‘QQˆ‹ÏİÎœ™ÎœÜXÚ[™ÈÎ˜™Y›Ü™OHŒLˆÎ˜Y\HŒL‹ÏİÎœİÎœ‰ÊNÂˆH[ÙHYˆ
›ØÚË\HOOH	ØÛÙIÊHÂˆ\Ëœ\Ú
ÛÙT\˜YÜ˜\
›ØÚË^›ØÚË›[™ÊJNÂˆH[ÙHYˆ
›ØÚË\HOOH	İX›IÊHÂˆ\Ëœ\Ú
ÛÜ™X›J›ØÚËœ›İÜÊJNÂˆ\Ëœ\Ú
\˜YÜ˜\
	È	ËÈY\ˆJJNÂˆBˆBˆ™]\›ˆ\Ëš›Ú[Š	ÉÊNÂˆB‚ˆ[˜İ[Ûˆ›ŞYÛÛ[[
ÛÛ[[
HÂˆ™]\›ˆÎ›Î›Î›ÈÎÏHLÍŒˆÎ\OH™H‹ÏÎ››Ü™\œÏÎ›YÎ˜[HœÚ[™ÛHˆÎœŞHŒŒˆÎ˜ÛÛÜHÍˆ‹ÏÎÜÎ˜[H›š[‹ÏÎ˜›İÛHÎ˜[H›š[‹ÏÎœšYÚÎ˜[H›š[‹ÏÎš[œÚYRÎ˜[H›š[‹ÏÎš[œÚYUˆÎ˜[H›š[‹ÏİÎ››Ü™\œÏİÎ›Î›ÜšYÎ™ÜšYÛÛÎÏHLÍŒ‹ÏİÎ›ÜšYÎÎÏÎÔÎÕÈÎÏHLÍŒˆÎ\OH™H‹ÏÎœÚÎ˜[H˜ÛX\ˆˆÎ˜ÛÛÜH˜]]ÈˆÎ™š[H‘QÈ‹ÏÎÓX\ÎÜÎÏHŒMLˆÎ\OH™H‹ÏÎ›YÎÏHŒNˆÎ\OH™H‹ÏÎ˜›İÛHÎÏHŒLŒˆÎ\OH™H‹ÏÎœšYÚÎÏHŒNˆÎ\OH™H‹ÏİÎÓX\İÎÔ‰ØÛÛ[[\˜YÜ˜\
	È	Ê_OİÎÏİÎİÎ›˜ÂˆB‚ˆÛÛœİ›ÙHH×NÂˆ›ÙKœ\Ú
\˜YÜ˜\
	ĞÒUÔÓÓ•‘T”ĞUSÓˆVÔ•	ËÈİ[Nˆ	ÒÚXÚÙ\‰ËÙY\™^ˆYHJJNÂˆ›ÙKœ\Ú
\˜YÜ˜\
]KÈİ[Nˆ	Õ]IËÙY\™^ˆYHJJNÂ‚ˆÛÛœİØÛÜHH\›œË›[™İOOHHÈ	ÔÚ[™ÛH]Y\İ[Ûˆ[™[œİÙ\‰ÈˆÛÛ\]HÛÛ™\œØ][Ûˆ0­È	İ\›œË›[™İHIH\›œØÂˆ›ÙKœ\Ú
ÛÜ™X›JÂˆÉÔØÛÜIËØÛÜWKˆÉÔÛİ\˜ÙIË]K\›	É×KˆÉÑ^ÜY	Ë›Ü›X]]J™]È]J
JWBˆKÈXY\ˆ˜[ÙHJJNÂˆ›ÙKœ\Ú
\˜YÜ˜\
	È	ËÈY\ˆLŒJJNÂ‚ˆ\›œË™›Ü‘XXÚ

\›‹Y
HOˆÂˆÛÛœİˆH[X™\‹š\Ñš[š]J\›‹š[™^
HÈ\›‹š[™^
ÈHˆY
ÈNÂˆ›ÙKœ\Ú
\˜YÜ˜\
UQTÕSÓˆ	Ôİš[™ÊŠKœYİ\
‹	Ì	Ê_XÈİ[Nˆ	ÔÙXİ[Û“X™[	ËÙY\™^ˆYHJJNÂˆ›ÙKœ\Ú
›ŞYÛÛ[[
X\šÙİÛ•ÕÛÜ™[
\›‹œ]Y\İ[Û‹›X\šÙİÛˆ\›‹œ]Y\İ[Û‹^
JJNÂ‚ˆÛÛœİ[œİÙ\œÈH
\›‹˜[œİÙ\œÈ×JK™š[\ŠHOˆK^K›X\šÙİÛŠNÂˆ[œİÙ\œË™›Ü‘XXÚ

[œİÙ\‹[œİÙ\’[™^
HOˆÂˆ›ÙKœ\Ú
\˜YÜ˜\
[œİÙ\œË›[™İˆHÈS”ÕÑTˆ	Ôİš[™Ê[œİÙ\’[™^
ÈJKœYİ\
‹	Ì	Ê_Xˆ	ĞS”ÕÑT‰ËÈİ[Nˆ	Ğ[œİÙ\“X™[	ËÙY\™^ˆYK™Y›Ü™NˆNJJNÂˆ›ÙKœ\Ú
X\šÙİÛ•ÕÛÜ™[
[œİÙ\‹›X\šÙİÛˆ[œİÙ\‹^
JNÂˆJNÂ‚ˆYˆ
Y\›œË›[™İHJHÂˆ›ÙKœ\Ú
	ÏÎœÎœÎœ™Î˜›İÛHÎ˜[HœÚ[™ÛHˆÎœŞHˆÎœÜXÙOHˆÎ˜ÛÛÜH‘QQˆ‹ÏİÎœ™ÎœÜXÚ[™ÈÎ˜™Y›Ü™OHŒMŒˆÎ˜Y\HŒŒŒ‹ÏİÎœİÎœ‰ÊNÂˆBˆJNÂ‚ˆÛÛœİÙXİˆHÎœÙXİ‚ˆÎšXY\”™Y™\™[˜ÙHÎ\OH™Y˜][ˆšYHœ’Yˆ‹Ï‚ˆÎ™›Ûİ\”™Y™\™[˜ÙHÎ\OH™Y˜][ˆšYHœ’YÈ‹Ï‚ˆÎœÔŞˆÎÏHŒLNLˆˆÎšHŒMÎ‹Ï‚ˆÎœÓX\ˆÎÜHŒLÍÈˆÎœšYÚHMˆÎ˜›İÛOHŒLÍÈˆÎ›YHMˆÎšXY\HHˆÎ™›Ûİ\HHˆÎ™İ]\HŒ‹Ï‚ˆİÎœÙXİ˜Â‚ˆÛÛœİØİ[Y[[HŞ[™\œÚ[ÛHŒKŒˆ[˜ÛÙ[™ÏH•U‹Nˆİ[™[Û™OHY\ÈÏ‚Î™Øİ[Y[[œÎÏHš‹ËÜØÚ[X\Ë›Ü[[›Ü›X]Ë›Ü™ËİÛÜ™›ØÙ\ÜÚ[™Û[ÌŒ‹ÛXZ[ˆˆ[œÎœHš‹ËÜØÚ[X\Ë›Ü[[›Ü›X]Ë›Ü™ËÛÙ™šXÙQØİ[Y[ÌŒ‹Ü™[][ÛœÚ\È‚Î˜›ÙO‰Ø›ÙKš›Ú[Š	ÉÊ_IÜÙXİŸOİÎ˜›ÙOİÎ™Øİ[Y[˜Â‚ˆÛÛœİİ[\Ö[HŞ[™\œÚ[ÛHŒKŒˆ[˜ÛÙ[™ÏH•U‹Nˆİ[™[Û™OHY\ÈÏ‚Îœİ[\È[œÎÏHš‹ËÜØÚ[X\Ë›Ü[[›Ü›X]Ë›Ü™ËİÛÜ™›ØÙ\ÜÚ[™Û[ÌŒ‹ÛXZ[ˆ‚ˆÎ™ØÑY˜][ÏÎœ”‘Y˜][Îœ”Îœ‘›ÛÈÎ˜\ØÚZOH\ÜÈˆÎš[œÚOH\ÜÈˆÎ™X\İ\ÚXOH“X[İ[ˆÛİXÈˆÎ˜ÜÏH“š\›X[HRH‹ÏÎœŞˆÎ˜[HŒŒH‹ÏÎœŞÜÈÎ˜[HŒŒH‹ÏÎ›[™ÈÎ˜[H™[‹UTÈ‹ÏİÎœ”İÎœ”‘Y˜][Îœ‘Y˜][ÎœÎœÜXÚ[™ÈÎ˜Y\HŒMˆÎ›[™OHŒÌˆÎ›[™T[OH˜]]È‹ÏİÎœİÎœ‘Y˜][İÎ™ØÑY˜][Ï‚ˆÎœİ[HÎ\OHœ\˜YÜ˜\ˆÎ™Y˜][HŒHˆÎœİ[RYH“›Ü›X[Î›˜[YHÎ˜[H“›Ü›X[‹ÏÎœQ›Ü›X]ÏÎœ”Îœ‘›ÛÈÎ˜\ØÚZOH\ÜÈˆÎš[œÚOH\ÜÈˆÎ™X\İ\ÚXOH“X[İ[ˆÛİXÈˆÎ˜ÜÏH“š\›X[HRH‹ÏÎœŞˆÎ˜[HŒŒH‹ÏÎœŞÜÈÎ˜[HŒŒH‹ÏÎ˜ÛÛÜˆÎ˜[HŒLLNÈ‹ÏİÎœ”İÎœİ[O‚ˆÎœİ[HÎ\OHœ\˜YÜ˜\ˆÎœİ[RYH•]HÎ›˜[YHÎ˜[H•]H‹ÏÎ˜˜\ÙYÛˆÎ˜[H“›Ü›X[‹ÏÎœQ›Ü›X]ÏÎœÎœÜXÚ[™ÈÎ˜™Y›Ü™OHˆÎ˜Y\HŒŒ‹ÏÎšÙY\™^ÏİÎœÎœ”Î˜‹ÏÎœŞˆÎ˜[Hˆ‹ÏÎœŞÜÈÎ˜[Hˆ‹ÏÎ˜ÛÛÜˆÎ˜[HŒLLNÈ‹ÏİÎœ”İÎœİ[O‚ˆÎœİ[HÎ\OHœ\˜YÜ˜\ˆÎœİ[RYH’ÚXÚÙ\ˆÎ›˜[YHÎ˜[H’ÚXÚÙ\ˆ‹ÏÎ˜˜\ÙYÛˆÎ˜[H“›Ü›X[‹ÏÎœÎœÜXÚ[™ÈÎ˜Y\HL‹ÏÎšÙY\™^ÏİÎœÎœ”Î˜‹ÏÎœŞˆÎ˜[HŒMÈ‹ÏÎœŞÜÈÎ˜[HŒMÈ‹ÏÎ˜ÛÛÜˆÎ˜[HMMŒÈ‹ÏÎœÜXÚ[™ÈÎ˜[HŒŒ‹ÏİÎœ”İÎœİ[O‚ˆÎœİ[HÎ\OHœ\˜YÜ˜\ˆÎœİ[RYH”ÙXİ[Û“X™[Î›˜[YHÎ˜[H”ÙXİ[ÛˆX™[‹ÏÎ˜˜\ÙYÛˆÎ˜[H“›Ü›X[‹ÏÎœÎœÜXÚ[™ÈÎ˜™Y›Ü™OHŒMŒˆÎ˜Y\HŒL‹ÏÎšÙY\™^ÏİÎœÎœ”Î˜‹ÏÎœŞˆÎ˜[HŒMÈ‹ÏÎœŞÜÈÎ˜[HŒMÈ‹ÏÎ˜ÛÛÜˆÎ˜[HŒÍÍMLH‹ÏÎœÜXÚ[™ÈÎ˜[HŒMˆ‹ÏİÎœ”İÎœİ[O‚ˆÎœİ[HÎ\OHœ\˜YÜ˜\ˆÎœİ[RYH[œİÙ\“X™[Î›˜[YHÎ˜[H[œİÙ\ˆX™[‹ÏÎ˜˜\ÙYÛˆÎ˜[H“›Ü›X[‹ÏÎœÎœÜXÚ[™ÈÎ˜™Y›Ü™OHŒŒŒˆÎ˜Y\HŒL‹ÏÎšÙY\™^ÏİÎœÎœ”Î˜‹ÏÎœŞˆÎ˜[HŒMÈ‹ÏÎœŞÜÈÎ˜[HŒMÈ‹ÏÎ˜ÛÛÜˆÎ˜[HŒQˆ‹ÏÎœÜXÚ[™ÈÎ˜[HŒMˆ‹ÏİÎœ”İÎœİ[O‚ˆÎœİ[HÎ\OHœ\˜YÜ˜\ˆÎœİ[RYH’XY[™ÌˆÎ›˜[YHÎ˜[H’XY[™Èˆ‹ÏÎ˜˜\ÙYÛˆÎ˜[H“›Ü›X[‹ÏÎœQ›Ü›X]ÏÎœÎœÜXÚ[™ÈÎ˜™Y›Ü™OHŒŒŒˆÎ˜Y\HŒL‹ÏÎšÙY\™^ÏİÎœÎœ”Î˜‹ÏÎœŞˆÎ˜[HŒ‹ÏÎœŞÜÈÎ˜[HŒ‹ÏÎ˜ÛÛÜˆÎ˜[HŒLLNÈ‹ÏİÎœ”İÎœİ[O‚ˆÎœİ[HÎ\OHœ\˜YÜ˜\ˆÎœİ[RYH’XY[™ÌÈÎ›˜[YHÎ˜[H’XY[™ÈÈ‹ÏÎ˜˜\ÙYÛˆÎ˜[H“›Ü›X[‹ÏÎœQ›Ü›X]ÏÎœÎœÜXÚ[™ÈÎ˜™Y›Ü™OHŒNˆÎ˜Y\HL‹ÏÎšÙY\™^ÏİÎœÎœ”Î˜‹ÏÎœŞˆÎ˜[HŒ‹ÏÎœŞÜÈÎ˜[HŒ‹ÏÎ˜ÛÛÜˆÎ˜[HŒLLNÈ‹ÏİÎœ”İÎœİ[O‚ˆÎœİ[HÎ\OHœ\˜YÜ˜\ˆÎœİ[RYH’XY[™ÍÎ›˜[YHÎ˜[H’XY[™È‹ÏÎ˜˜\ÙYÛˆÎ˜[H“›Ü›X[‹ÏÎœQ›Ü›X]ÏÎœÎœÜXÚ[™ÈÎ˜™Y›Ü™OHŒMLˆÎ˜Y\H‹ÏÎšÙY\™^ÏİÎœÎœ”Î˜‹ÏÎœŞˆÎ˜[HŒŒˆ‹ÏÎœŞÜÈÎ˜[HŒŒˆ‹ÏÎ˜ÛÛÜˆÎ˜[HŒLLNÈ‹ÏİÎœ”İÎœİ[O‚ˆÎœİ[HÎ\OHœ\˜YÜ˜\ˆÎœİ[RYHÛÙSX™[Î›˜[YHÎ˜[HÛÙHX™[‹ÏÎ˜˜\ÙYÛˆÎ˜[H“›Ü›X[‹ÏÎœÎœÜXÚ[™ÈÎ˜™Y›Ü™OHŒLˆÎ˜Y\HL‹ÏÎšÙY\™^ÏİÎœÎœ”Î˜‹ÏÎœ‘›ÛÈÎ˜\ØÚZOHÛÛœÛÛ\ÈˆÎš[œÚOHÛÛœÛÛ\È‹ÏÎœŞˆÎ˜[HŒMH‹ÏÎœŞÜÈÎ˜[HŒMH‹ÏÎ˜ÛÛÜˆÎ˜[HMMŒÈ‹ÏİÎœ”İÎœİ[O‚İÎœİ[\Ï˜Â‚ˆÛÛœİXY\–[HŞ[™\œÚ[ÛHŒKŒˆ[˜ÛÙ[™ÏH•U‹Nˆİ[™[Û™OHY\ÈÏ‚Îšˆ[œÎÏHš‹ËÜØÚ[X\Ë›Ü[[›Ü›X]Ë›Ü™ËİÛÜ™›ØÙ\ÜÚ[™Û[ÌŒ‹ÛXZ[ˆÎœÎœÎœ™Î˜›İÛHÎ˜[HœÚ[™ÛHˆÎœŞHˆÎœÜXÙOHˆÎ˜ÛÛÜH‘QQˆ‹ÏİÎœ™ÎœÜXÚ[™ÈÎ˜Y\HŒ‹ÏİÎœ‰İÛÜ™[ŠTÓSQKÕ\\Ø\ÙJ
KÈ›ÛˆYKÚ^™NˆMKÛÛÜˆ	ÍÌ	ÈJ_OİÎœİÎš˜Â‚ˆÛÛœİ›Ûİ\–[HŞ[™\œÚ[ÛHŒKŒˆ[˜ÛÙ[™ÏH•U‹Nˆİ[™[Û™OHY\ÈÏ‚Î™ˆ[œÎÏHš‹ËÜØÚ[X\Ë›Ü[[›Ü›X]Ë›Ü™ËİÛÜ™›ØÙ\ÜÚ[™Û[ÌŒ‹ÛXZ[ˆÎœÎœÎš˜ÈÎ˜[HœšYÚ‹ÏÎœ™ÎÜÎ˜[HœÚ[™ÛHˆÎœŞHˆÎœÜXÙOHˆÎ˜ÛÛÜH‘MQMÑPˆ‹ÏİÎœ™ÎœÜXÚ[™ÈÎ˜™Y›Ü™OHŒ‹ÏİÎœ‰İÛÜ™[Š	ÔYÙH	ËÈÚ^™NˆM‹ÛÛÜˆ	ÍÌ	ÈJ_OÎ™›Ú[\HÎš[œİH”QÑH‰İÛÜ™[Š	ÌIËÈÚ^™NˆM‹ÛÛÜˆ	ÍÌ	ÈJ_OİÎ™›Ú[\O‰İÛÜ™[Š	ÈÙˆ	ËÈÚ^™NˆM‹ÛÛÜˆ	ÍÌ	ÈJ_OÎ™›Ú[\HÎš[œİH“•STQÑTÈ‰İÛÜ™[Š	ÌIËÈÚ^™NˆM‹ÛÛÜˆ	ÍÌ	ÈJ_OİÎ™›Ú[\OİÎœİÎ™˜Â‚ˆÛÛœİÛÛ[\\ÈHŞ[™\œÚ[ÛHŒKŒˆ[˜ÛÙ[™ÏH•U‹Nˆİ[™[Û™OHY\ÈÏ‚\\È[œÏHš‹ËÜØÚ[X\Ë›Ü[[›Ü›X]Ë›Ü™ËÜXÚØYÙKÌŒ‹ØÛÛ[]\\È‚ˆY˜][^[œÚ[ÛHœ™[ÈˆÛÛ[\OH˜\XØ][Û‹İ›™›Ü[[›Ü›X]Ë\XÚØYÙKœ™[][ÛœÚ\ÊŞ[‹Ï‚ˆY˜][^[œÚ[ÛH[ˆÛÛ[\OH˜\XØ][Û‹Ş[‹Ï‚ˆİ™\œšYH\˜[YOH‹İÛÜ™ÙØİ[Y[[ˆÛÛ[\OH˜\XØ][Û‹İ›™›Ü[[›Ü›X]Ë[Ù™šXÙYØİ[Y[ÛÜ™›ØÙ\ÜÚ[™Û[™Øİ[Y[›XZ[ŠŞ[‹Ï‚ˆİ™\œšYH\˜[YOH‹İÛÜ™Üİ[\Ë[ˆÛÛ[\OH˜\XØ][Û‹İ›™›Ü[[›Ü›X]Ë[Ù™šXÙYØİ[Y[ÛÜ™›ØÙ\ÜÚ[™Û[œİ[\ÊŞ[‹Ï‚ˆİ™\œšYH\˜[YOH‹İÛÜ™ÚXY\ŒK[ˆÛÛ[\OH˜\XØ][Û‹İ›™›Ü[[›Ü›X]Ë[Ù™šXÙYØİ[Y[ÛÜ™›ØÙ\ÜÚ[™Û[šXY\ŠŞ[‹Ï‚ˆİ™\œšYH\˜[YOH‹İÛÜ™Ù›Ûİ\ŒK[ˆÛÛ[\OH˜\XØ][Û‹İ›™›Ü[[›Ü›X]Ë[Ù™šXÙYØİ[Y[ÛÜ™›ØÙ\ÜÚ[™Û[™›Ûİ\ŠŞ[‹Ï‚ˆİ™\œšYH\˜[YOH‹İÛÜ™ÜÙ][™ÜË[ˆÛÛ[\OH˜\XØ][Û‹İ›™›Ü[[›Ü›X]Ë[Ù™šXÙYØİ[Y[ÛÜ™›ØÙ\ÜÚ[™Û[œÙ][™ÜÊŞ[‹Ï‚ˆİ™\œšYH\˜[YOH‹ÙØÔ›ÜËØÛÜ™K[ˆÛÛ[\OH˜\XØ][Û‹İ›™›Ü[[›Ü›X]Ë\XÚØYÙK˜ÛÜ™K\›Ü\Y\ÊŞ[‹Ï‚Õ\\Ï˜Â‚ˆÛÛœİ›Ûİ™[ÈHŞ[™\œÚ[ÛHŒKŒˆ[˜ÛÙ[™ÏH•U‹Nˆİ[™[Û™OHY\ÈÏ‚™[][ÛœÚ\È[œÏHš‹ËÜØÚ[X\Ë›Ü[[›Ü›X]Ë›Ü™ËÜXÚØYÙKÌŒ‹Ü™[][ÛœÚ\È‚ˆ™[][ÛœÚ\YHœ’YHˆ\OHš‹ËÜØÚ[X\Ë›Ü[[›Ü›X]Ë›Ü™ËÛÙ™šXÙQØİ[Y[ÌŒ‹Ü™[][ÛœÚ\ËÛÙ™šXÙQØİ[Y[ˆ\™Ù]HÛÜ™ÙØİ[Y[[‹Ï‚ˆ™[][ÛœÚ\YHœ’Yˆˆ\OHš‹ËÜØÚ[X\Ë›Ü[[›Ü›X]Ë›Ü™ËÜXÚØYÙKÌŒ‹Ü™[][ÛœÚ\ËÛY]Y]KØÛÜ™K\›Ü\Y\Èˆ\™Ù]H™ØÔ›ÜËØÛÜ™K[‹Ï‚Ô™[][ÛœÚ\Ï˜Â‚ˆÛÛœİØİ[Y[™[ÈHŞ[™\œÚ[ÛHŒKŒˆ[˜ÛÙ[™ÏH•U‹Nˆİ[™[Û™OHY\ÈÏ‚™[][ÛœÚ\È[œÏHš‹ËÜØÚ[X\Ë›Ü[[›Ü›X]Ë›Ü™ËÜXÚØYÙKÌŒ‹Ü™[][ÛœÚ\È‚ˆ™[][ÛœÚ\YHœ’YHˆ\OHš‹ËÜØÚ[X\Ë›Ü[[›Ü›X]Ë›Ü™ËÛÙ™šXÙQØİ[Y[ÌŒ‹Ü™[][ÛœÚ\ËÜİ[\Èˆ\™Ù]Hœİ[\Ë[‹Ï‚ˆ™[][ÛœÚ\YHœ’Yˆˆ\OHš‹ËÜØÚ[X\Ë›Ü[[›Ü›X]Ë›Ü™ËÛÙ™šXÙQØİ[Y[ÌŒ‹Ü™[][ÛœÚ\ËÚXY\ˆˆ\™Ù]HšXY\ŒK[‹Ï‚ˆ™[][ÛœÚ\YHœ’YÈˆ\OHš‹ËÜØÚ[X\Ë›Ü[[›Ü›X]Ë›Ü™ËÛÙ™šXÙQØİ[Y[ÌŒ‹Ü™[][ÛœÚ\ËÙ›Ûİ\ˆˆ\™Ù]H™›Ûİ\ŒK[‹Ï‚ˆ™[][ÛœÚ\YHœ’Yˆ\OHš‹ËÜØÚ[X\Ë›Ü[[›Ü›X]Ë›Ü™ËÛÙ™šXÙQØİ[Y[ÌŒ‹Ü™[][ÛœÚ\ËÜÙ][™ÜÈˆ\™Ù]HœÙ][™ÜË[‹Ï‚ˆ	Ú\\›[šÔ™[Ëš›Ú[Š	×ˆ	Ê_BÔ™[][ÛœÚ\Ï˜Â‚ˆÛÛœİÙ][™ÜÖ[HŞ[™\œÚ[ÛHŒKŒˆ[˜ÛÙ[™ÏH•U‹Nˆİ[™[Û™OHY\ÈÏ‚ÎœÙ][™ÜÈ[œÎÏHš‹ËÜØÚ[X\Ë›Ü[[›Ü›X]Ë›Ü™ËİÛÜ™›ØÙ\ÜÚ[™Û[ÌŒ‹ÛXZ[ˆÎ\]QšY[ÈÎ˜[HYH‹ÏÎ™Y˜][X”İÜÎ˜[HÌŒ‹ÏİÎœÙ][™ÜÏ˜Â‚ˆÛÛœİ›İÈH™]È]J
KÒTÓÔİš[™Ê
NÂˆÛÛœİÛÜ™V[HŞ[™\œÚ[ÛHŒKŒˆ[˜ÛÙ[™ÏH•U‹Nˆİ[™[Û™OHY\ÈÏ‚Ü˜ÛÜ™T›Ü\Y\È[œÎ˜ÜHš‹ËÜØÚ[X\Ë›Ü[[›Ü›X]Ë›Ü™ËÜXÚØYÙKÌŒ‹ÛY]Y]KØÛÜ™K\›Ü\Y\Èˆ[œÎ™ÏHš‹ËÜ\››Ü™ËÙËÙ[[Y[ËÌKŒKÈˆ[œÎ™İ\›\ÏHš‹ËÜ\››Ü™ËÙËİ\›\ËÈˆ[œÎÚOHš‹ËİİİËÌË›Ü™ËÌŒKÖSØÚ[XKZ[œİ[˜ÙH‚ˆÎ]O‰Ş[\ØØ\J]J_OÙÎ]O‚ˆÎœİXš™XİÚ]ÔÛÛ™\œØ][Ûˆ^ÜÙÎœİXš™Xİ‚ˆÎ˜Ü™X]Ü‰ĞTÓSQ_OÙÎ˜Ü™X]Ü‚ˆÎ™\ØÜš\[Û‘^ÜYØØ[Hœ›ÛH	Ş[\ØØ\J]K\›	ÉÊ_OÙÎ™\ØÜš\[Û‚ˆİ\›\Î˜Ü™X]YÚN\OH™İ\›\Î•ÌĞÑˆ‰Û›İßOÙİ\›\Î˜Ü™X]Y‚ˆİ\›\Î›[ÙYšYYÚN\OH™İ\›\Î•ÌĞÑˆ‰Û›İßOÙİ\›\Î›[ÙYšYY‚ØÜ˜ÛÜ™T›Ü\Y\Ï˜Â‚ˆÛÛœİ]\ÈHš\İÜ™JÂˆÈ˜[YNˆ	ÖĞÛÛ[Õ\\×K[	Ë]NˆÛÛ[\\ÈKˆÈ˜[YNˆ	×Ü™[ËËœ™[ÉË]Nˆ›Ûİ™[ÈKˆÈ˜[YNˆ	ÙØÔ›ÜËØÛÜ™K[	Ë]NˆÛÜ™V[KˆÈ˜[YNˆ	İÛÜ™ÙØİ[Y[[	Ë]NˆØİ[Y[[KˆÈ˜[YNˆ	İÛÜ™Üİ[\Ë[	Ë]Nˆİ[\Ö[KˆÈ˜[YNˆ	İÛÜ™ÚXY\ŒK[	Ë]NˆXY\–[KˆÈ˜[YNˆ	İÛÜ™Ù›Ûİ\ŒK[	Ë]Nˆ›Ûİ\–[KˆÈ˜[YNˆ	İÛÜ™ÜÙ][™ÜË[	Ë]NˆÙ][™ÜÖ[KˆÈ˜[YNˆ	İÛÜ™×Ü™[ËÙØİ[Y[[œ™[ÉË]NˆØİ[Y[™[ÈBˆJNÂ‚ˆ™]\›ˆ™]È›ØŠØ]\×KÈ\NˆRSQWÑĞÖJNÂˆB‚ˆ[˜İ[Ûˆ^ÜX\šÙİÛŠ]K\›œÊHÂˆÛÛœİ›ØˆH™]È›ØŠØÜ™X]SX\šÙİÛŠ]K\›œÊWKÈ\Nˆ	İ^ÛX\šÙİÛØÚ\œÙ]]]‹N	ÈJNÂˆİÛ›ØY›ØŠ›Ø‹^Üš[[˜[YJ]K\›œË	ÛY	ÊJNÂˆB‚ˆ[˜İ[Ûˆ^ÜØŞ
]K\›œÊHÂˆİÛ›ØY›ØŠÜ™X]QØŞ›ØŠ]K\›œÊK^Üš[[˜[YJ]K\›œË	ÙØŞ	ÊJNÂˆB‚ˆÛØ˜[\ËÚ]Ô^Ü\ˆHØš™Xİ™œ™Y^™JÂˆ›Ü›X[^™U^ˆØY™Qš[[˜[YKˆ^Üš[[˜[YKˆÜ™X]SX\šÙİÛ‹ˆÜ™X]QØŞ›Ø‹ˆZ[š[[ˆ^ÜX\šÙİÛ‹ˆ^ÜØŞˆ^Ü‹ˆİÛ›ØY›Ø‚ˆJNÂŸJJ
NÂ