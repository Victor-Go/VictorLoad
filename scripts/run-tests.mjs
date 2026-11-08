// Runs every test/*.test.mjs with the built-in node:test runner (works the same on every OS / Node version).
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = readdirSync(join(ROOT, 'test'))
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()
  .map((f) => join('test', f));

// --no-warnings: src/*.js are ES modules without a package.json "type" (they are loaded by Chrome, not Node)
const r = spawnSync(process.execPath, ['--no-warnings', '--test', ...files], { cwd: ROOT, stdio: 'inherit' });
process.exit(r.status ?? 1);
