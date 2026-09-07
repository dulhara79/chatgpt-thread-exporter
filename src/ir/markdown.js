/**
 * IR -> Markdown.
 *
 * Markdown is now an *output* format rather than the transport, so nesting and
 * table alignment survive.
 */
(() => {
  'use strict';

  const IR = globalThis.ThreadExporterIR;

  function escapeText(text) {
    return String(text || '').replace(/([\\`*_[\]])/g, '\\$1');
  }

  function inlineToMarkdown(inline) {
    return (inline || []).map(node => {
      switch (node.type) {
        case 'text': return escapeText(node.text);
        case 'break': return '  \n';
        case 'code': {
          const text = String(node.text || '');
          const fence = text.includes('`') ? '``' : '`';
          const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
          return fence + pad + text + pad + fence;
        }
        case 'strong': return '**' + inlineToMarkdown(node.children) + '**';
        case 'em': return '*' + inlineToMarkdown(node.children) + '*';
        case 'del': return '~~' + inlineToMarkdown(node.children) + '~~';
        case 'link': return '[' + inlineToMarkdown(node.children) + '](' + (node.href || '') + ')';
        case 'image': return '![' + String(node.alt || 'Image') + '](' + (node.src || '') + ')';
        case 'math': {
          const d = String.fromCharCode(36);
          return node.display ? d + d + (node.tex || '') + d + d : d + (node.tex || '') + d;
        }
        default: return '';
      }
    }).join('');
  }

  function cellToMarkdown(cell) {
    return (cell.blocks || [])
      .map(block => block.type === 'paragraph' ? inlineToMarkdown(block.inline) : IR.blocksToPlainText([block]))
      .join(' ')
      .replace(/\n+/g, ' ')
      .replace(/\|/g, '\\|')
      .trim();
  }

  function alignmentBar(align) {
    if (align === 'left') return ':---';
    if (align === 'center') return ':---:';
    if (align === 'right') return '---:';
    return '---';
  }

  /**
   * @param {object[]} blocks
   * @param {string} [indent] prefix applied to every emitted line
   */
  function blocksToMarkdown(blocks, indent = '') {
    const out = [];

    for (const block of blocks || []) {
      switch (block.type) {
        case 'heading':
          out.push(indent + '#'.repeat(block.level) + ' ' + inlineToMarkdown(block.inline), '');
          break;

        case 'paragraph':
          out.push(...inlineToMarkdown(block.inline).split('\n').map(line => indent + line), '');
          break;

        case 'code': {
          const fence = (block.text || '').includes('```') ? '~~~' : '```';
          out.push(indent + fence + (block.lang || ''));
          out.push(...String(block.text || '').split('\n').map(line => indent + line));
          out.push(indent + fence, '');
          break;
        }

        case 'quote': {
          const inner = blocksToMarkdown(block.blocks, '').trimEnd().split('\n');
          out.push(...inner.map(line => indent + '> ' + line), '');
          break;
        }

        case 'list': {
          const counterStart = block.ordered ? Number(block.start || 1) : 0;
          block.items.forEach((item, index) => {
            const marker = block.ordered ? `${counterStart + index}. ` : '- ';
            const task = item.checked === undefined ? '' : (item.checked ? '[x] ' : '[ ] ');
            const childIndent = indent + ' '.repeat(marker.length);
            const rendered = blocksToMarkdown(item.blocks, childIndent).trimEnd();
            if (!rendered) {
              out.push(indent + marker + task);
              return;
            }
            const lines = rendered.split('\n');
            // Re-attach the marker to the first line of the item's first block.
            lines[0] = indent + marker + task + lines[0].slice(childIndent.length);
            out.push(...lines);
          });
          out.push('');
          break;
        }

        case 'table': {
          const rows = [block.head, ...(block.rows || [])];
          const width = Math.max(...rows.map(row => row.length), 1);
          const render = row => {
            const cells = [...row.map(cellToMarkdown), ...Array(Math.max(0, width - row.length)).fill('')];
            return indent + '| ' + cells.join(' | ') + ' |';
          };
          out.push(render(block.head));
          const align = [...(block.align || []), ...Array(width).fill(null)].slice(0, width);
          out.push(indent + '| ' + align.map(alignmentBar).join(' | ') + ' |');
          for (const row of block.rows || []) out.push(render(row));
          out.push('');
          break;
        }

        case 'rule':
          out.push(indent + '---', '');
          break;

        case 'image':
          out.push(indent + '![' + (block.alt || 'Image') + '](' + (block.src || '') + ')', '');
          break;

        case 'math': {
          const d = String.fromCharCode(36);
          out.push(indent + d + d + (block.tex || '') + d + d, '');
          break;
        }

        case 'artifact':
          out.push(indent + '#### Artifact: ' + (block.title || 'Untitled'), '');
          out.push(blocksToMarkdown(block.blocks, indent).trimEnd(), '');
          break;

        case 'thinking':
          out.push(indent + '<details><summary>Thinking</summary>', '');
          out.push(blocksToMarkdown(block.blocks, indent).trimEnd(), '');
          out.push(indent + '</details>', '');
          break;

        default:
          break;
      }
    }

    return out.join('\n');
  }

  globalThis.ThreadExporterMarkdown = Object.freeze({ blocksToMarkdown, inlineToMarkdown });
})();
