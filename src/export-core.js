(() => {
  'use strict';

  const APP_NAME = 'ChatGPT Thread Exporter';
  const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const TICK = String.fromCharCode(96);
  const COLORS = Object.freeze({
    primary: '17365D',
    secondary: '475569',
    body: '1F2937',
    muted: '64748B',
    border: 'D9E2EC',
    question: 'F5F8FC',
    code: 'F3F4F6',
    paper: 'FFFFFF'
  });
  const PAGE_SIZES = Object.freeze({
    A4: { css: 'A4', width: 11906, height: 16838 },
    Letter: { css: 'Letter', width: 12240, height: 15840 },
    Legal: { css: 'Legal', width: 12240, height: 20160 }
  });

  function normalizeText(text) {
    return String(text || '').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function normalizePageSize(value) {
    const key = String(value || 'A4').toLowerCase();
    if (key === 'letter') return 'Letter';
    if (key === 'legal') return 'Legal';
    return 'A4';
  }

  function safeFilename(title) {
    const cleaned = String(title || 'ChatGPT Conversation')
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100);
    return cleaned || 'ChatGPT Conversation';
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function xmlEscape(value) {
    return String(value || '').replace(/[<>&"']/g, function (ch) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch];
    });
  }

  function safeUrl(value) {
    const url = String(value || '').trim();
    if (!url || /^javascript:/i.test(url)) return '';
    return url;
  }

  function documentTitle(data, turns) {
    const base = (data && data.title) || 'ChatGPT Conversation';
    if (turns.length === 1 && Number.isFinite(turns[0].index)) return base + ' — Q&A ' + (turns[0].index + 1);
    return base;
  }

  function exportFilename(data, turns, extension) {
    let title = safeFilename((data && data.title) || 'ChatGPT Conversation');
    if (turns.length === 1 && Number.isFinite(turns[0].index)) title += ' - QA ' + (turns[0].index + 1);
    return title + '.' + extension;
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
    setTimeout(function () { URL.revokeObjectURL(url); }, 6000);
  }

  function shouldIncludeImage(meta) {
    meta = meta || {};
    const src = String(meta.src || '').trim();
    if (!src || /^javascript:/i.test(src)) return false;
    const haystack = (src + ' ' + (meta.alt || '') + ' ' + (meta.className || '') + ' ' + (meta.role || '')).toLowerCase();
    if (/google\.com\/s2\/favicons|favicon|apple-touch-icon|avatar|profile[-_ ]?image|emoji[-_ ]?icon|toolbar[-_ ]?icon|tracking[-_ ]?pixel/.test(haystack)) return false;
    if (/^data:image\/svg\+xml/i.test(src) && /icon|logo/.test(haystack)) return false;
    const width = Number(meta.width || 0);
    const height = Number(meta.height || 0);
    if (width > 0 && height > 0 && width <= 64 && height <= 64) return false;
    if (width > 0 && height > 0 && width * height < 4096) return false;
    return true;
  }

  function inlineText(inlines) {
    return (inlines || []).map(function (token) {
      if (!token) return '';
      if (token.type === 'text' || token.type === 'code') return token.text || '';
      if (token.type === 'math') return token.tex || token.text || '';
      if (token.children) return inlineText(token.children);
      if (token.type === 'image') return token.alt || 'Image';
      return '';
    }).join('');
  }

  function messageBlocks(message) {
    if (message && Array.isArray(message.blocks) && message.blocks.length) return message.blocks;
    const text = (message && (message.markdown || message.text)) || '';
    return text ? [{ type: 'paragraph', inlines: [{ type: 'text', text: text }] }] : [];
  }

  function markdownEscapeText(value) {
    return String(value || '').replace(/\\/g, '\\\\').replace(/([*_~])/g, '\\$1');
  }

  function inlineToMarkdown(inlines) {
    return (inlines || []).map(function (token) {
      if (!token) return '';
      if (token.type === 'text') return token.text || '';
      if (token.type === 'strong') return '**' + inlineToMarkdown(token.children) + '**';
      if (token.type === 'em') return '*' + inlineToMarkdown(token.children) + '*';
      if (token.type === 'strike') return '~~' + inlineToMarkdown(token.children) + '~~';
      if (token.type === 'code') return TICK + String(token.text || '').split(TICK).join('\\' + TICK) + TICK;
      if (token.type === 'link') {
        const label = inlineToMarkdown(token.children) || token.href || 'Link';
        return token.href ? '[' + label + '](' + token.href + ')' : label;
      }
      if (token.type === 'math') {
        const tex = token.tex || token.text || '';
        return token.display ? '$$' + tex + '$$' : '$' + tex + '$';
      }
      if (token.type === 'image') {
        if (!shouldIncludeImage(token)) return token.alt ? '[' + markdownEscapeText(token.alt) + ']' : '';
        return token.src ? '![' + markdownEscapeText(token.alt || 'Image') + '](' + token.src + ')' : '[' + markdownEscapeText(token.alt || 'Image') + ']';
      }
      return '';
    }).join('');
  }

  function blocksToMarkdown(blocks, depth) {
    depth = depth || 0;
    const lines = [];
    const indent = '  '.repeat(depth);
    const fence = TICK.repeat(3);

    (blocks || []).forEach(function (block) {
      if (!block) return;
      if (block.type === 'paragraph') {
        const value = inlineToMarkdown(block.inlines).trim();
        if (value) lines.push(indent + value, '');
      } else if (block.type === 'heading') {
        const level = Math.max(1, Math.min(6, Number(block.level || 2)));
        lines.push(indent + '#'.repeat(level) + ' ' + inlineToMarkdown(block.inlines).trim(), '');
      } else if (block.type === 'code') {
        lines.push(indent + fence + (block.lang || ''), String(block.text || ''), indent + fence, '');
      } else if (block.type === 'quote') {
        blocksToMarkdown(block.blocks || [], 0).trimEnd().split('\n').forEach(function (line) {
          lines.push((indent + '> ' + line).trimEnd());
        });
        lines.push('');
      } else if (block.type === 'rule') {
        lines.push(indent + '---', '');
      } else if (block.type === 'math') {
        lines.push(indent + '$$', block.tex || block.text || '', indent + '$$', '');
      } else if (block.type === 'image') {
        const md = inlineToMarkdown([Object.assign({}, block, { type: 'image' })]);
        if (md) {
          lines.push(indent + md);
          if (block.caption) lines.push(indent + '*' + block.caption + '*');
          lines.push('');
        }
      } else if (block.type === 'table') {
        const rows = block.rows || [];
        if (!rows.length) return;
        const width = Math.max.apply(null, rows.map(function (row) { return row.length; }).concat([1]));
        const normalized = rows.map(function (row) { return row.concat(Array(Math.max(0, width - row.length)).fill([])); });
        function rowLine(row) {
          return '| ' + row.map(function (cell) {
            return inlineToMarkdown(cell || []).replace(/\|/g, '\\|').replace(/\n/g, '<br>');
          }).join(' | ') + ' |';
        }
        lines.push(indent + rowLine(normalized[0]), indent + '| ' + Array(width).fill('---').join(' | ') + ' |');
        normalized.slice(1).forEach(function (row) { lines.push(indent + rowLine(row)); });
        lines.push('');
      } else if (block.type === 'list') {
        const ordered = Boolean(block.ordered);
        const start = Number.isFinite(Number(block.start)) ? Number(block.start) : 1;
        (block.items || []).forEach(function (item, index) {
          const markerValue = Number.isFinite(Number(item.value)) ? Number(item.value) : start + index;
          const marker = ordered ? markerValue + '.' : '-';
          const itemBlocks = item.blocks || [];
          const first = itemBlocks[0];
          let firstText = '';
          if (first && (first.type === 'paragraph' || first.type === 'heading')) firstText = inlineToMarkdown(first.inlines).trim();
          lines.push((indent + marker + ' ' + firstText).trimEnd());
          const rest = first && (first.type === 'paragraph' || first.type === 'heading') ? itemBlocks.slice(1) : itemBlocks;
          const nested = blocksToMarkdown(rest, depth + 1).trimEnd();
          if (nested) lines.push(nested);
        });
        lines.push('');
      }
    });

    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + (lines.length ? '\n' : '');
  }

  globalThis.ChatGPTExporter = Object.assign(globalThis.ChatGPTExporter || {}, {
    APP_NAME: APP_NAME,
    MIME_DOCX: MIME_DOCX,
    COLORS: COLORS,
    PAGE_SIZES: PAGE_SIZES,
    normalizeText: normalizeText,
    normalizePageSize: normalizePageSize,
    safeFilename: safeFilename,
    escapeHtml: escapeHtml,
    xmlEscape: xmlEscape,
    safeUrl: safeUrl,
    documentTitle: documentTitle,
    exportFilename: exportFilename,
    downloadBlob: downloadBlob,
    shouldIncludeImage: shouldIncludeImage,
    inlineText: inlineText,
    messageBlocks: messageBlocks,
    inlineToMarkdown: inlineToMarkdown,
    blocksToMarkdown: blocksToMarkdown
  });
})();