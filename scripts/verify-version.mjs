// Usage: node scripts/verify-version.mjs v1.0.1
// Fails when a release tag does not match manifest.json / package.json, so a mistagged release never ships.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tag = (process.argv[2] || '').replace(/^v/, '');
const read = (f) => JSON.parse(readFileSync(join(ROOT, f), 'utf8')).version;
const manifest = read('manifest.json');
const pkg = read('package.json');

const problems = [];
if (!/^\d+\.\d+\.\d+$/.test(tag)) problems.push(`Tag "${process.argv[2]}" is not of the form vMAJOR.MINOR.PATCH`);
if (tag !== manifest) problems.push(`Tag ${tag} != manifest.json version ${manifest}`);
if (tag !== pkg) problems.push(`Tag ${tag} != package.json version ${pkg}`);

if (problems.length) {
  for (const p of problems) console.error('✗ ' + p);
  console.error('Run: node scripts/bump.mjs <version>, commit, then tag again.');
  process.exit(1);
}
console.log(`✓ Tag v${tag} matches manifest.json and package.json`);
