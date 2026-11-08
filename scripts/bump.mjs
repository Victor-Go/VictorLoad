// Usage: node scripts/bump.mjs 1.2.3
// Sets the version in manifest.json and package.json for a future release.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];

if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
  console.error('Usage: node scripts/bump.mjs <major.minor.patch>   e.g. 1.0.1');
  process.exit(1);
}

function patchJson(file) {
  const p = join(ROOT, file);
  const text = readFileSync(p, 'utf8');
  const next = text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`);
  if (next === text && !text.includes(`"version": "${version}"`)) throw new Error(`No version field found in ${file}`);
  writeFileSync(p, next);
}
patchJson('manifest.json');
patchJson('package.json');

console.log(`Version set to ${version}.\n`);
console.log('Next:');
console.log('  1. git add manifest.json package.json');
console.log(`  2. git commit -m "Release v${version}"`);
console.log('  3. git push origin main');
console.log('     (the Release workflow creates the tag, builds the ZIP, and publishes the GitHub release)');
