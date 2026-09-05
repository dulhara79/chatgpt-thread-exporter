# ChatGPT Thread Exporter — V0.3.8

A local-only Chrome Manifest V3 extension for exporting ChatGPT conversations to professional PDF, Microsoft Word (`.docx`), and Markdown.

## V0.3.8 highlights

- **Long-thread PDF generation is now chunked by Q&A/answer blocks** instead of rasterizing the entire conversation into one giant canvas. This keeps memory bounded and substantially reduces export time for large conversations.
- **PDF export now uses a hidden offscreen vector renderer**. It no longer uses `chrome.debugger`, `Page.printToPDF`, temporary render tabs, html2canvas, or whole-page screenshots.
- PDF, Word, and Markdown actions now use consistent professional SVG document icons instead of text-letter badges.
- Export one Q&A or the complete rendered conversation.
- Every assistant answer gets a self-healing download/export control. If ChatGPT React re-renders an action row and removes the control, the extension inserts it again.
- Conversation-level **Export** is inserted immediately to the **left of Share** when Share is discoverable, with a deterministic same-header fallback. The control is extension-owned rather than cloned from ChatGPT, so disabled/hidden Share state cannot block it.
- No visible **Scope / Source / Exported** metadata table in generated documents.
- Ordered lists preserve their actual sequence and start values instead of becoming `1, 1, 1...`.
- Word uses native OOXML numbering definitions.
- Meaningful images are retained while favicons, avatars, toolbar icons, and tiny decorative assets are filtered.
- Content-bearing SVG diagrams are preserved. PDF renders them directly; Word rasterizes rendered SVG diagrams locally before embedding them.
- PDF renders meaningful images at document-safe sizes; Word embeds fetchable PNG/JPEG/GIF/WebP images and degrades to a useful link when embedding is unavailable.
- Common KaTeX/MathJax structures are recovered as TeX where available. PDF converts supported LaTeX structures to native MathML, while Word writes native OMML equations for fractions, roots, powers/subscripts, Greek symbols, sums/integrals, matrices, and common operators. Markdown keeps the original TeX notation.
- Unicode-first export supports Sinhala, English, Tamil, Korean, mathematical symbols, combining text, and emoji subject to fonts installed on the user's system.
- **A4 is the default** page size; **Letter** and **Legal** are selectable for PDF and Word.
- PDF, Word, and Markdown share a restrained professional information hierarchy with 10.5 pt body text, 23 pt document titles, navy/slate headings, subtle rules, Aptos/Segoe UI/Nirmala UI fallbacks, Cascadia Mono/Consolas code, and print-safe spacing.

## Document design

V0.3 uses an original print-first palette rather than copying ChatGPT/OpenAI trade dress:

- Primary navy: `#17365D`
- Secondary slate: `#475569`
- Body: `#1F2937`
- Muted: `#64748B`
- Border: `#D9E2EC`
- Question surface: `#F5F8FC`
- Code surface: `#F3F4F6`

The design prioritizes clear title, Question/Answer hierarchy, readable tables, code, lists, images, and print-safe spacing.

## Export one Q&A

Each assistant answer gets an Export control in its action row. It exports exactly the immediately preceding user question and that selected answer.

## Export the whole conversation

Use the **Export** control beside the conversation header Share action. The extension popup remains available as a fallback and supports manual selection of multiple Q&A turns.

## Formats

### PDF

PDFs are generated locally inside an MV3 offscreen document using a bundled browser-side vector PDF engine. Normal text, lists, tables, headings, code, rules, and document structure are emitted semantically; complex-script fallback is rasterized only at the individual paragraph/element level so the extension never screenshots the full page or full conversation. The worker returns a Blob URL to the service worker, which immediately opens Chrome's native **Save As** dialog with `saveAs: true`; the suggested filename is the conversation title and A4 remains the default page size.

### Word (.docx)

Creates a genuine OOXML package with page geometry, styles, native numbering, tables, hyperlinks, headers/footers, Unicode text, image relationships, and native OMML equations.

### Markdown

Produces clean semantic Markdown without the old metadata table. Lists, headings, code fences, links, tables, meaningful image references, and TeX are retained where representable.

## Privacy

- No backend.
- No analytics or telemetry.
- No API key.
- No ChatGPT credentials.
- No undocumented ChatGPT API.
- Conversation processing and document generation stay in the browser.
- PDF generation requires only `activeTab`, `downloads`, and `offscreen`. There is no `debugger` permission and no PDF render tab.

The extension intentionally does not request broad host permissions solely to improve rare cross-origin image cases.

## Install

1. Clone or download the repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the folder containing `manifest.json`.
6. Open or refresh a conversation on `https://chatgpt.com/`.

## Development

Node.js 24+:

```bash
npm test
npm run check
```

The regression suite covers metadata removal, ordered list sequence, A4/Letter/Legal, favicon filtering, multilingual Unicode/emoji, TeX preservation, DOCX numbering/page geometry, and guards that enforce the debugger-free offscreen vector PDF path, repeat-safe export menu lifecycle, and prevent reintroducing whole-document raster export.

GitHub Actions runs the same checks on pull requests to `main`.

## Known limitations

- Cross-origin images that cannot be fetched are preserved through useful fallback semantics instead of failing the whole export.
- The built-in LaTeX parser covers common mathematical structures; uncommon custom TeX macros may fall back to readable equation text.
- Interactive ChatGPT widgets may simplify to document-friendly text/links.
- Only content currently rendered in the ChatGPT DOM can be exported.

## Architecture/design

The approved V0.3 design is documented at:

`docs/superpowers/specs/2026-09-04-professional-export-rendering-design.md`

## Third-party component

V0.3.8 bundles pdfmake 0.2.20 and its Roboto virtual font files for local PDF generation. html2pdf.js/html2canvas are not used for PDF export.

## Version

V0.3.3
