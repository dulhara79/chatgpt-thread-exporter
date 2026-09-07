# Export Fidelity Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ChatGPT/Claude exports preserve live Claude artifacts, Markdown/text attachment bodies, emoji/symbols, exact code text, and long-question layout across PDF, DOCX, and Markdown.

**Architecture:** Capture immutable message IR and extras while each message is still mounted. Claude artifact capture correlates a clicked card to a changed verified artifact panel; text attachments capture inline DOM or a bounded accessible text URL. The existing IR remains the single renderer input.

**Tech Stack:** Chrome MV3, plain JavaScript, jsdom/Node tests, Puppeteer, pdfmake, custom DOCX WordprocessingML, bundled Noto fonts.

**Spec:** `docs/superpowers/specs/2026-09-07-export-fidelity-architecture-design.md`

## Global Constraints

- No debugger permission, remote export service, private Claude/ChatGPT APIs, or `<all_urls>`.
- Processing stays local in the browser.
- Archive contents are never invented.
- PDF/DOCX/Markdown consume the same IR.
- Release version becomes `0.6.4`.

---

### Task 1: Reproduce every reported regression

**Files:** Create `tests/fixtures/claude-artifact-modern.html`; modify `tests/reported-issues.test.js`, `tests/adapters.test.js`, `tests/renderers.test.js`.

**Interfaces:** Tests use `loadPage`, `fixture`, `plain`, `ThreadExporterIR`, and renderer helpers.

- [ ] Add a modern Claude fixture with a title-only artifact button, two artifacts, sidebar chrome, a panel populated after click, and a Markdown attachment.
- [ ] Add a failing test proving title-only artifact cards are discovered without literal `artifact`/`Document` text.
- [ ] Add a failing test proving a valid artifact containing `Projects`, `Artifacts`, `Scheduled`, `Customize`, and `Pinned` is not rejected.
- [ ] Add a failing test proving two artifact clicks produce two distinct captured bodies and never reuse the stale prior panel.
- [ ] Add a failing virtualization test: capture a mounted artifact record, remove its DOM node, then assert the immutable record still contains the artifact body.
- [ ] Add a failing Markdown attachment test using a Markdown body with a heading, list, and fenced Python code; assert heading/list/code reach Markdown, PDF, and DOCX outputs.
- [ ] Add failing PDF assertions that serialized output contains neither `↴` nor `↳`, and the entire question wrapper is not unbreakable.
- [ ] Add failing font tests for representative supported emoji and one deliberately unsupported code point requiring readable fallback.
- [ ] Run `node scripts/test.mjs reported-issues`, `node scripts/test.mjs adapters`, and `node scripts/test.mjs renderers`; record the expected RED failures.

### Task 2: Harvest immutable mounted-message records

**Files:** Modify `src/platforms/adapter.js`, `content.js`; tests in adapters/reported-issues.

**Interfaces:** Produce `captureMountedMessage(message, context) -> Promise<HarvestedMessage>` and virtualized harvested records `{key, role, blocks, artifacts, attachments, captureDiagnostics}`.

- [ ] Replace the first-400-character 32-bit identity fallback with a stronger deterministic identity using role + full normalized message text + occurrence context; prefer platform message IDs first.
- [ ] Add a default mounted capture hook in the shared adapter contract.
- [ ] During each virtualized window, capture every newly seen mounted message before scrolling and store immutable records rather than relying on detached DOM for later interaction.
- [ ] Update `content.js` so turn construction consumes immutable records directly and does not recapture artifacts/attachments when they already exist.
- [ ] Preserve live per-answer export by using the same mounted capture API immediately.
- [ ] Run adapter and reported-issue suites and commit only when the detached-harvest regression is green.

### Task 3: Rebuild Claude artifact discovery and panel correlation

**Files:** Modify `src/platforms/claude.js`, `src/ir/extract.js`; tests in adapters/reported-issues.

**Interfaces:** `artifactCards(turn)` uses scored evidence; `captureArtifacts(turn)` correlates card click to changed panel state; Claude `captureMountedMessage` captures while connected.

- [ ] Score artifact-card candidates using test IDs, artifact/card class fragments, assistant-response placement, metadata/badges/icons, and click behavior. Do not require literal artifact wording.
- [ ] Hard-reject only structural chrome such as `nav`, `[role=navigation]`, sidebar/left-rail/chat-list ancestry. Remove hard rejection based solely on document vocabulary.
- [ ] Before click, capture panel identity/signature; after click, wait with MutationObserver plus timeout for a new root, changed signature, changed active marker, or semantic control relation.
- [ ] Reject stale unchanged panels and mark `panel-correlation-failed`.
- [ ] If `!card.isConnected`, mark `detached-card` instead of clicking.
- [ ] Snapshot only content roots: structured DOM, `pre`, same-origin iframe body, accessible shadow root, canvas PNG, SVG/images. Exclude toolbar/navigation controls.
- [ ] Store explicit failure metadata (`panel-not-found`, `detached-card`, `panel-correlation-failed`, `iframe-inaccessible`).
- [ ] Run artifact tests until title-only, sidebar-vocabulary, multiple-artifact, stale-panel, and detached-harvest cases pass.

### Task 4: Preserve Markdown/text attachment bodies

**Files:** Modify `src/platforms/claude.js`, `src/platforms/chatgpt.js` if shared URL metadata is needed, `content.js`; tests in reported-issues/renderers.

**Interfaces:** Attachment result `{name, kind, text, blocks, status, reason}`; bounded text fetch helper.

- [ ] Snapshot inline `pre`, `textarea`, mono/content wrappers first.
- [ ] Resolve accessible attachment URLs from `href`, download/source attributes, or same-origin allowed URLs associated with the card.
- [ ] Implement bounded local text fetch: max 8 seconds, max 4 MiB, text-like extension/MIME allowlist, existing host permissions only, no broad permissions.
- [ ] Parse `.md/.markdown/.mdown/.mkd` through `IR.parseBlocks(text)`.
- [ ] Render other source/text files as preformatted code IR with inferred language.
- [ ] Keep `.zip/.tar/.tar.gz/.tgz/.7z/...` as explicit metadata-only bundle entries.
- [ ] Add renderer parity assertions proving the Markdown heading/list/fence appears semantically in Markdown, PDF definition, and DOCX XML.

### Task 5: Add capture diagnostics and effective settings

**Files:** Modify `src/platforms/adapter.js`, `src/platforms/claude.js`, `content.js`, `options.js`; test reported-issues.

**Interfaces:** Diagnostics expose `effectiveSettings.includeArtifacts`, artifact counters/failures, and attachment counters/failures.

- [ ] Add diagnostic counters and failure arrays at capture boundaries.
- [ ] Include effective settings in `CGX_DIAGNOSTICS`.
- [ ] Display artifact/attachment diagnostics in Settings.
- [ ] Add a behavioral test that a failed artifact reports its reason rather than disappearing silently.

### Task 6: Eliminate emoji/symbol blank boxes

**Files:** Modify `src/ir/pdf.js`, `pdf-worker.js`, `tests/font-coverage.test.js`, `tests/pdf-font-smoke.test.js`.

**Interfaces:** Glyph routing chooses only bundled fonts whose cmap contains the code point; unsupported scalars become readable `[U+XXXXX]` fallback.

- [ ] Extend cmap tests for 😀 U+1F600, heart/text presentation where supported, arrows, box drawing, Sinhala, Tamil, and Korean.
- [ ] Unify normal and preformatted routing around measured font coverage instead of Unicode-block assumptions.
- [ ] Preserve variation-selector/ZWJ clusters with the previous run where possible.
- [ ] For a truly unsupported scalar, emit `[U+XXXXX]` instead of passing a missing glyph to pdfmake.
- [ ] Run `node scripts/test.mjs font` and the real PDF font smoke.

### Task 7: Preserve exact code text and paginate long questions

**Files:** Modify `src/ir/pdf.js` and `pdf-worker.js` only if layout requires; tests renderers/reported-issues.

**Interfaces:** `cgxPreformatted.text` equals sanitized source text; question label stays with first content but body can break across pages.

- [ ] Remove synthetic `↴`/`↳` characters from code wrapping.
- [ ] Let visual layout wrap/shrink without editing the source string.
- [ ] Replace the globally unbreakable question container with an unbreakable label/first-content unit plus breakable styled body.
- [ ] Add a long pasted-question regression and exact-code-text assertion.

### Task 8: Defer expensive popup enrichment until export

**Files:** Modify `content.js`, `popup.js`, `tests/architecture-guards.test.js`.

**Interfaces:** Add `CGX_EXTRACT_SUMMARY` for title/turn previews; keep `CGX_EXTRACT` for full mounted-content export.

- [ ] Add lightweight summary extraction without artifact opening.
- [ ] Make popup startup request summary only.
- [ ] On PDF/DOCX/MD export click, request full extraction once and filter selected turn IDs.
- [ ] Add an architecture guard proving popup startup no longer triggers full artifact capture.

### Task 9: Real-Chrome artifact smoke

**Files:** Modify `tests/browser-extension-smoke.mjs`, `tests/fixtures/claude-artifact-modern.html`.

**Interfaces:** Smoke test executes real adapter modules against an interactive fixture and verifies card click -> panel mutation -> distinct captured artifact bodies.

- [ ] Load modern fixture in real Chrome.
- [ ] Wire two artifact click handlers producing distinct panel bodies.
- [ ] Run `captureArtifacts` and assert both bodies are captured correctly.
- [ ] Run `node tests/browser-extension-smoke.mjs`.

### Task 10: Release/build/docs/report

**Files:** Modify `manifest.json`, `package.json`, `README.md`, `scripts/build.mjs`; create `docs/reports/2026-09-07-export-fidelity-remediation-report.md`.

**Interfaces:** Version `0.6.4`; build has no external system `zip` dependency.

- [ ] Replace `execFileSync('zip', ...)` with JavaScript ZIP generation using the existing `fflate` dependency.
- [ ] Bump manifest/package/README version to `0.6.4`.
- [ ] Fix README clone URL to `https://github.com/dulhara79/chatgpt-thread-exporter.git` and `cd chatgpt-thread-exporter`.
- [ ] Correct selector-canary wording, test count wording, and artifact/attachment limitations.
- [ ] Write the remediation report with root causes, before/after architecture, files changed, tests added, remaining limitations, and exact verification results.
- [ ] Run `npm run version:check`, `npm test`, and `npm run build`.

### Task 11: Final verification and PR

**Files:** No production changes unless verification exposes a regression.

**Interfaces:** Produce a green PR against `main`.

- [ ] Re-run `npm run version:check`, `npm test`, and `npm run build` from branch HEAD.
- [ ] Compare branch against `main`; confirm no debugger/all-URLs/internal-API permissions were added.
- [ ] Scan spec/plan/report for unresolved placeholders.
- [ ] Open PR titled `Fix export fidelity architecture for Claude artifacts, attachments, and PDF glyphs`.
- [ ] Verify GitHub Actions succeeds before reporting the project as fixed.

## Self-review

- Spec coverage: all design requirements map to Tasks 1-11.
- Placeholder scan: no unresolved implementation placeholders.
- Interface consistency: mounted-message records are introduced in Task 2 and consumed by Claude/content tasks afterward.
- Scope remains limited to export fidelity, diagnostics, tests, release/build/docs required by the audit.