# AI Thread Exporter (V0.6.0)

Export a **ChatGPT** or **Claude** conversation — the whole thread, a range, or a single
question-and-answer pair — to a properly structured **PDF**, **Word (.docx)** or **Markdown**
document. Everything runs locally in your browser.

---

## What it does

- **Per-answer export.** An **Export** button sits at the end of every completed answer.
- **Whole-thread export.** An **Export chat** button sits in the conversation header.
- **Range export.** Shift-click two or more per-answer buttons to select a span, then export just those turns.
- **Three formats.** PDF (print-ready, selectable text), Word (.docx, editable), Markdown (.md). Plus copy-to-clipboard.
- **Real document structure.** Nested lists stay nested. Code inside a numbered step stays inside that step.
  Tables keep their column alignment and repeat their header row across pages. Threads of four or more turns
  get a table of contents.
- **Scripts and symbols.** Sinhala, Tamil, Korean, mathematics (KaTeX → OMML in Word) and box-drawing
  diagrams render with bundled fonts, so a PDF opens the same on any machine.

## Privacy

- No servers, no analytics, no account. Conversation content never leaves your browser.
- No `debugger` permission, no page screenshots, no reading of the sites' internal APIs.
- Rendering happens in a local MV3 offscreen document; downloads always go through a **Save As** dialog
  so you choose the destination.
- The only network requests are to fetch images that are already displayed in the conversation you are exporting,
  so they can be embedded in the Word file. Turn this off in Settings.

## Install (unpacked)

```bash
git clone https://github.com/dulhara79/ai-thread-exporter.git
cd ai-thread-exporter
```

Then open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the folder.
Requires Chrome 116 or later.

## Architecture

```
manifest.json (MV3)
│
├── content scripts (chatgpt.com, chat.openai.com, claude.ai)
│   ├── src/platforms/    adapter.js · chatgpt.js · claude.js · registry.js
│   │                     The ONLY place any site-specific selector may appear.
│   ├── src/ir/           parse.js · extract.js · markdown.js · pdf.js · docx.js
│   │                     DOM ─▶ IR ─┬─▶ Markdown
│   │                                ├─▶ pdfmake definition
│   │                                └─▶ WordprocessingML
│   ├── exporter.js       naming, DOCX package, ZIP writer, PDF transport
│   └── content.js        shadow-DOM controls, export menu, scheduling
│
├── background.js         service worker: offscreen lifecycle, alarm watchdog, downloads
└── pdf-worker.html/js    offscreen document: pdfmake, lazy Unicode font VFS, Blob ownership
```

Two design decisions carry most of the weight:

**A platform adapter layer.** Adding a third platform means writing one file in `src/platforms/`.
Selectors are declared as ordered candidate tiers — a stable test id first, a semantic class second,
a structural heuristic last — so a site redesign degrades one tier at a time instead of breaking outright.
Settings → **Generate report** tells you which tier is currently matching.

**An intermediate representation.** Content goes `DOM → IR → format`. It does *not* go through a
Markdown string, because Markdown is flat text and every nesting relationship dies at that hop.
Markdown is an output format here, not a transport.

## Known limitations

Stated plainly, because these matter more than feature lists:

- **Claude virtualizes long conversations.** Only part of a long thread is in the page at any time.
  The exporter scrolls the thread to gather it, but if it cannot reach the top it tells you how many
  turns it got and marks the export *partial*. Scroll to the top yourself and retry for a complete export.
- **Claude artifacts** live in a side panel, not in the message. Open the artifact panel before exporting
  to capture its content; otherwise a placeholder is written in its place.
- **PDFs are not tagged.** There is no structure tree, no reading order and no alt text in the PDF output,
  so it is not PDF/UA or PDF/A conformant. Word output is better for accessibility. Fixing this properly
  means replacing pdfmake.
- **Emoji render monochrome** in PDF. The bundled emoji font is the monochrome flavour; colour emoji need
  font formats pdfmake cannot embed.
- **Syntax highlighting** is not implemented. Code blocks are monospaced and shaded but not coloured.
- **Response branches.** If you have regenerated an answer, only the variant currently displayed is exported.
- **Selectors are unverified against the live sites** in this release. They are derived from public tooling and
  fixture DOM. Verify with Settings → **Generate report** and open an issue if a tier-1 selector is missing.

## Development

```bash
npm install
npm test              # unit + DOM tests (68)
npm run test:dom      # adapters and DOM extraction only
npm run version:check # fail on manifest/package/README drift
npm run build         # dist/ai-thread-exporter-<version>.zip
```

The suite is deliberately split:

| File | Covers |
| :--- | :--- |
| `tests/ir-parse.test.js` | Markdown → IR: nesting, tables, emphasis, math, fences |
| `tests/adapters.test.js` | Both adapters against fixture DOM in jsdom |
| `tests/renderers.test.js` | IR → PDF definition and IR → real .docx package |
| `tests/architecture-guards.test.js` | Invariants not observable from output (permissions, coupling) |
| `tests/pdf-font-smoke.test.js` | Renders a real multi-script PDF with the bundled fonts |
| `tests/browser-extension-smoke.mjs` | Loads the extension in real Chrome; selector canary |

Behaviour tests assert on **structure**, not on source strings. Grep-style assertions live only in
`architecture-guards` and only where nothing observable can express the invariant.

To verify Claude's selectors against a live thread, run the snippet in the header comment of
`src/platforms/claude.js` in DevTools.

## Licence

MIT. Bundled Noto fonts are licensed under the SIL Open Font License; pdfmake under MIT.
See `vendor/` for the full texts.
