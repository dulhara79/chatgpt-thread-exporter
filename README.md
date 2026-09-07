# AI Thread Exporter (V0.6.4)

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
- The exporter may fetch media already displayed in the conversation and assistant-generated text files from
  safe ChatGPT/OpenAI URLs already present in the page so their contents can be embedded. It does not discover
  or call hidden internal APIs. Image embedding can be disabled in Settings.

## Install (unpacked)

```bash
git clone https://github.com/dulhara79/chatgpt-thread-exporter.git
cd chatgpt-thread-exporter
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

- **Both platforms window long conversations** and fetch older messages lazily. The exporter scrolls the
  whole thread into memory first, waiting for each lazily loaded page. If it still cannot reach the top it
  tells you how many turns it captured and marks the export *partial* — it never truncates silently.
  Very long threads take a few seconds; the progress line shows the running turn count.
- **Claude artifacts** live in a side panel. The exporter captures each artifact while its message is still
  mounted, before Claude's virtualized conversation can detach the card. Capture diagnostics report detached
  cards, missing panels and panel-change failures. If an artifact cannot be opened, the document says so rather
  than silently dropping it.
- **PDFs are not tagged.** There is no structure tree, no reading order and no alt text in the PDF output,
  so it is not PDF/UA or PDF/A conformant. Word output is better for accessibility. Fixing this properly
  means replacing pdfmake.
- **Emoji render monochrome** in PDF. Variation selectors and ZWJ shaping controls are removed from the PDF
  glyph stream because pdfmake can render them as blank boxes; the base emoji remain. Complex joined emoji may
  therefore appear as adjacent monochrome emoji rather than one colour glyph.
- **Syntax highlighting** is not implemented. Code blocks are monospaced and shaded but not coloured.
- **Response branches.** If you have regenerated an answer, only the variant currently displayed is exported.
- **File attachments.** Text-like files (`.py`, `.md`, `.html`, `.patch`, `.json`, ...) are captured from
  both user questions and assistant-generated download cards when the page exposes readable content or a safe
  local/OpenAI file URL. Archives and binaries (`.zip`, `.tar.gz`, `.png`, `.docx`) are recorded by name only
  when their bytes are not exposed by the rendered page.
- **Site DOM is not a public API.** The automated browser suite uses committed redacted fixtures, not live
  authenticated conversations. Settings → **Generate report** now includes artifact capture diagnostics so a
  site change can be identified without exporting private content.

## Development

```bash
npm install
npm test              # every suite
npm run test:unit     # fast suites, no browser needed
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
| `tests/reported-issues.test.js` | Regressions reported from real-world use |
| `tests/font-coverage.test.js` | Reads the bundled font cmaps so no character is routed to a font lacking its glyph |
| `tests/pdf-font-smoke.test.js` | Renders a real multi-script PDF with the bundled fonts |
| `tests/browser-extension-smoke.mjs` | Loads the extension in real Chrome against redacted fixture DOM and exercises artifact capture |

Behaviour tests assert on **structure**, not on source strings. Grep-style assertions live only in
`architecture-guards` and only where nothing observable can express the invariant.

To verify Claude's selectors against a live thread, run the snippet in the header comment of
`src/platforms/claude.js` in DevTools.

## Licence

MIT. Bundled Noto fonts are licensed under the SIL Open Font License; pdfmake under MIT.
See `vendor/` for the full texts.
