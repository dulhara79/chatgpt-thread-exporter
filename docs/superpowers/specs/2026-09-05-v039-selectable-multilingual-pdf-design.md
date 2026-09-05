# V0.3.9 Selectable Multilingual PDF Fidelity Design

Date: 2026-09-05
Status: Implemented on fix/pdf-selectable-content-v039

## Scope

V0.3.9 changes only PDF content fidelity. The V0.3.8 offscreen/direct-save lifecycle remains unchanged:

- no debugger permission
- no temporary render tab
- repeated PDF exports work without refreshing
- Chrome Save As opens directly with the conversation-title filename

## Root causes fixed

### Text rasterization

V0.3.8 classified Sinhala, Tamil, Korean, emoji, math-containing text, and box-drawing characters as complex and converted whole text nodes into PNGs. This made those sections unselectable and uncopyable.

V0.3.9 removes the textual raster fallback completely.

### Character diagrams

ASCII/box diagrams were treated as generic text/code and could use proportional fonts or wrap. Their whitespace, line structure, arrows, and topology could therefore collapse.

V0.3.9 detects text diagrams and renders them as selectable preformatted text with an embedded monospace font, preserved leading/trailing spaces, preserved newlines, no wrapping, and shrink-to-fit font sizing.

### Images and SVG

V0.3.8 only embedded data-URL PNG/JPEG/SVG assets and degraded normal HTTPS Markdown images to links.

V0.3.9 attempts to fetch meaningful Markdown images locally and convert them to data URLs before PDF generation. SVG is preflighted: supported SVG stays vector; unsupported graphical SVG features such as foreignObject/filter are rasterized only as that graphical asset.

## Font model

The extension ships subsetted open-source fonts in the PDF virtual file system:

- Noto Sans Sinhala
- Noto Sans Tamil
- Noto Sans KR
- Noto Sans Mono
- Noto Emoji

Text is segmented into Unicode script runs and each run is assigned the appropriate embedded PDF font. No ordinary text is converted to canvas or image data.

## Rendering invariant

Text remains text.
Character diagrams remain text.
Images remain images.
Only inherently graphical assets may be rasterized.

## Validation

CI performs both source-level and generated-PDF tests.

The real PDF fixture contains:

- English
- Sinhala
- Tamil
- Korean
- emoji
- the exact Clinician Flutter App / Central Backend / C1-C4 / RAGF box-drawing diagram

CI extracts text from the generated PDF with pypdf and fails if multilingual text, arrows, box characters, or diagram labels are lost. The text-only fixture must also contain zero PDF image XObjects, preventing future text-to-image regressions.
