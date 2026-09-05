# V0.3.9 Selectable Unicode + Diagram PDF Design

Date: 2026-09-05
Status: Approved design basis from the V0.3.8 fidelity audit

## Goal

Keep the V0.3.8 UX architecture that is now correct (offscreen worker, direct Save As, repeatable exports, no debugger, no visible render tab) while fixing PDF fidelity regressions.

## Non-negotiable requirements

1. Text remains text. Ordinary textual content must never be converted to canvas/PNG merely because it contains Sinhala, Tamil, Korean, emoji, symbols, box drawing, or math.
2. Character diagrams remain character diagrams. ASCII/Unicode diagrams must preserve every newline and leading space, use a true monospace font, never wrap, and remain selectable/copyable.
3. Actual graphical assets may be rasterized only when required by unsupported SVG/image features. Surrounding text must remain text.
4. Meaningful Markdown/DOM images must be embedded when fetchable instead of silently degrading to alt text.
5. Keep the V0.3.8 lifecycle unchanged: activeTab + downloads + offscreen only; no debugger/tabs permission; no preview tab; repeated exports without refresh.
6. A4 remains default; Letter and Legal remain supported.
7. Word and Markdown paths remain unchanged except shared parser changes required to preserve semantics.

## Architecture

ChatGPT DOM
→ semantic Markdown extraction
→ normalized PDF document definition
→ script-aware font runs / dedicated preformatted diagram nodes / image nodes / math nodes
→ hidden MV3 offscreen PDF worker
→ vector PDF Blob
→ chrome.downloads.download({ saveAs: true })

## Text model

Remove `cgxRasterText` and `rasterText()` completely for textual content.

Text is split into runs by Unicode script. Each run carries a font-family intent:

- Latin/general punctuation: `NotoSans`
- Sinhala: `NotoSansSinhala`
- Tamil: `NotoSansTamil`
- Korean/Hangul: `NotoSansKR`
- monospace/code/diagrams: `NotoSansMono`
- symbols/emoji fallback: `NotoSymbols`

Unsupported characters may fall back to a replacement glyph for that character only; they must not trigger paragraph rasterization.

## Preformatted diagrams

Detect diagram-like fenced blocks by language (`text`, `ascii`, `diagram`, `flowchart`, `mermaid`, `graphviz`, `dot`, `plantuml`) or by box/arrow characters.

Represent them as `cgxPreformatted` nodes with the exact source string.

Rendering rules:

- preserve `\n` exactly
- preserve leading/trailing spaces exactly
- use monospace font
- disable wrapping
- compute longest line
- reduce font size until the line fits printable width, down to a safe minimum
- keep the whole diagram as real PDF text

Acceptance fixture:

```text
Clinician Flutter App
        │
        │ HTTPS
        ▼
Central Backend
        │
        ├── C1 Physiological
        ├── C2 Behavioural
        ├── C3 Clinical NLP → TC-WPN
        └── C4 Demographic
                │
                ▼
          RAGF Fusion
                │
                ▼
        Composite Risk
                │
                ▼
       Central Backend
                │
                ▼
        Clinician App
```

## Images and SVG

- data PNG/JPEG: embed directly
- data SVG: preflight for unsupported features; supported SVG stays vector
- unsupported SVG (`foreignObject`, filters, CSS-dependent unsupported features): rasterize the SVG visual only
- HTTPS images: fetch in the offscreen worker using extension host permissions where permitted, convert to data URL, embed
- if fetch is not permitted or fails, preserve a useful link + alt text rather than failing the whole export

## Testing

CI must assert:

- `cgxRasterText` and `rasterText()` do not exist in the PDF text path
- multilingual/emoji test fixture produces vector text/font-run nodes
- exact architecture diagram becomes one preformatted node with unchanged source text
- diagram node is marked no-wrap/monospace
- HTTPS image nodes are resolved by an image-fetch path
- no debugger/tab/html2canvas regressions
- A4 remains default

A generated-PDF integration test should verify `%PDF` output and that expected Unicode text strings are present/selectable where the renderer/library permits deterministic extraction in CI.
