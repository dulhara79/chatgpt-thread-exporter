import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  const target = await browser.waitForTarget(
    item => item.type() === 'service_worker' && item.url().startsWith('chrome-extension://'),
    { timeout: 20000 }
  );
  const extensionId = new URL(target.url()).host;
  if (!extensionId) throw new Error('Could not determine unpacked extension id.');

  const page = await browser.newPage();
  await page.goto('chrome-extension://' + extensionId + '/popup.html', { waitUntil: 'domcontentloaded' });

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
