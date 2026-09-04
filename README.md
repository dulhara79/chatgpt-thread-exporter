# ChatGPT Thread Exporter — V0.2

A local-only Chrome Manifest V3 extension for exporting ChatGPT conversations to professional documents.

## Main interaction

### Export one Q&A
An **Export** icon is injected into the action row below every ChatGPT answer, alongside the normal answer controls. Click it and choose:

- **PDF document** — professional A4 print layout; Chrome opens the print view so you can choose **Save as PDF**.
- **Microsoft Word (.docx)** — editable genuine OOXML Word document.
- **Markdown (.md)** — clean structured Markdown.

That export contains only the user question immediately preceding the selected answer and that specific ChatGPT answer.

### Export the whole conversation
An **Export** button is injected next to ChatGPT's conversation-level **Share** button. Click it and choose PDF, Word, or Markdown to export the complete current thread.

The extension popup is retained as a fallback and also allows selecting multiple Q&A turns manually.

## Document quality

V0.2 uses a restrained business / technical-document design instead of copying the ChatGPT web UI.

### PDF
- A4 page size and controlled print margins
- document title and metadata block
- numbered question sections
- visually separated question and answer hierarchy
- print-safe typography and spacing
- code blocks, lists, block quotes, hyperlinks and Markdown tables
- print footer with exporter name and page numbering where supported by Chromium paged-media CSS
- Unicode-friendly browser rendering for Sinhala, Korean and other scripts

### Word (.docx)
- genuine Microsoft OOXML package, not renamed HTML
- A4 layout
- title and metadata table
- document header
- footer with `Page X of Y` Word fields
- structured heading styles
- shaded question panels
- answer section labels
- Word tables for Markdown tables
- code styling
- native clickable hyperlinks
- Unicode content
- fields marked for refresh when the document is opened

### Markdown
- clean title and metadata
- explicit question / answer sections
- original Markdown structure retained where possible
- source conversation URL and export timestamp

## Privacy

- No backend.
- No analytics.
- No API key.
- No ChatGPT credentials are collected.
- The extension reads only content already rendered in the active ChatGPT page.
- File generation happens locally in the browser.
- Required Chrome permission: `activeTab`, plus host access to ChatGPT pages.

## Install

1. Extract the ZIP to a permanent folder.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the extracted folder containing `manifest.json`.
6. Open or refresh a conversation on `https://chatgpt.com/`.

After refresh you should see:

- a small export/download icon below each ChatGPT answer; and
- an **Export** button beside the conversation **Share** button.

## Files

- `manifest.json` — Chrome Manifest V3 configuration
- `exporter.js` — shared Markdown, DOCX and PDF/print document engine
- `content.js` — ChatGPT DOM extraction and in-page UI injection
- `content.css` — in-page export menus and status UI
- `popup.html` / `popup.js` — fallback multi-turn selection interface

## Resilience to ChatGPT UI changes

The extension does not use private ChatGPT APIs. It primarily identifies messages using ChatGPT's rendered `data-message-author-role="user"` and `data-message-author-role="assistant"` attributes.

For the action rows and Share button, V0.2 uses multiple selectors plus accessible-label heuristics. A `MutationObserver` automatically re-injects controls when ChatGPT changes routes or lazily renders conversation content.

If OpenAI changes the DOM substantially in the future, the repair should normally be limited to the selector / toolbar-detection functions in `content.js`.

## Current limitations

- PDF deliberately uses Chromium's native print pipeline rather than the high-risk debugger permission; choose **Save as PDF** in the print dialog.
- Images and interactive ChatGPT widgets are not embedded as binary assets yet. Image references/alt text may be represented in Markdown where available.
- Math is exported from the rendered text/DOM; Word does not yet create native OMML equations.
- Extremely complex nested HTML tables or interactive components may simplify during export.

## Version

V0.2.0
