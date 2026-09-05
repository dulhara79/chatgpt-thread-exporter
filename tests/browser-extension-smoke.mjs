import puppeteer from 'puppeteer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const extensionPath = path.resolve('.');
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgx-chrome-'));
const browser = await puppeteer.launch({
  headless: false,
  userDataDir,
  enableExtensions: [extensionPath],
  args: ['--no-sandbox', '--disable-dev-shm-usage']
});

try {
  const target = await browser.waitForTarget(
    item => item.type() === 'service_worker' && item.url().endsWith('/background.js'),
    { timeout:20000 }
  );
  const extensionId = new URL(target.url()).host;
  if (!extensionId) throw new Error('Could not determine unpacked extension id.');

  const page = await browser.newPage();
  await page.goto('chrome-extension://' + extensionId + '/popup.html', {
    waitUntil:'domcontentloaded',
    timeout:10000
  });

  const prepared = await page.evaluate(async () => {
    const jobId = 'browser-smoke-' + Date.now();
    globalThis.__cgxSmokeJobId = jobId;
    return chrome.runtime.sendMessage({
      type: 'CGX_PREPARE_PDF_WORKER',
      jobId
    });
  });
  process.stdout.write('Prepare result: ' + JSON.stringify(prepared) + '\n');
  if (!prepared?.ok) {
    throw new Error('Real Chrome could not prepare offscreen renderer: ' + JSON.stringify(prepared));
  }

  const offscreenTarget = await browser.waitForTarget(
    item => item.url().endsWith('/pdf-worker.html'),
    { timeout:10000 }
  );
  process.stdout.write('Offscreen target: ' + offscreenTarget.type() + ' ' + offscreenTarget.url() + '\n');
  try {
    const offscreenPage = await offscreenTarget.asPage();
    offscreenPage?.on('console', msg => process.stdout.write('[offscreen console] ' + msg.text() + '\n'));
    offscreenPage?.on('pageerror', error => process.stdout.write('[offscreen error] ' + error.message + '\n'));
  } catch (error) {
    process.stdout.write('Could not attach offscreen diagnostics: ' + error.message + '\n');
  }

  const accepted = await page.evaluate(async () => {
    const jobId = globalThis.__cgxSmokeJobId;
    const definition = {
      pageSize:'A4',
      pageMargins:[51, 51, 51, 55],
      defaultStyle:{ font:'Roboto', fontSize:10.5 },
      content:[{
        text:[
          { text:'English ' },
          { text:'සිංහල ', cgxFont:'sinhala' },
          { text:'தமிழ் ', cgxFont:'tamil' },
          { text:'한국어 ', cgxFont:'korean' },
          { text:'→ ✓ ', cgxFont:'symbols' },
          { text:'😀', cgxFont:'emoji' }
        ]
      }, {
        cgxPreformatted:{
          text:'Clinician App\\n    │\\n    ▼\\nCentral Backend',
          diagram:true,
          language:'text'
        }
      }]
    };
    return chrome.runtime.sendMessage({
      target:'cgx-offscreen-pdf',
      type:'CGX_OFFSCREEN_START_SMOKE',
      jobId,
      definition
    });
  });
  process.stdout.write('Start result: ' + JSON.stringify(accepted) + '\n');
  if (!accepted?.ok || !accepted?.accepted) {
    throw new Error('Real Chrome offscreen renderer did not accept smoke job: ' + JSON.stringify(accepted));
  }

  const renderStartedAt = Date.now();
  let rendered = null;
  while (Date.now() - renderStartedAt < 60000) {
    try {
      const status = await Promise.race([
        page.evaluate(async () => chrome.runtime.sendMessage({
          target:'cgx-offscreen-pdf',
          type:'CGX_OFFSCREEN_PDF_STATUS',
          jobId:globalThis.__cgxSmokeJobId
        })),
        new Promise(resolve => setTimeout(() => resolve(null), 1200))
      ]);
      if (status?.found && status.state === 'done') {
        rendered = { ok:true, jobId:status.jobId, ...status.result };
        break;
      }
      if (status?.found && status.state === 'error') {
        rendered = { ok:false, jobId:status.jobId, error:status.error };
        break;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!rendered) {
    rendered = { ok:false, error:'Browser smoke polling deadline exceeded.' };
  }
  rendered.elapsedMs = Date.now() - renderStartedAt;
  process.stdout.write('Render result: ' + JSON.stringify(rendered) + '\n');
  const result = { prepared, rendered };

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
