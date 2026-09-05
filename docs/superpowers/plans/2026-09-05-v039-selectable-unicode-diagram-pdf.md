# V0.3.9 Selectable Unicode + Diagram PDF Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the V0.3.8 debugger-free/repeatable/direct-save lifecycle while making PDF text selectable and preserving Unicode/ASCII diagrams and meaningful images.

**Architecture:** Keep the existing MV3 offscreen PDF worker and background download queue. Replace the `cgxRasterText` paragraph-image fallback with serializable font-run nodes, add a dedicated `cgxPreformatted` node for character diagrams, and resolve actual image assets in the offscreen worker. Only graphical SVG/image assets may be rasterized when vector rendering is unsupported.

**Tech Stack:** Chrome MV3 offscreen documents, pdfmake browser renderer, local font VFS, Node test runner, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-05-v039-selectable-unicode-diagram-pdf-design.md`

## Global Constraints

- Preserve `activeTab`, `downloads`, and `offscreen` permissions only.
- Do not add `debugger` or `tabs` permissions.
- Do not use html2canvas/html2pdf or whole-page rasterization.
- Ordinary textual content must never become PNG/canvas content.
- A4 remains default.
- Existing Word and Markdown behavior must remain stable.

---

### Task 1: Lock fidelity requirements with failing regression tests

**Files:**
- Modify: `tests/exporter-regression.test.js`

**Interfaces:**
- Consumes: `ChatGPTExporter.buildPdfDefinition(data, turns, options)`
- Produces: acceptance tests for font runs, preformatted diagrams, image asset nodes, and prohibited raster text fallback

- [ ] Add a multilingual fixture containing `English සිංහල தமிழ் 한국어 😀 ∑ α β → ✓` and assert its PDF definition contains no `cgxRasterText`.
- [ ] Add the exact clinician architecture diagram fixture and assert the definition contains `cgxPreformatted` with byte-for-byte identical diagram text.
- [ ] Assert `pdf-worker.js` contains no `function rasterText` or `canvas.toDataURL` textual fallback.
- [ ] Assert an HTTPS Markdown image remains a `cgxImage` asset for worker resolution.
- [ ] Run CI and verify these tests fail against V0.3.8 for the expected reasons.

### Task 2: Build script-aware selectable text nodes

**Files:**
- Modify: `exporter.js`
- Modify: `pdf-worker.js`

**Interfaces:**
- Produces: `pdfTextRuns(text, options)` serializable run list where every run contains `{text, cgxFont}` plus inline style flags
- Worker consumes `cgxFont` and maps it to registered pdfmake fonts

- [ ] Implement Unicode-script classification for Latin/general, Sinhala, Tamil, Hangul, symbols/emoji, and mono contexts.
- [ ] Split inline tokens into script-aware runs without dropping bold/italic/link/code semantics.
- [ ] Remove `cgxRasterText` production entirely.
- [ ] Remove `rasterText()` from the worker.
- [ ] Convert font intent to pdfmake `font` properties in `transformNode()`.
- [ ] Run tests and confirm multilingual definition tests pass.

### Task 3: Add dedicated selectable preformatted diagrams

**Files:**
- Modify: `exporter.js`
- Modify: `pdf-worker.js`
- Test: `tests/exporter-regression.test.js`

**Interfaces:**
- Produces: `{cgxPreformatted: {text, diagram, language}}`
- Worker transforms to one unwrapped monospace text node sized to fit printable width

- [ ] Detect diagram-like code by language or box/arrow characters.
- [ ] Preserve exact code string including leading spaces/newlines.
- [ ] Transform `cgxPreformatted` to monospace PDF text with `noWrap: true`.
- [ ] Compute font size from longest logical line and printable width; shrink instead of wrapping.
- [ ] Verify the exact clinician diagram fixture is unchanged in the semantic definition.

### Task 4: Fix real image/SVG asset handling

**Files:**
- Modify: `pdf-worker.js`
- Modify: `exporter.js`
- Test: `tests/exporter-regression.test.js`

**Interfaces:**
- `cgxImage.src` may be data URL or HTTPS URL
- Worker returns vector SVG for supported SVG; image data URL for fetched/rasterized assets; link+alt fallback on failure

- [ ] Add HTTPS image fetch → Blob → data URL resolution.
- [ ] Preserve PNG/JPEG data URLs directly.
- [ ] Add SVG preflight for `foreignObject`, filters, and unsupported constructs.
- [ ] Keep supported SVG vector.
- [ ] Rasterize only unsupported SVG visuals, never surrounding text.
- [ ] Preserve alt/link fallback when fetch fails.

### Task 5: Version/docs/CI cleanup

**Files:**
- Modify: `manifest.json`
- Modify: `package.json`
- Modify: `popup.html`
- Modify: `README.md`
- Modify: `tests/exporter-regression.test.js`

**Interfaces:**
- Release version: `0.3.9`

- [ ] Bump manifest/package/UI version to 0.3.9.
- [ ] Remove README statements that describe obsolete chunked html2canvas rendering.
- [ ] Document selectable multilingual text, character diagrams, and image preflight.
- [ ] Keep regression guards for no debugger/no render tab/repeatable export.
- [ ] Run full test and syntax CI.

### Task 6: PR verification

**Files:**
- No production file changes unless verification finds a defect.

- [ ] Open a PR from `fix/selectable-unicode-diagrams-v039` to `main`.
- [ ] Verify GitHub Actions passes.
- [ ] Inspect changed-file patch for accidental debugger/tab/html2canvas regressions.
- [ ] Report remaining limitation explicitly if exact browser PDF text extraction cannot be automated in current CI.
