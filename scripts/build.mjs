#!/usr/bin/env node
/**
 * Produces a Chrome Web Store-ready zip in dist/.
 *
 * The file list is derived from manifest.json rather than hand-maintained, so
 * a newly added module cannot be left out of the package.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

/** Every file the extension actually loads, plus its static assets. */
function packagedFiles() {
  const files = new Set(['manifest.json', 'LICENSE']);

  for (const entry of manifest.content_scripts || []) {
    (entry.js || []).forEach(file => files.add(file));
    (entry.css || []).forEach(file => files.add(file));
  }
  if (manifest.background?.service_worker) files.add(manifest.background.service_worker);
  if (manifest.action?.default_popup) files.add(manifest.action.default_popup);
  if (manifest.options_page) files.add(manifest.options_page);

  // Scripts referenced from bundled HTML pages.
  for (const page of ['popup.html', 'options.html', 'pdf-worker.html']) {
    if (!fs.existsSync(path.join(ROOT, page))) continue;
    files.add(page);
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      if (!/^https?:/.test(match[1])) files.add(match[1]);
    }
  }
  files.add('pdf-worker.html');

  // Fonts and icons referenced at runtime rather than by tag.
  for (const dir of ['vendor/fonts', 'icons']) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) files.add(path.join(dir, name));
  }

  return [...files].sort();
}

const files = packagedFiles();
const missing = files.filter(file => !fs.existsSync(path.join(ROOT, file)));
if (missing.length) {
  console.error('Refusing to build; referenced files are missing:\n  ' + missing.join('\n  '));
  process.exit(1);
}

const dist = path.join(ROOT, 'dist');
fs.mkdirSync(dist, { recursive: true });
const output = path.join(dist, `ai-thread-exporter-${manifest.version}.zip`);
fs.rmSync(output, { force: true });

execFileSync('zip', ['-q', '-X', output, ...files], { cwd: ROOT });

const size = (fs.statSync(output).size / 1024 / 1024).toFixed(2);
console.log(`Built ${path.relative(ROOT, output)} (${size} MB, ${files.length} files)`);
