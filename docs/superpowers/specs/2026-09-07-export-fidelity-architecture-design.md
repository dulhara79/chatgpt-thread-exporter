# Export Fidelity Architecture — Design Specification

**Date:** 2026-09-07  
**Repository:** `dulhara79/chatgpt-thread-exporter`  
**Branch:** `fix/export-fidelity-architecture`  
**Base:** `main` at `94c48a8975acef969d0cb9dec2c2a2fc6e969bd5`

## 1. Purpose

Fix the remaining export-fidelity failures identified in the full `main` audit and confirmed through real exported files:

- Claude artifact bodies can disappear while ordinary question/answer text remains.
- Claude artifact capture can select sidebar/navigation chrome or reject legitimate artifact content.
- Markdown/text attachment cards can be exported without their actual file content.
- Emoji and some symbols can become empty square glyphs in PDF.
- PDF code wrapping currently alters selectable source text with continuation characters.
- Long pasted questions can create unsafe unbreakable PDF layout.
- Diagnostics and tests do not currently reveal or prevent the above regressions.

The design keeps the existing privacy boundary: no debugger permission, no remote export service, no internal Claude/ChatGPT APIs, and no broad host permission.

## 2. Success criteria

The change is complete only when all of the following are true:

1. A Claude artifact present in a single Q&A export includes its full captured body.
2. The same artifact survives whole-thread virtualized export with equivalent IR.
3. Multiple Claude artifacts remain associated with the correct card/body.
4. Claude sidebar/navigation text is never exported as artifact content.
5. Legitimate artifacts containing words such as "Projects", "Artifacts", "Pinned", or "Scheduled" are not falsely rejected.
6. Markdown attachments include their actual accessible contents, not just a card/title.
7. Text/source attachments preserve complete readable text and code indentation.
8. Archive/binary attachments are identified in place without inventing contents.
9. PDF/DOCX/Markdown receive the same semantic artifact/attachment content.
10. Emoji/symbols do not render as blank boxes when a bundled glyph or readable textual fallback is available.
11. PDF code remains text-faithful: no synthetic continuation characters are inserted into copied source.
12. Long questions can span pages safely.
13. Diagnostics state whether artifacts/attachments were found, captured, skipped, or failed, with reasons.
14. A real-Chrome fixture smoke test exercises artifact interaction/capture, not merely Q&A discovery.
15. Version and documentation are updated for the changed behavior.

## 3. Architectural change: harvest immutable export data while DOM is live

### Current problem

Whole-thread harvesting retains DOM references and scrolls through virtualized content. Claude can detach older message subtrees. Later, artifact capture attempts to click those retained detached buttons. Static Q&A text survives because it is readable from the detached subtree, but the click no longer reliably drives Claude's live artifact panel.

### New model

Harvest each currently mounted message into immutable export data before scrolling away.

Conceptual data structure:

```js
{
  key,
  role,
  blocks,
  artifacts: [
    {
      title,
      kind,
      blocks,
      status,
      diagnostic
    }
  ],
  attachments: [
    {
      name,
      kind,
      blocks,
      status,
      diagnostic
    }
  ]
}
```

The harvesting loop becomes:

```text
mounted virtualized window
        ↓
extract message body to IR
        ↓
capture pasted/text attachments while accessible
        ↓
open/capture Claude artifacts while card is connected
        ↓
store immutable harvested record
        ↓
scroll upward
```

No later renderer step may require interaction with the old page DOM.

## 4. Platform adapter contract

The shared adapter layer will support a mounted-message capture hook instead of only returning DOM nodes.

A platform adapter may provide an async enrichment function that returns immutable extras for a live message. The shared harvesting layer will call this before allowing the virtualizer to unmount the message.

The shared layer remains responsible for:

- ordered harvesting,
- stable identities,
- merging overlapping virtual windows,
- grouping user/assistant records into turns.

The Claude adapter remains responsible for:

- artifact-card discovery,
- artifact-panel correlation,
- pasted-content expansion,
- Claude-specific attachment metadata,
- artifact capture diagnostics.

The ChatGPT adapter can use the same immutable record shape without Claude-specific artifact logic.

## 5. Stable harvest identity

The existing 32-bit hash of the first 400 characters is insufficient for repeated messages.

Identity priority:

1. platform-provided message ID;
2. stable DOM ID/data attribute;
3. cryptographic or substantially stronger digest of role + normalized full message text + local occurrence context.

Repeated prompts such as `Continue` must remain distinct records.

The shared merge logic will not overwrite distinct messages solely because their visible text matches.

## 6. Claude artifact-card discovery

Artifact-card detection will use scored evidence instead of requiring literal "artifact" wording.

Positive evidence can include:

- known stable test IDs;
- interactive role/button semantics;
- artifact/document/code metadata;
- artifact/file icon semantics;
- placement inside an assistant response;
- known artifact-card classes;
- click behavior that changes the artifact panel.

A broad class selector may contribute evidence but cannot independently prove a card is an artifact.

The detector must support a title-only interactive card where the title contains no literal `artifact` or `Document`.

## 7. Artifact-panel correlation

Artifact capture will correlate the clicked card to a panel state change.

Before clicking:

- record existing candidate panel identity/signature;
- record active artifact markers if present.

After clicking, wait for one of:

- a new verified artifact content root;
- a changed artifact content signature;
- a changed active artifact identifier/title;
- a semantic `aria-controls` / expanded relation.

A stale previous artifact panel is not acceptable as the current card's result.

Each artifact snapshot is taken only after correlation succeeds.

## 8. Claude chrome rejection

Sidebar/navigation rejection will be structural, not document-vocabulary driven.

Hard rejection includes:

- `nav`;
- `role=navigation`;
- known sidebar/left-rail/chat-list ancestry;
- conversation-list structures;
- strong layout markers identifying application chrome.

Words such as:

- Projects
- Artifacts
- Scheduled
- Customize
- Pinned

must not hard-reject otherwise valid artifact content.

Text vocabulary may contribute only weak negative evidence when structural evidence is ambiguous.

## 9. Artifact content extraction

Once a verified content root is found, snapshot only the content-bearing subtree.

Supported forms:

- normal structured DOM;
- `pre` / code editor content;
- same-origin iframe body;
- accessible shadow-root content;
- canvas converted to a local PNG image when readable content is graphical;
- SVG/image content already rendered in the artifact.

Toolbars, close buttons, navigation controls, and unrelated panel chrome are excluded.

If a sandboxed/cross-origin iframe cannot be read under current permissions, export a clear artifact placeholder containing the title/type and failure reason rather than silently omitting the artifact.

## 10. Markdown/text/source attachment capture

### Inline content

When the attachment card already exposes readable text in DOM, snapshot it while the message is live.

### Accessible attachment URL

When a text-like attachment does not expose its body inline but exposes an accessible same-origin/allowed URL, the exporter may fetch that content locally in the browser.

Supported text-like categories include:

- `.md`, `.markdown`;
- `.txt`;
- source-code extensions;
- JSON/YAML/XML;
- patch/diff;
- HTML/CSS/SQL and similar textual formats.

The fetch must:

- use a bounded timeout;
- enforce a maximum byte size;
- accept only text-like MIME/extensions;
- avoid broad new host permissions;
- preserve privacy by keeping processing local.

### Markdown semantics

Markdown file contents are parsed through the existing Markdown-to-IR parser, preserving:

- headings;
- paragraphs;
- lists;
- fenced code;
- tables;
- emphasis;
- links where supported.

### Source/text semantics

Non-Markdown text/source files remain code/preformatted IR with inferred language where appropriate.

### Archives/binaries

`.zip`, `.tar`, `.tar.gz`, `.tgz`, `.7z` and other binary bundles remain explicit metadata entries. Their internal bytes are not invented or implied to have been extracted.

## 11. Attachment/artifact failure policy

No supported item may disappear silently.

Every discovered item ends in one status:

- captured;
- metadata-only;
- inaccessible;
- too-large;
- unsupported-binary;
- timed-out;
- detached-before-capture;
- panel-not-found;
- panel-correlation-failed.

The exported document includes a concise human-readable marker only when content cannot be captured.

Diagnostics retain the machine-readable reason.

## 12. Emoji and symbol rendering

### Problem

A routed PDF font can lack a requested glyph, resulting in an empty square.

### Design

Use measured bundled-font coverage as the source of truth.

For each Unicode code point/run:

1. choose a bundled font known to contain the glyph;
2. for variation selectors/ZWJ, keep cluster routing coherent where possible;
3. if no bundled font covers the character, emit a readable fallback representation rather than an empty square.

Fallback priority:

- supported base emoji/text presentation if available;
- Unicode replacement annotation such as `[U+1FAE0]` only for truly unsupported characters.

Box-drawing characters must continue to use the font proven by cmap tests to contain them.

Tests will validate actual cmap coverage for representative emoji, arrows, symbols, Sinhala, Tamil, Korean, and diagram characters.

## 13. Code fidelity

PDF code wrapping must not change the original code string.

Remove synthetic continuation characters `↴` and `↳` from the selectable source.

Preferred rendering strategy:

- preserve original text;
- allow layout wrapping without adding source characters;
- reduce font within the existing legibility limit when needed;
- rotate/landscape diagrams where applicable.

Markdown and DOCX already preserve source text and remain unchanged unless tests reveal a regression.

## 14. Long-question pagination

The current entire question box cannot remain globally `unbreakable`.

New behavior:

- keep the question label with the first content block;
- permit the body to paginate;
- retain the visual question styling across page boundaries as closely as pdfmake supports;
- prevent a single huge pasted prompt from failing layout.

## 15. Diagnostics

Diagnostics will expose effective settings and content-capture state.

Example:

```json
{
  "effectiveSettings": {
    "includeArtifacts": true,
    "includeThinking": false
  },
  "artifacts": {
    "cardsFound": 3,
    "connected": 3,
    "captured": 2,
    "failed": 1,
    "failures": [
      {
        "title": "Demo",
        "reason": "panel-correlation-failed"
      }
    ]
  },
  "attachments": {
    "found": 2,
    "captured": 2
  }
}
```

The diagnostics page remains local and user-copyable.

## 16. Popup extraction behavior

The popup should avoid performing the most expensive full enrichment merely to show the turn selector.

Introduce a lightweight conversation metadata/read path for:

- title;
- turn IDs;
- short question/answer previews.

Full mounted-content harvesting/enrichment runs when the user actually exports.

Per-answer in-page export can directly capture its live message.

## 17. Renderer parity

The IR remains the single source of truth.

Every captured artifact/attachment must be verified across:

- Markdown;
- PDF definition;
- DOCX XML/package.

Renderer tests compare semantic text presence and structural block type, not only implementation strings.

## 18. Tests

### Failing regressions first

Before implementation, add tests for:

1. detached Claude artifact card after virtualization;
2. title-only artifact card with no artifact wording;
3. multiple artifacts with panel content changing per click;
4. valid artifact containing Claude sidebar vocabulary;
5. stale previous panel rejection;
6. Markdown attachment body absent inline but available through an accessible text URL abstraction;
7. Markdown attachment body included in exported Markdown/PDF/DOCX semantics;
8. source attachment code indentation;
9. archive bundle metadata;
10. unsupported emoji fallback instead of blank square;
11. representative supported emoji routed to a covering font;
12. code PDF output contains no synthetic continuation glyphs;
13. long question is not wrapped in one unbreakable PDF container;
14. effective artifact setting appears in diagnostics;
15. real-Chrome fixture opens an artifact and captures its body.

### Existing tests

All existing suites must remain green.

## 19. Release/build/documentation

Bump extension version from `0.6.3` to `0.6.4`.

Update:

- `manifest.json`;
- `package.json`;
- README version;
- README clone URL;
- README test wording/count;
- README artifact limitations;
- selector-canary wording.

Replace the external system `zip` dependency in the build script with a JavaScript ZIP implementation already available to the project or a small deterministic local implementation so the build is cross-platform.

## 20. Files expected to change

Primary:

- `src/platforms/adapter.js`
- `src/platforms/claude.js`
- `src/platforms/chatgpt.js` where needed for shared record compatibility
- `content.js`
- `src/ir/extract.js`
- `src/ir/pdf.js`
- `pdf-worker.js`
- `exporter.js`
- `options.js`
- `tests/reported-issues.test.js`
- `tests/adapters.test.js`
- `tests/browser-extension-smoke.mjs`
- fixtures for modern Claude artifact behavior
- font coverage/smoke tests
- `README.md`
- version files
- `scripts/build.mjs`

Secondary files may change only where required by tests or existing module boundaries.

## 21. Non-goals

This change will not:

- add debugger permission;
- scrape private internal Claude/ChatGPT APIs;
- upload conversations to a server;
- unpack archive contents that are not available in the page;
- add syntax coloring/highlighting;
- add PDF/UA tagging;
- export hidden regenerated-answer branches.

## 22. Implementation order

1. Add failing tests for current regressions.
2. Introduce immutable mounted-message harvesting.
3. Rework Claude artifact discovery/correlation.
4. Rework text/Markdown attachment body capture.
5. Add diagnostics.
6. Fix PDF emoji/font fallback.
7. Fix exact code-text and long-question PDF layout.
8. Add lightweight popup extraction.
9. Update release/build/docs.
10. Run complete unit/DOM/real-Chrome/font/PDF/build verification.
11. Produce final engineering report and open PR against `main`.

## 23. Release gate

The branch is not ready for PR until every success criterion in section 2 is automated where feasible and the complete CI/build suite passes.
