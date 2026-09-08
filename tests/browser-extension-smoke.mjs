import puppeteer from 'puppeteer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const extensionPath = path.resolve('.');
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgx-chrome-'));

// This test needs a real Chrome because MV3 offscreen documents cannot be
// emulated. Skip cleanly where the browser was not downloaded (sandboxed dev
// environments) rather than failing for an unrelated reason; CI installs it
// explicitly, so the coverage is not lost where it matters.
let browser;
try {
  browser = await puppeteer.launch({
    headless: false,
    pipe: true,
    userDataDir,
    enableExtensions: [extensionPath],
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
} catch (error) {
  if (/Could not find Chrome|Browser was not found/i.test(String(error?.message))) {
    process.stdout.write(
      'SKIP: Chrome is not installed. Run `npx puppeteer browsers install chrome` to enable this test.\n'
    );
    fs.rmSync(userDataDir, { recursive: true, force: true });
    process.exit(0);
  }
  throw error;
}

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
          { text:'English ', bold:true },
          { text:' Monospace custom font', cgxFont:'mono' }
        ]
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
  let lastStatus = null;
  while (Date.now() - renderStartedAt < 20000) {
    try {
      const status = await Promise.race([
        page.evaluate(async () => chrome.runtime.sendMessage({
          target:'cgx-offscreen-pdf',
          type:'CGX_OFFSCREEN_PDF_STATUS',
          jobId:globalThis.__cgxSmokeJobId
        })),
        new Promise(resolve => setTimeout(() => resolve(null), 1200))
      ]);
      if (status?.found) lastStatus = status;
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
    rendered = {
      ok:false,
      error:'Browser smoke polling deadline exceeded.',
      lastStatus
    };
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

  // Selector canary: run the real adapter modules against committed fixtures
  // in real Chrome. Do not depend on content-script injection into an
  // intercepted chatgpt.com/claude.ai response: recent Chrome builds can
  // deliberately suppress extension injection for DevTools-synthesized
  // navigation responses. The extension itself was already exercised above
  // through its service worker and offscreen PDF document.
  const adapterSources = [
    'src/platforms/adapter.js',
    'src/platforms/chatgpt.js',
    'src/platforms/claude.js',
    'src/platforms/registry.js'
  ].map(file => fs.readFileSync(file, 'utf8'));

  for (const [name, url] of [
    ['chatgpt-thread.html', 'https://chatgpt.com/c/smoke'],
    ['claude-thread.html', 'https://claude.ai/chat/smoke']
  ]) {
    const fixtureHtml = fs.readFileSync(path.join('tests', 'fixtures', name), 'utf8');
    const fixturePage = await browser.newPage();
    await fixturePage.setContent(fixtureHtml, { waitUntil: 'domcontentloaded' });
    for (const source of adapterSources) {
      await fixturePage.addScriptTag({ content: source });
    }

    const summary = await fixturePage.evaluate(async targetUrl => {
      const adapter = globalThis.ThreadExporterRegistry?.detect(targetUrl);
      if (!adapter) return { error: 'no adapter resolved' };
      const turns = adapter.turnContainers();

      let artifactCapture = null;
      if (adapter.id === 'claude') {
        const firstAnswer = adapter.assistantNodes(turns[0])[0];
        const card = document.createElement('button');
        // Use a title-only visual card with no artifact/test-id wording so the
        // real-Chrome smoke exercises the resilient fallback discovery path.
        card.className = 'rounded-card border';
        card.innerHTML = '<svg width="16" height="16" aria-hidden="true"></svg><span>Smoke research report</span>';
        firstAnswer.appendChild(card);
        card.addEventListener('click', () => {
          if (document.querySelector('[data-testid="artifact-content"]')) return;
          const panel = document.createElement('aside');
          panel.className = 'artifact-panel';
          panel.innerHTML =
            '<div data-testid="artifact-content"><article class="prose"><h2>Artifact smoke</h2><p>Captured body.</p></article></div>';
          document.body.appendChild(panel);
        });

        adapter.resetCaptureDiagnostics?.();
        const captured = await adapter.captureArtifacts(firstAnswer);
        artifactCapture = {
          cards: captured.length,
          body: captured[0]?.__cgxArtifactPanel?.textContent || '',
          diagnostics: adapter.captureDiagnostics?.() || null
        };
      }

      return {
        platform: adapter.id,
        turns: turns.length,
        answers: turns.reduce((sum, turn) => sum + adapter.assistantNodes(turn).length, 0),
        title: adapter.conversationTitle(),
        artifactCapture,
        misses: globalThis.ThreadExporterAdapterKit.diagnostics.snapshot().misses
      };
    }, url);

    process.stdout.write(name + ' -> ' + JSON.stringify(summary) + '\n');
    if (summary.error) throw new Error(name + ': ' + summary.error);
    if (!(summary.turns > 0)) throw new Error(name + ': no turns resolved in real Chrome');
    if (!(summary.answers > 0)) throw new Error(name + ': no assistant messages resolved');
    if (summary.platform === 'claude') {
      if (!(summary.artifactCapture?.cards > 0)) throw new Error(name + ': artifact card was not detected');
      if (!summary.artifactCapture?.body.includes('Captured body.')) {
        throw new Error(name + ': live artifact body was not captured: ' + JSON.stringify(summary.artifactCapture));
      }
    }
    await fixturePage.close();
  }
} finally {
  await browser.close();
  fs.rmSync(userDataDir, { recursive:true, force:true });
}
