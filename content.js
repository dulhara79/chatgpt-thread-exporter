(() => {
  'use strict';

  const ROLE_SELECTOR = '[data-message-author-role="user"], [data-message-author-role="assistant"]';
  const ASSISTANT_SELECTOR = '[data-message-author-role="assistant"]';
  const EXPORT_BUTTON_CLASS = 'cgx-inline-export-button';
  const THREAD_BUTTON_ID = 'cgx-thread-export-button';
  const MENU_ID = 'cgx-export-menu';
  const exporter = globalThis.ChatGPTExporter;

  if (!exporter) {
    console.error('[ChatGPT Thread Exporter] export engine did not load.');
    return;
  }

  function normalizeText(text) {
    return exporter.normalizeText(text);
  }

  function visible(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function markdownFromElement(root) {
    if (!root) return '';
    const clone = root.cloneNode(true);

    clone.querySelectorAll(
      `button, script, style, svg, .${EXPORT_BUTTON_CLASS}, #${THREAD_BUTTON_ID}, [data-cgx-ui], ` +
      '[data-testid*="copy"], [data-testid*="feedback"]'
    ).forEach(el => el.remove());

    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
      if (node.nodeType !== Node.ELEMENT_NODE) return '';

      const el = node;
      const tag = el.tagName.toLowerCase();
      const child = () => Array.from(el.childNodes).map(walk).join('');

      if (tag === 'br') return '\n';
      if (tag === 'hr') return '\n\n---\n\n';
      if (tag === 'strong' || tag === 'b') return `**${child()}**`;
      if (tag === 'em' || tag === 'i') return `*${child()}*`;
      if (tag === 'del' || tag === 's') return `~~${child()}~~`;
      if (tag === 'code' && el.parentElement?.tagName.toLowerCase() !== 'pre') {
        return `\`${child().replace(/`/g, '\\`')}\``;
      }
      if (tag === 'pre') {
        const codeEl = el.querySelector('code');
        const code = codeEl?.innerText ?? el.innerText ?? '';
        const cls = codeEl?.className || '';
        const lang = cls.match(/language-([\w-]+)/i)?.[1] ||
          el.getAttribute('data-language') || '';
        return `\n\n\`\`\`${lang}\n${code.trimEnd()}\n\`\`\`\n\n`;
      }
      if (/^h[1-6]$/.test(tag)) {
        return `\n\n${'#'.repeat(Number(tag[1]))} ${normalizeText(child())}\n\n`;
      }
      if (tag === 'blockquote') {
        return `\n\n${normalizeText(child()).split('\n').map(line => `> ${line}`).join('\n')}\n\n`;
      }
      if (tag === 'a') {
        const label = normalizeText(child()) || el.getAttribute('href') || '';
        const href = el.getAttribute('href') || '';
        return href && !href.startsWith('javascript:') ? `[${label}](${href})` : label;
      }
      if (tag === 'img') {
        const alt = el.getAttribute('alt') || 'Image';
        const src = el.getAttribute('src') || '';
        return src ? `![${alt}](${src})` : `[${alt}]`;
      }
      if (tag === 'li') {
        const parent = el.parentElement?.tagName.toLowerCase();
        if (parent === 'ol') {
          const siblings = Array.from(el.parentElement.children).filter(c => c.tagName?.toLowerCase() === 'li');
          const index = siblings.indexOf(el) + 1;
          return `${index}. ${normalizeText(child())}\n`;
        }
        return `- ${normalizeText(child())}\n`;
      }
      if (tag === 'ul' || tag === 'ol') return `\n${child()}\n`;
      if (tag === 'p') return `${child()}\n\n`;
      if (tag === 'table') {
        const rows = Array.from(el.querySelectorAll('tr')).map(tr =>
          Array.from(tr.querySelectorAll('th,td')).map(cell =>
            normalizeText(cell.innerText).replace(/\|/g, '\\|')
          )
        );
        if (!rows.length) return '';
        const width = Math.max(...rows.map(r => r.length));
        const padded = rows.map(r => [...r, ...Array(Math.max(0, width - r.length)).fill('')]);
        const separator = Array(width).fill('---');
        return `\n${[padded[0], separator, ...padded.slice(1)].map(r => `| ${r.join(' | ')} |`).join('\n')}\n\n`;
      }
      return child();
    }

    return normalizeText(walk(clone));
  }

  function findMessageBody(roleNode) {
    const likely = roleNode.querySelector(
      '.markdown, [class*="markdown"], [data-message-content], .prose, [class*="prose"]'
    );
    if (likely) return likely;

    const candidates = Array.from(roleNode.querySelectorAll('div')).filter(el => {
      const text = normalizeText(el.innerText);
      return text.length > 0 && !el.querySelector(ROLE_SELECTOR) && !el.querySelector(`.${EXPORT_BUTTON_CLASS}`);
    });
    candidates.sort((a, b) => (b.innerText?.length || 0) - (a.innerText?.length || 0));
    return candidates[0] || roleNode;
  }

  function messageFromNode(node) {
    const role = node?.getAttribute('data-message-author-role');
    if (role !== 'user' && role !== 'assistant') return null;
    const body = findMessageBody(node);
    const text = normalizeText(body?.innerText || node.innerText || '');
    const markdown = markdownFromElement(body) || text;
    if (!text && !markdown) return null;
    return { role, text, markdown };
  }

  function getTitle() {
    const cleaned = document.title.replace(/\s*[-–—|]\s*ChatGPT\s*$/i, '').trim();
    if (cleaned && cleaned.toLowerCase() !== 'chatgpt') return cleaned;
    const firstUser = document.querySelector('[data-message-author-role="user"]');
    const text = normalizeText(firstUser?.innerText || '');
    return text ? text.slice(0, 100) : 'ChatGPT Conversation';
  }

  function extractConversation() {
    const nodes = Array.from(document.querySelectorAll(ROLE_SELECTOR));
    const turns = [];
    let pendingUser = null;
    let answers = [];
    let turnIndex = -1;

    const flush = () => {
      if (!pendingUser) return;
      turns.push({
        id: `turn-${turnIndex + 1}`,
        index: turnIndex,
        question: pendingUser,
        answers: answers.length ? answers : [{ role: 'assistant', text: '', markdown: '' }]
      });
      pendingUser = null;
      answers = [];
    };

    for (const node of nodes) {
      const message = messageFromNode(node);
      if (!message) continue;
      if (message.role === 'user') {
        flush();
        turnIndex += 1;
        pendingUser = message;
        answers = [];
      } else if (pendingUser) {
        answers.push(message);
      }
    }
    flush();

    return {
      title: getTitle(),
      url: location.href,
      exportedAt: new Date().toISOString(),
      turns
    };
  }

  function extractSingleTurn(assistantNode) {
    const nodes = Array.from(document.querySelectorAll(ROLE_SELECTOR));
    let lastUserNode = null;
    let userIndex = -1;

    for (const node of nodes) {
      const role = node.getAttribute('data-message-author-role');
      if (role === 'user') {
        lastUserNode = node;
        userIndex += 1;
      }
      if (node === assistantNode) {
        const question = messageFromNode(lastUserNode);
        const answer = messageFromNode(assistantNode);
        if (!question || !answer) throw new Error('Could not identify this question-and-answer pair.');
        return {
          title: getTitle(),
          url: location.href,
          exportedAt: new Date().toISOString(),
          turns: [{
            id: `turn-${userIndex + 1}`,
            index: userIndex,
            question,
            answers: [answer]
          }]
        };
      }
    }
    throw new Error('Could not locate this answer in the current conversation.');
  }

  function exportIconSvg(size = 18) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 3v11m0 0 4-4m-4 4-4-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M5 14.5V19a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
    </svg>`;
  }

  function findActionToolbar(assistantNode) {
    const article = assistantNode.closest('article') || assistantNode.parentElement?.closest('article') || assistantNode.parentElement;
    if (!article) return null;

    const buttons = Array.from(article.querySelectorAll('button')).filter(btn => !btn.classList.contains(EXPORT_BUTTON_CLASS));
    const copyButton = buttons.find(btn => {
      const testid = (btn.getAttribute('data-testid') || '').toLowerCase();
      const label = `${btn.getAttribute('aria-label') || ''} ${btn.getAttribute('title') || ''}`.toLowerCase();
      return testid.includes('copy') || /(^|\s)copy(\s|$)/.test(label) || label.includes('copy response');
    });
    if (!copyButton) return null;

    let current = copyButton.parentElement;
    let best = current;
    while (current && current !== article) {
      const count = current.querySelectorAll(':scope button').length || current.querySelectorAll('button').length;
      if (count >= 2 && count <= 12) best = current;
      if (current.querySelectorAll('button').length > 12) break;
      current = current.parentElement;
    }
    return { toolbar: best || copyButton.parentElement, templateButton: copyButton, article };
  }

  function createInlineExportButton(templateButton, assistantNode) {
    let button;
    if (templateButton) {
      button = templateButton.cloneNode(true);
      button.removeAttribute('id');
      Array.from(button.attributes).forEach(attr => {
        if (attr.name.startsWith('data-testid') || attr.name === 'data-state') button.removeAttribute(attr.name);
      });
      button.innerHTML = exportIconSvg(18);
    } else {
      button = document.createElement('button');
      button.type = 'button';
      button.innerHTML = exportIconSvg(18);
    }
    button.classList.add(EXPORT_BUTTON_CLASS);
    button.setAttribute('data-cgx-ui', 'true');
    button.setAttribute('aria-label', 'Export this question and answer');
    button.setAttribute('title', 'Export this question and answer');
    button.type = 'button';
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      showExportMenu(button, 'Export this Q&A', () => extractSingleTurn(assistantNode));
    });
    return button;
  }

  function decorateAnswers() {
    document.querySelectorAll(ASSISTANT_SELECTOR).forEach(assistantNode => {
      if (assistantNode.dataset.cgxExportDecorated === '1') return;

      const found = findActionToolbar(assistantNode);
      if (found?.toolbar) {
        if (!found.toolbar.querySelector(`.${EXPORT_BUTTON_CLASS}`)) {
          found.toolbar.appendChild(createInlineExportButton(found.templateButton, assistantNode));
        }
        assistantNode.dataset.cgxExportDecorated = '1';
        return;
      }

      // Fallback: create a small action row immediately below the assistant message.
      const container = assistantNode.closest('article') || assistantNode.parentElement;
      if (container && !container.querySelector(`:scope > .cgx-fallback-actions`)) {
        const fallback = document.createElement('div');
        fallback.className = 'cgx-fallback-actions';
        fallback.setAttribute('data-cgx-ui', 'true');
        fallback.appendChild(createInlineExportButton(null, assistantNode));
        container.appendChild(fallback);
        assistantNode.dataset.cgxExportDecorated = '1';
      }
    });
  }

  function findShareButton() {
    const directSelectors = [
      'button[data-testid="share-chat-button"]',
      '[data-testid="share-chat-button"] button',
      'button[aria-label="Share"]',
      'button[aria-label*="Share conversation" i]',
      'button[title="Share"]'
    ];
    for (const selector of directSelectors) {
      const candidate = document.querySelector(selector);
      if (candidate && visible(candidate) && !candidate.closest('article')) return candidate;
    }

    let best = null;
    let bestScore = -1;
    for (const button of document.querySelectorAll('button')) {
      if (!visible(button) || button.closest('article') || button.id === THREAD_BUTTON_ID || button.closest('[data-cgx-ui]')) continue;
      const rect = button.getBoundingClientRect();
      if (rect.top > 220) continue;
      const label = `${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''}`.trim();
      const text = normalizeText(button.innerText || '');
      const combined = `${label} ${text}`.toLowerCase();
      if (!combined.includes('share')) continue;
      let score = 10;
      if (/^share$/i.test(text)) score += 30;
      if (/^share$/i.test(label)) score += 25;
      if (rect.top < 120) score += 15;
      if (rect.left > innerWidth * 0.55) score += 10;
      if (score > bestScore) { best = button; bestScore = score; }
    }
    return best;
  }

  function createThreadExportButton(shareButton) {
    let button;
    if (shareButton) {
      button = shareButton.cloneNode(true);
      button.removeAttribute('id');
      Array.from(button.attributes).forEach(attr => {
        if (attr.name.startsWith('data-testid') || attr.name === 'data-state') button.removeAttribute(attr.name);
      });
      button.innerHTML = `${exportIconSvg(17)}<span class="cgx-thread-label">Export</span>`;
    } else {
      button = document.createElement('button');
      button.innerHTML = `${exportIconSvg(17)}<span>Export</span>`;
    }
    button.id = THREAD_BUTTON_ID;
    button.classList.add('cgx-thread-export-button');
    button.setAttribute('data-cgx-ui', 'true');
    button.setAttribute('aria-label', 'Export entire conversation');
    button.setAttribute('title', 'Export entire conversation');
    button.type = 'button';
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      showExportMenu(button, 'Export entire conversation', () => extractConversation());
    });
    return button;
  }

  function decorateThreadHeader() {
    if (document.getElementById(THREAD_BUTTON_ID)) return;
    const shareButton = findShareButton();
    if (!shareButton?.parentElement) return;
    const button = createThreadExportButton(shareButton);
    shareButton.insertAdjacentElement('afterend', button);
  }

  function closeMenu() {
    document.getElementById(MENU_ID)?.remove();
  }

  function positionMenu(menu, anchor) {
    const rect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const margin = 8;
    let left = rect.left;
    let top = rect.bottom + margin;

    if (left + menuRect.width > innerWidth - margin) left = innerWidth - menuRect.width - margin;
    if (left < margin) left = margin;
    if (top + menuRect.height > innerHeight - margin) top = Math.max(margin, rect.top - menuRect.height - margin);

    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }

  function formatIcon(format) {
    if (format === 'pdf') return '<span class="cgx-format-badge cgx-format-pdf">PDF</span>';
    if (format === 'docx') return '<span class="cgx-format-badge cgx-format-docx">W</span>';
    return '<span class="cgx-format-badge cgx-format-md">MD</span>';
  }

  function showExportMenu(anchor, heading, dataProvider) {
    closeMenu();

    const menu = document.createElement('div');
    menu.id = MENU_ID;
    menu.className = 'cgx-export-menu';
    menu.setAttribute('data-cgx-ui', 'true');
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `
      <div class="cgx-menu-heading">${heading}</div>
      <button type="button" data-format="pdf" role="menuitem">${formatIcon('pdf')}<span><strong>PDF document</strong><small>Professional A4 · opens Save as PDF</small></span></button>
      <button type="button" data-format="docx" role="menuitem">${formatIcon('docx')}<span><strong>Microsoft Word</strong><small>Editable .docx with header & page numbers</small></span></button>
      <button type="button" data-format="md" role="menuitem">${formatIcon('md')}<span><strong>Markdown</strong><small>Clean structured .md file</small></span></button>`;

    document.body.appendChild(menu);
    positionMenu(menu, anchor);

    menu.querySelectorAll('button[data-format]').forEach(button => {
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        const format = button.dataset.format;
        try {
          const data = dataProvider();
          if (!data?.turns?.length) throw new Error('No question-and-answer content was found.');
          if (format === 'pdf') exporter.exportPdf(data, data.turns);
          else if (format === 'docx') exporter.exportDocx(data, data.turns);
          else exporter.exportMarkdown(data, data.turns);
          closeMenu();
          showToast(format === 'pdf' ? 'Print view opened — choose Save as PDF.' : `Exported ${format === 'docx' ? 'Word document' : 'Markdown file'}.`);
        } catch (error) {
          closeMenu();
          showToast(error?.message || String(error), true);
        }
      });
    });

    requestAnimationFrame(() => {
      const outside = event => {
        if (!menu.contains(event.target) && event.target !== anchor && !anchor.contains(event.target)) {
          closeMenu();
          document.removeEventListener('pointerdown', outside, true);
        }
      };
      document.addEventListener('pointerdown', outside, true);
      window.addEventListener('scroll', closeMenu, { once: true, capture: true });
      window.addEventListener('resize', closeMenu, { once: true });
    });
  }

  function showToast(message, error = false) {
    document.querySelector('.cgx-toast')?.remove();
    const toast = document.createElement('div');
    toast.className = `cgx-toast${error ? ' cgx-toast-error' : ''}`;
    toast.setAttribute('data-cgx-ui', 'true');
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('cgx-toast-visible'));
    setTimeout(() => {
      toast.classList.remove('cgx-toast-visible');
      setTimeout(() => toast.remove(), 180);
    }, 3200);
  }

  let decorateTimer = null;
  function scheduleDecorate() {
    clearTimeout(decorateTimer);
    decorateTimer = setTimeout(() => {
      decorateAnswers();
      decorateThreadHeader();
    }, 180);
  }

  const observer = new MutationObserver(scheduleDecorate);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener('popstate', scheduleDecorate);
  window.addEventListener('hashchange', scheduleDecorate);
  scheduleDecorate();

  // Keep popup compatibility / fallback export UI.
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request?.type !== 'CHATGPT_EXPORTER_EXTRACT') return;
    try {
      sendResponse({ ok: true, ...extractConversation() });
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  });
})();
