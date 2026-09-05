# ChatGPT Thread Exporter — V0.5.1

A local-only Chrome Manifest V3 extension for exporting ChatGPT conversations to professional PDF, Microsoft Word (`.docx`), and Markdown.

## V0.5.1 highlights

- **PDF reliability is redesigned around an offscreen-owned render lifecycle.** The service worker is now a stateless offscreen/download bridge, a Chrome alarm hard-resets stuck pdfmake work, and the heavy PDF definition crosses runtime messaging only once. The selectable Unicode/diagram behavior from V0.3.9 is preserved.
- PDF, Word, and Markdown actions now use consistent professional SVG document icons instead of text-letter badges.
- Export one Q&A or the complete rendered conversation.
- Every assistant answer gets a self-healing download/export control. If ChatGPT React re-renders an action row and removes the control, the extension inserts it again.
- Conversation-level **Export** is inserted immediately to the **left of Share** when Share is discoverable, with a deterministic same-header fallback. The control is extension-owned rather than cloned from ChatGPT, so disabled/hidden Share state cannot block it.
- No visible **Scope / Source / Exported** metadata table in generated documents.
- Ordered lists preserve their actual sequence and start values instead of becoming `1, 1, 1...`.
- Word uses native OOXML numbering definitions.
- Meaningful images are retained while favicons, avatars, toolbar icons, and tiny decorative assets are filtered.
- Character/ASCII diagrams are preserved as exact no-wrap monospace PDF text. Supported SVG diagrams stay vector; only unsupported SVG graphics are rasterized.
- PDF embeds data images and fetchable ChatGPT/OpenAI-hosted HTTPS images at document-safe sizes, with alt/link fallback when an external image cannot be fetched. Word behavior is unchanged.
- Common KaTeX/MathJax structures are recovered as TeX where available. PDF keeps mathematical content selectable instead of rasterizing the containing paragraph; Word writes native OMML for supported structures and Markdown keeps TeX.
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

PDFs are generated locally inside an MV3 offscreen document using a bundled browser-side vector PDF engine. Text is split into script-aware runs and mapped to bundled fonts; code and character diagrams use a dedicated monospace no-wrap path, so ordinary content remains selectable/copyable. Supported SVG stays vector, while only unsupported graphical SVG assets may be rasterized. The offscreen renderer owns each PDF job and Blob URL. The service worker is a stateless offscreen/download bridge, with a browser-alarm watchdog that destroys a stuck renderer. Chrome then opens native **Save As** with `saveAs: true`; the suggested filename is the conversation title and A4 remains the default page size.

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

The extension does not request broad all-site access. It includes narrow ChatGPT/OpenAI asset-host permissions so ChatGPT-hosted images can be embedded; unrelated external images still degrade safely when cross-origin access is unavailable.

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

The regression suite covers renderer ownership, durable watchdog/reset behavior, payload preflight, selectable multilingual font runs, the exact clinician architecture diagram, image/SVG handling, A4/Letter/Legal, DOCX behavior, and guards against debugger/tab/html2canvas or textual raster fallbacks. CI also loads the unpacked extension in real Chromium and verifies that the actual MV3 offscreen pdfmake path produces a `%PDF` Blob.

GitHub Actions runs the same checks on pull requests to `main`.

## Known limitations

- Cross-origin images that cannot be fetched are preserved through useful fallback semantics instead of failing the whole export.
- The built-in LaTeX parser covers common mathematical structures; uncommon custom TeX macros may fall back to readable equation text.
- Interactive ChatGPT widgets may simplify to document-friendly text/links.
- Only content currently rendered in the ChatGPT DOM can be exported.

## Architecture/design

The approved V0.3 design is documented at:

`docs/superpowers/specs/2026-09-05-v050-renderer-owned-pdf-reliability-design.md`

## Third-party component

V0.5.1 bundles pdfmake 0.2.20 plus local open-source Noto fonts for Sinhala, Tamil, Korean, symbols/emoji, and monospace text. html2pdf.js/html2canvas are not used for PDF export.

## Version

V0.5.1
