# v0.6.4 Audit Remediation Report

**Repository:** `dulhara79/chatgpt-thread-exporter`  
**Base audited:** `main@94c48a8975acef969d0cb9dec2c2a2fc6e969bd5`  
**Remediation branch:** `fix/v064-artifact-markdown-emoji-audit`  
**Pull request:** #21  
**Release version:** 0.6.4  
**Date:** 2026-09-07

## Executive summary

The main-branch audit identified a real architectural regression: static Q&A text survived Claude's virtualized-thread harvesting, but artifact bodies were captured only after harvested DOM nodes could already be detached. The latest real-world report added two more failures:

1. an assistant-generated Markdown audit file downloaded successfully from ChatGPT but the **file body was absent from the exported conversation**;
2. some PDF emoji rendered as **blank square/tofu glyphs**.

v0.6.4 fixes the upstream capture path rather than adding another output-only workaround. Interactive content is captured while live; assistant-generated text files are now first-class answer attachments; PDF glyph routing and emoji shaping controls are hardened; and the regression suite now covers these paths.

## Findings and remediation

| Audit ID | Severity | Finding | v0.6.4 action | Status |
|---|---|---|---|---|
| C-01 | Critical | Claude whole-thread artifacts were opened after virtualized DOM could detach | harvesting now accepts a mounted-message capture hook; artifacts/attachments are snapshotted before detachment | Fixed |
| C-02 | Critical | Claude artifact-card discovery could return zero for newer/title-oriented card markup | fallback discovery now uses artifact/document/preview semantics including ancestor markers without relying only on one test id | Fixed |
| C-03 | Critical | anti-sidebar text heuristic could reject a legitimate artifact that discusses Projects/Artifacts/Scheduled/etc. | UI vocabulary is now only a weak signal; navigation ancestry/link density are the hard chrome checks | Fixed |
| C-04 | Critical | green CI did not exercise artifact opening | real-Chrome smoke now creates, clicks, opens and snapshots a Claude artifact; reported-issue tests cover live/detached paths | Fixed |
| H-01 | High | artifact failures were silent | diagnostics now report cards seen/connected/captured/failed with failure reasons and effective artifact settings | Fixed |
| H-02 | High | a second artifact could receive stale previous-panel content | capture records the pre-click panel/signature and requires a new/changed panel before snapshot | Fixed |
| H-03 | High | fallback identity truncated text to 400 chars and used one 32-bit hash | fallback identity hashes the complete role+message in both directions and includes length; platform IDs/UUIDs remain preferred | Mitigated; exact duplicate fallback messages without platform IDs are still theoretically indistinguishable |
| H-04 | High | sequential artifact timeouts could be very slow | per-card settle window reduced from ~4.2 s to ~2.4 s worst-case and exits as soon as changed content stabilizes | Improved |
| H-05 | High | inaccessible iframe artifacts could disappear without a useful reason | inaccessible/empty frames produce an explicit capture failure/placeholder rather than invented content | Fixed gracefully; browser same-origin rules still apply |
| H-06 | High | merely opening popup triggered full virtualized extraction | popup now waits for explicit Refresh before expensive extraction | Fixed |
| H-07 | High | PDF long-code wrapping inserted selectable ↴/↳ characters not present in source | IR keeps exact source; pdf-worker handles visual wrapping only | Fixed |
| H-08 | High | substantial fixes shipped under unchanged 0.6.3 | manifest/package/lock/README moved to 0.6.4 and lockfile is now checked by version sync | Fixed |
| M-01 | Medium | entire question box was unbreakable and could exceed one page | question body may paginate; short section label remains intact | Fixed |
| M-02 | Medium | reported-issue attachment test asserted source regexes instead of behavior | implementation-grep attachment test removed; generated Markdown file behavior is exercised | Fixed |
| M-03 | Medium | artifact type depended too heavily on card metadata | type now falls back to captured prose/editor structure | Fixed |
| M-04 | Medium | remote artifact media may be blocked by browser/CORS/host policy | existing safe alt/link fallback retained; no broad host permissions added | Safe fallback retained |
| M-05 | Medium | build required external `zip` executable | store ZIP is generated in JavaScript with existing `fflate` dependency | Fixed |
| M-06 | Medium | README cloned the wrong repository | install URL/path corrected | Fixed |
| M-07 | Medium | weekly CI was described as a live selector canary though it uses fixtures | workflow/readme now call it a redacted fixture-contract/browser smoke | Fixed |
| M-08 | Medium | normal-text glyph routing disagreed with measured preformatted routing | arrows/box drawing use bundled mono coverage; Symbols2 is reserved for covered symbol ranges | Fixed |
| M-09 | Medium | stored `includeArtifacts=false` silently produced artifact-free exports | exported answer explicitly says artifact(s) were excluded; diagnostics include effective setting | Fixed |
| M-10 | Medium | Claude viewer controls could leak into artifact snapshots | viewer-specific close/copy/download/fullscreen toolbar controls are removed during snapshot without deleting controls belonging to a rendered app | Fixed |
| L-01 | Low | obsolete Claude turn selector list remained | removed | Fixed |
| L-02 | Low | README hard-coded stale test count | hard-coded count removed | Fixed |
| L-03 | Low | minimum Chrome 116 is not exercised by an actual Chrome-116 CI job | existing API assumptions remain; current real-Chrome smoke is authoritative for release | Open tooling limitation |
| L-04 | Low | no separate lint/type/coverage gate | syntax checks + structural/unit/browser tests remain; no new dependency added in this patch | Open tooling improvement |

## New real-world regression: generated Markdown file body missing

### Root cause

The export pipeline appended attachments only from the user/question node:

```text
question attachments -> answer IR
assistant-generated files -> ignored
```

ChatGPT-generated artifacts such as:

```text
full-audit.md
/mnt/data/full-audit.md
```

are commonly rendered as an assistant download card/link, not as a user upload.

### Fix

The turn builder now captures attachments for **every assistant answer** and appends them to that answer's IR.

The ChatGPT adapter recognizes generated-file links including:

- `a[download]`
- `blob:`
- `sandbox:`
- OpenAI content/static hosts already permitted by the manifest
- `/files/`
- `/mnt/data/`

For text-like formats the adapter:

1. prefers readable inline/preformatted content already in DOM;
2. otherwise fetches only the safe URL already exposed by the page;
3. caps the file at 4 MiB;
4. decodes UTF-8;
5. snapshots it into a detached `<pre>` for later virtualized extraction.

Markdown files then flow through `IR.parseBlocks()`, so headings, lists, tables and fenced code are emitted as document structure instead of one raw blob.

Archives/binaries remain named placeholders when their bytes are not exposed.

## New real-world regression: emoji blank boxes

### Root cause

The bundled monochrome emoji font can render base emoji, but pdfmake may try to draw default-ignorable shaping characters such as:

- U+200D ZERO WIDTH JOINER
- U+FE0E text variation selector
- U+FE0F emoji variation selector

as visible glyphs. Missing-glyph handling then appears as empty rectangles.

A second routing mismatch sent some arrows/box-drawing characters to a symbol font that does not contain them.

### Fix

- PDF source sanitation removes only the default-ignorable ZWJ/variation-selector controls from the glyph stream.
- Base emoji remain and use the bundled Noto Emoji font.
- Complex ZWJ emoji may degrade into adjacent monochrome base emoji instead of one composed color glyph, but they no longer gain blank selector boxes.
- Preformatted code/diagram rendering applies the same shaping-control rule.
- Normal arrows/box drawing are routed consistently to the measured mono font coverage.

## Claude artifact architecture after v0.6.4

```text
LIVE VIRTUAL WINDOW
      |
      +--> static message DOM -> IR later if needed
      |
      +--> artifact cards --------+
      |                           |
      |                     click while connected
      |                           |
      |                    require panel change
      |                           |
      |                    snapshot content DOM
      |
      +--> pasted/generated files -> snapshot while connected
      |
      v
scroll to older window
      |
old DOM may detach safely
```

The key invariant is now:

> Anything requiring interaction with the host application is captured while the node is still connected.

## Artifact-panel safety

The capture path now:

1. records the currently open panel and its signature;
2. clicks one connected artifact card;
3. waits for a newly mounted panel or changed signature;
4. requires readable/rich content;
5. rejects navigation/sidebar ancestry;
6. snapshots only the content root;
7. strips viewer-specific controls;
8. records an explicit reason on failure.

A valid document is not rejected merely because its prose contains words such as “Projects”, “Artifacts”, “Scheduled”, “Customize” or “Pinned”.

## Output-format parity

Once content reaches IR, all output formats consume the same structured blocks:

```text
Captured DOM/file
      |
      v
Intermediate Representation
   /      |       \
 Markdown PDF     DOCX
```

This is important for the reported `.md` file bug: the fix is at capture/IR level, so PDF, Word and Markdown all gain the same assistant-generated file body.

## PDF fidelity changes

### Exact code

The prior PDF definition inserted continuation glyphs into long lines. v0.6.4 no longer mutates source text. Code remains selectable and identical at the IR boundary; visual wrapping belongs to the PDF layout worker.

### Long questions

The previous entire question box was `unbreakable`. Long pasted prompts can now span pages safely.

### Emoji/symbols

- Sinhala, Tamil, Korean, mono, symbol and emoji fonts remain bundled.
- box-drawing/arrow routing is consistent with measured font coverage.
- ZWJ/variation selectors do not become visible tofu squares.

## Diagnostics

The settings diagnostic payload now includes effective export settings and Claude artifact state similar to:

```json
{
  "effectiveSettings": {
    "includeArtifacts": true,
    "includeThinking": false,
    "embedImages": true
  },
  "artifactDiagnostics": {
    "cardsSeen": 3,
    "connectedCards": 3,
    "captured": 2,
    "failed": 1,
    "failures": [
      {
        "title": "Preview",
        "reason": "inaccessible-or-empty-iframe"
      }
    ]
  }
}
```

No conversation content is uploaded by diagnostics.

## Regression tests added/changed

- assistant-generated Markdown download card is discovered
- generated Markdown body is snapshotted
- answer-side attachment wiring is present in turn extraction
- Claude artifact document containing sidebar vocabulary remains valid
- detached artifact cards are reported as detached
- live artifact click creates and snapshots panel content
- real-Chrome fixture smoke performs artifact click/capture
- long PDF code remains exact with no ↴/↳ mutation
- emoji ZWJ/variation selectors are absent from PDF definition
- question container is allowed to paginate
- stale source-regex attachment test removed

## Privacy/security boundaries preserved

The patch does **not** add:

- `debugger`
- `<all_urls>`
- internal ChatGPT/Claude API scraping
- remote rendering
- screenshots of the conversation
- analytics

Generated text-file fetching is restricted to URLs already present in the page and safe ChatGPT/OpenAI/local schemes. Binary archives are not guessed or unpacked from unavailable DOM.

## Remaining platform constraints

Two constraints cannot be removed without changing the product's privacy/security model:

1. **Cross-origin/sandboxed artifact iframe bodies:** the browser can deny `contentDocument`; v0.6.4 reports this explicitly instead of silently exporting the wrong content.
2. **Identical fallback messages with no platform ID/UUID:** full dual hashes eliminate truncation/collision weaknesses, but two byte-identical role messages with no platform identity are theoretically indistinguishable. Real platform message IDs remain the primary path.

These are documented constraints, not silent failure modes.

## Release gate

Before merge, CI must pass:

- version consistency
- syntax checks
- unit/DOM regressions
- real-Chrome offscreen PDF smoke
- real-Chrome Claude artifact capture smoke
- store ZIP build

PR #21 should remain open until the final head commit is green.
