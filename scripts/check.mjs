// Static checks run in CI and before a release:
//   1. every source file parses (as a module or a classic script, whichever it is)
//   2. relative imports resolve
//   3. manifest.json references only files that exist, and locale files are consistent
//   4. every Chinese UI string has an English translation
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectFiles } from './build.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warnings = [];
const fail = (m) => errors.push(m);
const read = (f) => readFileSync(join(ROOT, f), 'utf8');
for (const f of ['README.md', 'README.zh-CN.md']) {
  if (read(f).startsWith('\uFEFF')) fail(`${f} must use UTF-8 without a BOM (see .editorconfig)`);
}
const CJK = /[一-龥]/;

/* 1 + 2: syntax and imports */

const srcFiles = readdirSync(join(ROOT, 'src')).filter((f) => f.endsWith('.js'));
for (const f of srcFiles) {
  const code = read(`src/${f}`);
  const isModule = /^\s*(import|export)\s/m.test(code);
  const args = isModule ? ['--input-type=module', '--check'] : ['--check', '-'];
  const r = spawnSync(process.execPath, args, { input: code, encoding: 'utf8' });
  if (r.status !== 0)
    fail(
      `Syntax error in src/${f} (${isModule ? 'module' : 'classic script'}):\n${(r.stderr || '').split('\n').slice(0, 6).join('\n')}`,
    );
  if (isModule) {
    for (const m of code.matchAll(/from\s+'(\.[^']+)'/g)) {
      if (!existsSync(resolve(ROOT, 'src', m[1]))) fail(`src/${f} imports missing file ${m[1]}`);
    }
  }
}

/* 3: manifest and locales */

const manifest = JSON.parse(read('manifest.json'));
const needFile = (p, why) => {
  if (p && !existsSync(join(ROOT, p))) fail(`manifest.json: ${why} points to missing file "${p}"`);
};
if (!/^\d+\.\d+\.\d+$/.test(manifest.version))
  fail(`manifest.json: version "${manifest.version}" is not MAJOR.MINOR.PATCH`);
needFile(manifest.background?.service_worker, 'background.service_worker');
needFile(manifest.side_panel?.default_path, 'side_panel.default_path');
for (const p of Object.values(manifest.icons || {})) needFile(p, 'icons');
for (const cs of manifest.content_scripts || []) for (const p of cs.js || []) needFile(p, 'content_scripts');
for (const r of manifest.declarative_net_request?.rule_resources || []) needFile(r.path, 'declarative_net_request');

const localeDirs = existsSync(join(ROOT, '_locales')) ? readdirSync(join(ROOT, '_locales')) : [];
if (manifest.default_locale && !localeDirs.includes(manifest.default_locale))
  fail(`default_locale "${manifest.default_locale}" has no _locales folder`);
const keysByLocale = {};
for (const l of localeDirs) keysByLocale[l] = Object.keys(JSON.parse(read(`_locales/${l}/messages.json`))).sort();
for (const l of localeDirs) {
  if (JSON.stringify(keysByLocale[l]) !== JSON.stringify(keysByLocale[localeDirs[0]]))
    fail(`_locales/${l} has different message keys than _locales/${localeDirs[0]}`);
}
for (const m of JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)) {
  for (const l of localeDirs)
    if (!keysByLocale[l].includes(m[1])) fail(`manifest uses __MSG_${m[1]}__ but _locales/${l} lacks it`);
}

// Packaging dry run (nothing is written): every file the manifest refers to must be part of the package,
// so a release can never ship an extension that is missing one.
const packaged = new Set(collectFiles(ROOT).map((f) => f.name));
const referenced = [
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
  ...(manifest.content_scripts || []).flatMap((cs) => cs.js || []),
  ...(manifest.declarative_net_request?.rule_resources || []).map((r) => r.path),
];
for (const p of referenced.filter(Boolean))
  if (!packaged.has(p)) fail(`"${p}" is referenced by manifest.json but would not be included in the package`);

// 4: i18n coverage

// src/ has no package.json "type", so Node detects the ES module syntax and prints a harmless warning
process.removeAllListeners('warning');
const { EN, TABLES } = await import(pathToFileURL(join(ROOT, 'src/i18n.js')).href);
// Every extra language must translate exactly the same strings as English
for (const [code, [table, patterns]] of Object.entries(TABLES)) {
  for (const k of Object.keys(EN)) if (table[k] === undefined) fail(`${code} is missing a translation for: "${k}"`);
  for (const k of Object.keys(table)) if (EN[k] === undefined) fail(`${code} has a string that English does not have: "${k}"`);
  for (const k of Object.keys(EN)) {
    const ph = (x) => (x.match(/\{\w+\}/g) || []).sort().join();
    if (table[k] !== undefined && ph(table[k]) !== ph(k)) fail(`${code} changes the {placeholders} of: "${k}"`);
  }
  if (patterns.length !== TABLES.en[1].length) fail(`${code} has a different number of message patterns than English`);
}
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const EN_RE = [/^不支持的加密方式：/, /^\d+p · 视频\+音频分开$/];
const known = (s) => EN[s] !== undefined || EN_RE.some((re) => re.test(s));
const unescape = (s) => s.replace(/\\n/g, '\n').replace(/\\'/g, "'");

// static HTML: text nodes and title / placeholder / aria-label
const html = read('src/sidepanel.html')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .replace(/<style[\s\S]*?<\/style>/g, '');
const staticStrings = new Set();
for (const m of html.matchAll(/>([^<>]+)</g)) if (CJK.test(m[1])) staticStrings.add(norm(m[1]));
for (const m of html.matchAll(/\b(?:title|placeholder|aria-label)="([^"]+)"/g))
  if (CJK.test(m[1])) staticStrings.add(norm(m[1]));
for (const s of staticStrings) if (!known(s)) fail(`Missing English translation for HTML text: "${s}"`);

// side panel script: every T('...') / T(cond ? '...' : '...') literal
for (const file of ['sidepanel.js', 'notices.js']) {
  const panel = read(`src/${file}`);
  for (const m of panel.matchAll(/\bT\(\s*(?:[^'()`]*\?\s*)?'((?:[^'\\]|\\.)*)'(?:\s*:\s*'((?:[^'\\]|\\.)*)')?/g)) {
    for (const s of [m[1], m[2]].filter(Boolean))
      if (CJK.test(s) && !known(unescape(s))) fail(`Missing English translation for T('${s}') in src/${file}`);
  }
  // Chinese literals that bypass T() (warning only: some are brand names, separators or comments)
  for (const [i, line] of panel.split('\n').entries()) {
    const code = line.replace(/\/\/.*$/, '');
    if (!CJK.test(code) || /\bT\(/.test(code)) continue;
    warnings.push(`src/${file}:${i + 1} has Chinese text outside T(): ${code.trim().slice(0, 80)}`);
  }
}

// messages produced elsewhere and shown through T(msg)
for (const f of ['background.js', 'sites.js', 'mse.js', 'offscreen.js']) {
  const code = read(`src/${f}`).replace(/\/\/.*$/gm, '');
  for (const m of code.matchAll(/(?:error|msg|Error\()\s*[:(]?\s*(?:[^'"`]*\|\|\s*)?'((?:[^'\\]|\\.)*)'/g)) {
    const s = unescape(m[1]);
    if (CJK.test(s) && !known(s)) fail(`Missing English translation for message in src/${f}: "${s}"`);
  }
}

for (const w of warnings) console.warn('! ' + w);
if (errors.length) {
  for (const e of errors) console.error('✗ ' + e);
  console.error(`\n${errors.length} problem(s) found.`);
  process.exit(1);
}
console.log(
  `✓ ${srcFiles.length} source files parse, manifest and locales are consistent, ${Object.keys(EN).length} translations cover the UI`,
);
