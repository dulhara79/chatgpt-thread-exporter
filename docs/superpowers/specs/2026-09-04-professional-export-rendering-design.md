# ChatGPT Thread Exporter V0.3 — Professional Export Rendering Design

Date: 2026-09-04
Status: Approved for implementation planning
Target branch: feat/professional-export-rendering
Release target: 0.3.0

## 1. Objective

Upgrade the extension into a reliable document-publishing pipeline for exporting one Q&A pair or an entire rendered ChatGPT thread to professional PDF, Microsoft Word (.docx), and Markdown.

The extension remains local-only: no backend, analytics, API key, ChatGPT credentials, or undocumented ChatGPT API.

## 2. User-facing behavior

### Per-answer export
- Keep one Export control under every assistant answer.
- It exports exactly the immediately preceding user question and the selected assistant answer.
- Formats: PDF, Word, Markdown.
- Injection must remain idempotent under ChatGPT React re-renders.

### Whole-conversation export
- Add an Export button immediately to the left of ChatGPT's Share action.
- It exports the complete currently rendered conversation.
- Use layered header/action discovery rather than one fixed English aria-label selector.
- If Share cannot be resolved, place Export deterministically in the same header action region instead of hiding the feature.
- Reposition idempotently after route changes and DOM mutations.
- Keep the popup as a fallback for manual multi-turn selection.

### Visible metadata
Do not render the V0.2 body metadata block containing Scope, Source, or Exported timestamp. Source URL and export time may remain internal document metadata where the target format supports it.

### Page size
- A4 is the default.
- Initial alternatives: Letter and Legal.
- The selected size should apply consistently to PDF and DOCX where applicable.

## 3. Architecture

V0.3 must not use Markdown as the canonical intermediate representation.

Pipeline:

ChatGPT DOM
  -> semantic DOM extractor
  -> normalized document AST
  -> dedicated PDF / DOCX / Markdown renderers

The normalized AST is format-neutral and supports:
- heading
- paragraph and inline spans
- ordered and unordered list
- table
- code block
- blockquote
- hyperlink
- meaningful image
- inline math
- display math

The DOM extractor owns semantic extraction only. Renderer-specific formatting must stay out of extraction.

## 4. Content fidelity

### Lists
Preserve ordered-list start values, sequence, nested levels, and continuation after nested content. DOCX must use Word numbering definitions rather than writing a literal "1." before every item.

### Images
Meaningful images include generated images, diagrams, screenshots, plots, and other content-bearing visuals.

Filter out:
- favicons
- avatars
- toolbar icons
- decorative SVG/iconography
- tracking/tiny images
- ChatGPT UI chrome

PDF and DOCX should embed meaningful images when technically available, preserve aspect ratio, fit printable/page width, and avoid clipping. Markdown should preserve a valid meaningful image reference or useful alt/link semantics.

A Google favicon URL must never become the primary exported image for a citation card.

### Hyperlinks and citation cards
Rich citation cards should degrade to professional document semantics: descriptive title/domain, clickable destination URL, and only a meaningful image when one exists.

### Math
Detect rendered KaTeX/MathJax-style content and recover TeX source from accessible annotations or DOM attributes when available.

- Markdown: preserve inline math with single-dollar delimiters and display math with double-dollar delimiters.
- PDF: preserve high-fidelity rendered equation output.
- DOCX: prefer Word-compatible OMML when safe; otherwise use an explicit readable high-fidelity fallback instead of broken TeX body text.

### Tables
Preserve rows, columns, headers, wrapping, and professional borders/spacing. Long cells must wrap rather than clip.

### Code
Preserve code verbatim and retain a language identifier when discoverable. Do not apply smart-quote or text normalization that changes code.

## 5. Unicode and languages

Preserve Unicode end-to-end. Required regression coverage:
- English
- Sinhala
- Tamil
- Korean
- mixed Sinhala/English
- mathematical Unicode
- emoji
- surrogate pairs
- combining marks

Do not bundle proprietary fonts. PDF should use broad system font fallbacks. DOCX should use professional defaults while allowing Word/system fallback for scripts not covered by the primary font.

## 6. Professional document design

Use an original restrained corporate palette and do not imply OpenAI endorsement or copy OpenAI trade dress.

Recommended document tokens:
- primary navy: #17365D
- secondary slate: #475569
- body: #1F2937
- muted: #64748B
- border: #D9E2EC
- question surface: #F5F8FC
- code surface: #F3F4F6
- paper: #FFFFFF

Document rules:
- conversation title is the document title
- clear Question / Answer hierarchy
- consistent heading levels, spacing, list indentation, tables, code, and images
- restrained print-first visual design
- no decorative gradients or oversized branding

PDF:
- A4 default with configurable page size
- print-safe margins
- controlled page breaks
- proper list numbering
- image/equation/table sizing that avoids clipping
- page footer/numbering where Chromium print support permits

DOCX:
- genuine OOXML
- correct page-size definitions
- Word heading styles
- real numbering definitions
- real tables
- native hyperlinks
- embedded image relationships
- valid headers/footers/page fields
- valid package relationships and XML

Markdown:
- clean semantic Markdown
- no visible Scope/Source/Exported block
- preserve headings, lists, code fences, links, tables, meaningful images, and TeX where representable

## 7. UI integration resilience

Conversation header discovery should:
1. locate the current conversation header/action region by stable structure
2. locate Share using accessible name/title/text heuristics where possible
3. prefer header/positional context over one exact English selector
4. insert Export immediately before Share
5. use the same-header deterministic fallback if Share is not matched
6. re-run idempotently after route changes and React mutations

Mutation observation must be throttled/debounced so it does not repeatedly scan the whole document during high-frequency changes.

## 8. Privacy and permissions

- no backend
- no analytics
- no remote conversation processing
- no ChatGPT credentials
- no undocumented ChatGPT APIs
- minimal Chrome permissions

Do not add broad host permissions solely to improve rare cross-origin image cases. Any added image-fetch permission must be narrowly justified.

## 9. Graceful degradation

One unsupported item must not abort the entire export.

Examples:
- image cannot be embedded -> preserve useful alt text/source link
- equation source cannot be recovered -> preserve readable rendered fallback
- unsupported rich widget -> preserve meaningful text/links
- malformed table -> preserve structured readable content

## 10. Testing

Unit/regression fixtures must cover:
- ordered list 1,2,3,4
- ordered lists starting above 1
- nested ordered/unordered lists
- Sinhala, English, Tamil, Korean, mixed language
- emoji, surrogate pairs, combining marks
- inline/display TeX
- mathematical Unicode
- meaningful image acceptance
- favicon/decorative image rejection
- hyperlink and citation-card preservation
- tables
- code blocks
- absence of visible Scope/Source/Exported metadata
- A4 default and alternate page sizes

DOCX tests:
- ZIP integrity
- required package entries
- XML parsing
- relationships
- numbering definitions
- image relationships
- Unicode round-trip
- page-size settings

PDF/print tests:
- correct page CSS
- semantic list numbering
- image sizing rules
- equation representation

Markdown tests:
- golden/snapshot coverage for lists, tables, images, links, math, code, and multilingual text

UI DOM-fixture tests:
- exactly one export control per assistant answer
- exact Q&A pairing
- no duplicate controls after mutation handling
- conversation Export before Share
- fallback header placement
- whole-conversation extraction order

Manual smoke tests before PR:
- load unpacked in Chromium/Chrome
- long conversation
- Sinhala + English
- emoji
- numbered/nested lists
- meaningful images
- inline/display equations
- inspect DOCX in Word/compatible viewer where available
- inspect PDF preview in A4 and one alternate page size

## 11. Repository discipline

Because the GitHub repository was empty, establish a minimal main baseline, then do all V0.3 work on feat/professional-export-rendering.

Implementation commits should stay small and scoped, for example:
- refactor: introduce normalized document model
- fix: preserve list numbering and nesting
- feat: export meaningful images
- feat: preserve mathematical notation
- fix: place conversation export before share
- feat: add configurable document page size
- test: add multilingual export regression coverage
- docs: document v0.3 export capabilities

Open a PR from feat/professional-export-rendering to main only after verification. Do not merge automatically unless explicitly requested.

## 12. Non-goals

- pixel-perfect reproduction of every interactive ChatGPT widget
- private ChatGPT APIs
- cloud sync
- analytics/telemetry
- exporting hidden/unloaded content unavailable in the rendered thread
- proprietary bundled fonts
- copying ChatGPT/OpenAI visual branding

## 13. Acceptance criteria

V0.3 is ready for PR review when:
1. Per-answer export produces exactly one Q&A pair.
2. Conversation Export is immediately left of Share, or uses the documented same-header fallback.
3. Whole-thread export works from the in-page control.
4. Visible Scope/Source/Exported metadata is absent.
5. Ordered and nested lists retain correct numbering.
6. Sinhala, English, Tamil, Korean, Unicode symbols, and emoji round-trip without corruption.
7. Meaningful images render as actual images in PDF/DOCX when technically available and favicons/decorative images are filtered.
8. Inline/display math exports in a readable, target-appropriate form.
9. A4 is default and Letter/Legal are selectable.
10. PDF, DOCX, and Markdown share consistent professional hierarchy/styling.
11. DOCX packages pass structural validation tests.
12. Automated tests cover required content types and UI injection behavior.
13. Extension remains local-only with minimal permissions.
14. README documents behavior, limitations, installation, and privacy.
