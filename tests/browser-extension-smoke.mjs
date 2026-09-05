import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const extensionPath = path.resolve('.');
const executablePath = process.env.CHROME_PATH;
if (!executablePath || !fs.existsSync(executablePath)) {
  throw new Error('CHROME_PATH must point to an installed Chrome/Chromium binary.');
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgx-chrome-'));
const browser = await puppeteer.launch({
  executablePath,
  headless: false,
  userDataDir,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-extensions-except=' + extensionPath,
    '--load-extension=' + extensionPath
  ]
});

try {
  // Chromium derives an unpacked extension id from the normalized absolute
  // extension path: SHA-256, first 32 hex nibbles, map 0..f to a..p.
  const digest = crypto.createHash('sha256').update(extensionPath).digest('hex').slice(0, 32);
  const extensionId = Array.from(digest, ch => String.fromCharCode(97 + parseInt(ch, 16))).join('');

  const page = await browser.newPage();
  const popupUrl = 'chrome-extension://' + extensionId + '/popup.html';
  let lastError = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await page.goto(popupUrl, { waitUntil: 'domcontentloaded', timeout:5000 });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  if (lastError) throw lastError;

  const result = await page.evaluate(async () => {
    const jobId = 'browser-smoke-' + Date.now();
    const prepared = await chrome.runtime.sendMessage({
      type: 'CGX_PREPARE_PDF_WORKER',
      jobId
    });
    if (!prepared?.ok) return { prepared, rendered:null };

    const definition = {
      pageSize: 'A4',
      pageMargins: [51, 51, 51, 55],
      defaultStyle: { font:'Roboto', fontSize:10.5 },
      content: [{
        text: [
          { text:'English ' },
          { text:'සිංහල ', cgxFont:'sinhala' },
          { text:'தமிழ் ', cgxFont:'tamil' },
          { text:'한국어 ', cgxFont:'korean' },
          { text:'→ ✓ ', cgxFont:'symbols' },
          { text:'😀', cgxFont:'emoji' }
        ]
      }, {
        cgxPreformatted: {
          text:'Clinician App\n    │\n    ▼\nCentral Backend',
          diagram:true,
          language:'text'
        }
      }]
    };

    const rendered = await chrome.runtime.sendMessage({
      target: 'cgx-offscreen-pdf',
      type: 'CGX_OFFSCREEN_SMOKE_RENDER',
      jobId,
      definition
    });
    return { prepared, rendered };
  });

  if (!result?.prepared?.ok) {
    throw new Error('Real Chrome could not prepare offscreen renderer: ' + JSON.stringify(result));
  }
  if (!result?.rendered?.ok) {
    throw new Error('Real Chrome offscreen renderer failed: ' + JSON.stringify(result));
  }
  if (result.rendered.magic !== '%PDF') {
    throw new Error('Renderer did not produce a PDF header: ' + JSON.stringify(result.rendered));
  }
  if (!(result.rendered.bytes > 1000)) {
    throw new Error('Renderer produced an unexpectedly small PDF: ' + JSON.stringify(result.rendered));
  }

  process.stdout.write(
    'Chrome extension smoke passed: ' +
    result.rendered.bytes +
    ' bytes, header ' +
    result.rendered.magic +
    '\n'
  );
} finally {
  await browser.close();
  fs.rmSync(userDataDir, { recursive:true, force:true });
}
