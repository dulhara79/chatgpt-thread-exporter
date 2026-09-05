# V0.5.0 Renderer-Owned PDF Reliability Design

Date: 2026-09-05
Status: Implemented on `fix/v050-renderer-owned-pdf-lifecycle`

## Problem

V0.4.0 improved cancellation and queue recovery, but its critical lifecycle still depended on volatile MV3 service-worker globals and a fake callback timeout around pdfmake. A timed-out wrapper could reject while pdfmake continued running in the same offscreen page, and the complete PDF definition crossed Chrome extension messaging twice.

## Reliability invariants

1. The offscreen document is the single owner of render exclusivity.
2. At most one PDF render may run in one offscreen document.
3. The service worker must not own a render queue or job map.
4. The service worker may restart without losing PDF correctness.
5. A stuck pdfmake render is cancelled only by destroying the offscreen context.
6. A browser-owned watchdog must survive service-worker idle termination.
7. Repeated clicks must not extend the watchdog of an already-running render.
8. The heavy PDF definition crosses Chrome runtime messaging once.
9. Oversized source/definition/SVG content is rejected before unsafe messaging.
10. Save As start and final download state are distinct concepts.
11. No debugger, render tab, print preview, html2canvas, or whole-page raster fallback.
12. Existing selectable Unicode text, exact character diagrams, A4 default, and title filenames are preserved.

## Architecture

```text
ChatGPT content / popup selection
        ↓
source-size preflight
        ↓
semantic PDF definition
        ↓
definition-size + node-count preflight
        ↓
CGX_PREPARE_PDF_WORKER (small control message)
        ↓
stateless MV3 service worker
        ├── ensure offscreen exists
        └── arm chrome.alarms watchdog
        ↓
caller sends COMPLETE definition directly to offscreen (one heavy hop)
        ↓
offscreen render lock
        ↓
fonts / bounded media / semantic transform
        ↓
pdfmake getBlob
        ↓
Blob boundary reached
        ├── clear watchdog through service worker
        └── offscreen owns Blob URL
        ↓
small CGX_DOWNLOAD_PDF control message
        ↓
service worker chrome.downloads.download({ saveAs:true })
        ↓
download id
        ↓
downloads.onChanged forwarded to offscreen
        ↓
offscreen releases Blob URL
```

## Hard cancellation

pdfmake layout can contain synchronous work that JavaScript timers cannot interrupt. V0.5.0 therefore removes the worker-side `PDF_CALLBACK_TIMEOUT_MS` wrapper.

The cancellation boundary is the offscreen document itself:

```text
render begins
   ↓
55s browser alarm armed
   ↓
Blob produced? ── yes ──→ clear alarm
   │
   no
   ↓
alarm fires
   ↓
chrome.offscreen.closeDocument()
   ↓
pdfmake execution context destroyed
```

The caller also has a shorter safety timeout and requests the same offscreen reset. The alarm exists so popup closure or service-worker restart cannot leave a stuck render unbounded.

## Message-size protection

Chrome runtime messages have a hard size ceiling. V0.5.0 keeps conservative application limits below that boundary:

- source payload: 24 MiB
- PDF definition: 36 MiB
- definition nodes: 120,000
- inline serialized SVG before base64: 1,000,000 characters
- existing worker media limits remain in place

The service worker never retransmits `definition`.

## Download semantics

`chrome.downloads.download()` returning an id means Save As/download initiation succeeded; it does not mean the file later completed.

The background forwards complete/interrupted download state to the offscreen owner so Blob URLs are released according to the real download lifecycle.

User-facing copy therefore says `Save As opened`, not `PDF downloaded`.

## Browser verification

CI has two layers:

1. Node regression tests for parser, definition, lifecycle contracts, fonts, and downloads bridge.
2. A real Chromium smoke job that loads the unpacked MV3 extension, creates the actual offscreen document, sends a real runtime message, and verifies pdfmake returns a real `%PDF` Blob using multilingual/diagram content.

The native OS Save As picker is not automated in CI; its background bridge remains covered by lifecycle tests.

## Preserved behavior

- no debugger permission
- no temporary render tab
- no print dialog/preview route
- direct native Save As
- conversation-title filename
- A4 default
- selectable multilingual text
- selectable exact character diagrams
- bounded image/SVG handling
- Word and Markdown exports retained
