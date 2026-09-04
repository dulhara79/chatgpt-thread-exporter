# ChatGPT Thread Exporter — V0.3.1

A local-only Chrome Manifest V3 extension for exporting ChatGPT conversations to professional PDF, Microsoft Word (`.docx`), and Markdown.

## V0.3.1 highlights

- Export one Q&A or the complete rendered conversation.
- Every assistant answer gets a self-healing download/export control. If ChatGPT React re-renders an action row and removes the control, the extension inserts it again.
- Conversation-level **Export** is inserted immediately to the **left of Share** when Share is discoverable, with a deterministic same-header fallback. The control is extension-owned rather than cloned from ChatGPT, so disabled/hidden Share state cannot block it.
- No visible **Scope / Source / Exported** metadata table in generated documents.
- Ordered lists preserve their actual sequence and start values instead of becoming `1, 1, 1...`.
- Word uses native OOXML numbering definitions.
- Meaningful images are retained while favicons, avatars, toolbar icons, and tiny decorative assets are filtered.
- Content-bearing SVG diagrams are preserved. PDF renders them directly; Word rasterizes rendered SVG diagrams locally before embedding them.
- PDF renders meaningful images at document-safe sizes; Word embeds fetchable PNG/JPEG/GIF/WebP images and degrades to a useful link when embedding is unavailable.
- Common KaTeX/MathJax structures are recovered as TeX where available. Markdown keeps TeX notation, PDF presents readable math, and Word keeps a readable equation fallback.
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

Uses Chromium's native print pipeline. The generated print document has professional margins, semantic lists, tables, code, images, math treatment, and multilingual font fallbacks. Choose **Save as PDF** in the browser print dialog.

### Word (.docx)

Creates a genuine OOXML package with page geometry, styles, native numbering, tables, hyperlinks, headers/footers, Unicode text, and image relationships.

### Markdown

Produces clean semantic Markdown without the old metadata table. Lists, headings, code fences, links, tables, meaningful image references, and TeX are retained where representable.

## Privacy

- No backend.
- No analytics or telemetry.
- No API key.
- No ChatGPT credentials.
- No undocumented ChatGPT API.
- Conversation processing and document generation stay in the browser.
- Permissions remain limited to `activeTab` and ChatGPT host access.

The extension intentionally does not request broad host permissions solely to improve rare cross-origin image cases.

## Install

1. Clone or download the repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the folder containing `manifest.json`.
6. Open or refresh a conversation on `https://chatgpt.com/`.

## Development

Node.js 20+:

```bash
npm test
npm run check
```

The regression suite covers metadata removal, ordered list sequence, A4/Letter/Legal, favicon filtering, multilingual Unicode/emoji, TeX preservation, and DOCX numbering/page geometry.

GitHub Actions runs the same checks on pull requests to `main`.

## Known limitations

- PDF intentionally relies on the browser print dialog.
- Cross-origin images that cannot be fetched are preserved through useful fallback semantics instead of failing the whole export.
- Word equations currently use a readable text/math-font fallback rather than native OMML conversion.
- Interactive ChatGPT widgets may simplify to document-friendly text/links.
- Only content currently rendered in the ChatGPT DOM can be exported.

## Architecture/design

The approved V0.3 design is documented at:

`docs/superpowers/specs/2026-09-04-professional-export-rendering-design.md`

## Version

V0.3.1
