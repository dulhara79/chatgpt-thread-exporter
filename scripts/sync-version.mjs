#!/usr/bin/env node
/**
 * Keeps the version consistent across manifest.json, package.json and the
 * README badge. manifest.json is the single source of truth.
 *
 *   node scripts/sync-version.mjs          rewrite the others to match
 *   node scripts/sync-version.mjs --check  fail if they already disagree (CI)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const write = (file, text) => fs.writeFileSync(path.join(ROOT, file), text);

const manifest = JSON.parse(read('manifest.json'));
const version = manifest.version;

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`manifest.json version "${version}" is not MAJOR.MINOR.PATCH`);
  process.exit(1);
}

const problems = [];

// package.json
const pkgRaw = read('package.json');
const pkg = JSON.parse(pkgRaw);
if (pkg.version !== version) {
  problems.push(`package.json is ${pkg.version}, manifest is ${version}`);
  if (!check) write('package.json', pkgRaw.replace(/"version":\s*"[^"]*"/, `"version": "${version}"`));
}

// package-lock.json root package metadata
if (fs.existsSync(path.join(ROOT, 'package-lock.json'))) {
  const lockRaw = read('package-lock.json');
  const lock = JSON.parse(lockRaw);
  const rootVersion = lock.packages?.['']?.version;
  if (lock.version !== version || rootVersion !== version) {
    problems.push(`package-lock.json is ${lock.version}/${rootVersion}, manifest is ${version}`);
    if (!check) {
      lock.version = version;
      if (lock.packages?.['']) lock.packages[''].version = version;
      write('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
    }
  }
}

// README heading, e.g. "# AI Thread Exporter (V0.6.0)"
if (fs.existsSync(path.join(ROOT, 'README.md'))) {
  const readme = read('README.md');
  const match = /\(V(\d+\.\d+\.\d+)\)/.exec(readme);
  if (match && match[1] !== version) {
    problems.push(`README.md is V${match[1]}, manifest is ${version}`);
    if (!check) write('README.md', readme.replace(/\(V\d+\.\d+\.\d+\)/, `(V${version})`));
  }
}

// The popup must read its version from the manifest at runtime, never hard-code it.
if (/V\d+\.\d+\.\d+/.test(read('popup.html'))) {
  problems.push('popup.html hard-codes a version; it should read chrome.runtime.getManifest().version');
}

if (check) {
  if (problems.length) {
    console.error('Version drift detected:\n  ' + problems.join('\n  '));
    process.exit(1);
  }
  console.log(`Version ${version} is consistent.`);
} else {
  console.log(problems.length ? `Synced to ${version}:\n  ${problems.join('\n  ')}` : `Already at ${version}.`);
}
