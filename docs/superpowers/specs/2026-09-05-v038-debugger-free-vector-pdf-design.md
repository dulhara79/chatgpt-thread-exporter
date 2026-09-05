# V0.3.8 Debugger-Free Vector PDF Design

Date: 2026-09-05
Status: Implemented on fix/offscreen-vector-pdf-v038

## Problem

V0.3.7 solved long-thread performance by using Chrome DevTools Protocol `Page.printToPDF`, but that architecture required `chrome.debugger` and a temporary render tab. It caused three user-facing problems:

1. Chrome displayed a debugger notification.
2. PDF export was not reliably reusable without refreshing the ChatGPT page.
3. A temporary render tab could become visible/focused before the Save As dialog.

The repeated-use failure also had a separate UI lifecycle cause: stale capture listeners created by old export menus could survive after programmatic menu removal and interfere with later menus.

## Requirements

- No `debugger` permission or debugger notification.
- No visible render/preview tab.
- Export must work repeatedly without reloading ChatGPT.
- Clicking PDF should lead directly to Chrome Save As with the conversation-title filename.
- Long-thread rendering must not return to whole-document html2canvas screenshots.
- A4 remains default; Letter and Legal remain supported.
- Word and Markdown behavior remains unchanged.
- Processing remains local-only.

## Architecture

ChatGPT content
→ semantic PDF definition
→ MV3 offscreen PDF worker
→ browser-side vector PDF engine
→ Blob URL
→ chrome.downloads.download({ saveAs: true })
→ native Save As

The service worker never creates a tab and never attaches a debugger.

## Rendering rules

- Normal Latin/common-symbol content is emitted as vector text.
- Lists, tables, headings, code, links, rules, page geometry, and footer structure are semantic PDF objects.
- Meaningful data-URL SVG/PNG/JPEG images are preserved as PDF content.
- External images degrade to a useful link/alt label when the hidden worker cannot embed them safely.
- Complex-script fallback (Sinhala/Tamil/Korean/emoji or other unsupported glyph runs) is rasterized only at the paragraph/element level using the browser's installed font stack. Whole pages and whole documents are never rasterized.
- The same targeted fallback is used for content that cannot be represented safely by the bundled base font.

## Lifecycle

- Exactly one offscreen PDF worker is created/reused.
- PDF jobs are serialized in the background worker.
- Each PDF Blob URL remains valid until the associated download completes/interupts or a five-minute safety timeout expires.
- Export menus use AbortController-backed listeners.
- Menu cleanup is instance-scoped so an old asynchronous export cannot close a newer menu.

## Permissions

V0.3.8:
- activeTab
- downloads
- offscreen

Removed:
- debugger
- tabs

## Regression guards

CI must fail if:
- `chrome.debugger`, `Page.printToPDF`, `Page.setDocumentContent`, or `chrome.tabs.create` return to the PDF path.
- `html2canvas`/html2pdf whole-document raster rendering returns.
- the export-menu lifecycle stops using abortable listeners.
- the semantic PDF definition stops being structured-clone/JSON serializable.
