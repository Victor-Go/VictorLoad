import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatName,
  fmtDurName,
  normKey,
  pageKeyOf,
  safeName,
  classifyImages,
  isMainVideo,
  DEFAULTS,
} from '../src/shared.js';

const vars = { tab: 'Hello World', name: 'clip_001', duration: '2m05s', resolution: '1080p' };

test('formatName expands the four placeholders', () => {
  assert.equal(formatName('{tab}', vars), 'Hello World');
  assert.equal(formatName('{name}', vars), 'clip_001');
  assert.equal(formatName('{tab} [{resolution}]', vars), 'Hello World [1080p]');
  assert.equal(formatName('{tab}_{duration}_{resolution}', vars), 'Hello World_2m05s_1080p');
});

test('formatName falls back to the tab title for an empty template', () => {
  assert.equal(formatName('', vars), 'Hello World');
  assert.equal(formatName(undefined, vars), 'Hello World');
});

test('formatName drops empty brackets and dangling separators', () => {
  assert.equal(formatName('{tab} [{resolution}] {duration}', { tab: 'T' }), 'T');
  assert.equal(formatName('{tab} - {duration}', { tab: 'T' }), 'T');
});

test('formatName removes characters that are illegal in file names', () => {
  assert.equal(formatName('{tab}', { tab: 'a/b:c?d*e' }), 'a b c d e');
});

test('formatName keeps long titles (up to 120 characters per value)', () => {
  assert.equal(formatName('{tab}', { tab: 'L'.repeat(130) }).length, 120);
});

test('fmtDurName', () => {
  assert.equal(fmtDurName(45), '45s');
  assert.equal(fmtDurName(332), '5m32s');
  assert.equal(fmtDurName(3723), '1h02m03s');
  assert.equal(fmtDurName(0), '');
  assert.equal(fmtDurName(NaN), '');
});

test('normKey: twitter media variants share one key', () => {
  assert.equal(normKey('https://pbs.twimg.com/media/ABC123?format=jpg&name=small'), 'tw:ABC123');
  assert.equal(normKey('https://pbs.twimg.com/media/ABC123.png'), 'tw:ABC123');
  assert.equal(normKey('https://example.com/a.jpg#frag'), 'https://example.com/a.jpg');
});

test('pageKeyOf: single-video pages', () => {
  assert.equal(pageKeyOf('https://www.youtube.com/watch?v=abc&t=5'), 'page:yt:abc');
  assert.equal(pageKeyOf('https://www.bilibili.com/video/BV1xx?p=2'), 'page:https://www.bilibili.com/video/BV1xx?p=2');
  assert.equal(pageKeyOf('https://www.bilibili.com/video/BV1xx?p=1'), 'page:https://www.bilibili.com/video/BV1xx');
});

test('safeName', () => {
  assert.equal(safeName('  a<b>c  '), 'a b c');
  assert.equal(safeName('x'.repeat(200), 10), 'xxxxxxxxxx');
});

test('classifyImages: size rules, site rules and tag-structure promotion', () => {
  const imgs = [
    { id: 1, w: 1200, h: 800, sig: 'gallery', keys: [] },
    { id: 2, w: 200, h: 200, sig: 'gallery' }, // small but same structure as a main image
    { id: 3, w: 80, h: 80, sig: 'icons' }, // too small, different structure
    { id: 4, w: 2000, h: 2000, sig: 'nav', inChrome: true }, // inside nav/header/footer
    { id: 5, siteMain: true, sig: 'tweet' }, // site rule says main
    { id: 6, w: 3000, h: 3000, siteMain: false, sig: 'avatar' }, // site rule says not main
  ];
  const main = classifyImages(imgs, DEFAULTS, new Set(), {});
  assert.deepEqual([...main].sort(), [1, 2, 5]);
});

test('classifyImages: remembered tag structures win', () => {
  const main = classifyImages([{ id: 1, w: 50, h: 50, sig: 'mine' }], DEFAULTS, new Set(['mine']), {});
  assert.deepEqual([...main], [1]);
});

test('isMainVideo: resolution and duration thresholds', () => {
  assert.equal(isMainVideo({ qualities: [{ height: 720 }], duration: 60 }, DEFAULTS, new Set()), true);
  assert.equal(isMainVideo({ qualities: [{ height: 144 }], duration: 60 }, DEFAULTS, new Set()), false);
  assert.equal(isMainVideo({ qualities: [{ height: 720 }], duration: 3 }, DEFAULTS, new Set()), false);
  assert.equal(isMainVideo({ siteMain: true, qualities: [] }, DEFAULTS, new Set()), true);
});

test('the interface defaults to Chinese', () => {
  assert.equal(DEFAULTS.uiLang, 'auto');
});

test('expandSavePath expands placeholders and never leaves the Downloads folder', async () => {
  const { expandSavePath, mergeSettings } = await import('../src/shared.js');
  const now = new Date(2026, 10, 8);
  assert.equal(expandSavePath('VictorLoad/{site}/', { site: 'example.com' }, now), 'VictorLoad/example.com/');
  assert.equal(expandSavePath('{site}/{year}-{month}', { site: 'a.b' }, now), 'a.b/2026-11/');
  assert.equal(expandSavePath('{date}', {}, now), '2026-11-08/');
  assert.equal(expandSavePath('{site}', {}, now), 'misc/');
  assert.equal(expandSavePath('', { site: 'a' }, now), '');
  assert.equal(expandSavePath('../..\\x/./{site}', { site: 'a:b' }, now), 'x/a b/');
  assert.equal(expandSavePath('C:\\Users', { site: 'a' }, now), 'C/Users/');
  assert.equal(expandSavePath('//', { site: 'a' }, now), '');
  // the old "one folder per site" switch is carried over
  assert.equal(mergeSettings({}).savePath, 'VictorLoad/{site}/');
  assert.equal(mergeSettings({ subfolder: true }).savePath, 'VictorLoad/{site}/');
  assert.equal(mergeSettings({ subfolder: false }).savePath, '');
  assert.equal(mergeSettings({ subfolder: false, savePath: 'x' }).savePath, 'x');
  assert.equal('subfolder' in mergeSettings({ subfolder: false }), false);
});
