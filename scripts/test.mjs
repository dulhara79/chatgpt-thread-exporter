#!/usr/bin/env node
/**
 * Cross-platform test runner.
 *
 * `node --test tests/` does not accept a directory on every Node version, and
 * `node --test tests/*.test.js` relies on shell globbing, which cmd.exe and
 * PowerShell do not do. So we discover the files here and pass explicit paths.
 *
 *   node scripts/test.mjs            all suites
 *   node scripts/test.mjs unit       fast suites only (no browser)
 *   node scripts/test.mjs smoke      real-Chrome smoke test only
 *   node scripts/test.mjs adapters   any substring match against filenames
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = path.join(ROOT, 'tests');

const GROUPS = {
  unit: name => name.endsWith('.test.js') && !name.includes('font-smoke'),
  smoke: name => name.includes('smoke'),
  all: name => /\.(test\.js|test\.mjs)$/.test(name) || name.endsWith('-smoke.mjs')
};

const filterArg = process.argv[2] || 'all';
const match = GROUPS[filterArg] || (name => GROUPS.all(name) && name.includes(filterArg));

const files = fs.readdirSync(TESTS)
  .filter(name => GROUPS.all(name) && match(name))
  .sort()
  // Relative POSIX-style paths work on every platform Node supports.
  .map(name => 'tests/' + name);

if (!files.length) {
  console.error(`No test files matched "${filterArg}".`);
  process.exit(1);
}

console.log(`Running ${files.length} test file(s):\n  ${files.join('\n  ')}\n`);

const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: ROOT,
  stdio: 'inherit'
});

process.exit(result.status ?? 1);
