// "New tab" YouTube downloads and mode changes, driven through src/background.js with a fake chrome API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeChrome, createStorage } from './helpers/fake-chrome.mjs';

const storage = createStorage({ local: { settings: { ytMode: 'tab', nameFormat: '{title}', nameFormatV: 2 } } });
const sent = [];
const created = [];
const updated = [];
let playerLevels = [];
const removed = [];
const fake = createFakeChrome({
  overrides: {
    ...storage.overrides,
    'runtime.sendMessage': async (m) => void sent.push(m),
    'tabs.sendMessage': async (id, m) => (sent.push({ to: id, m }), { ok: true }),
    'tabs.get': async (id) => ({ id, url: 'https://www.youtube.com/watch?v=abc', title: 'T - YouTube', status: 'complete' }),
    'tabs.create': async (o) => (created.push(o), { id: 2 }),
    'tabs.remove': async (id) => void removed.push(id),
    'tabs.onUpdated.removeListener': () => {},
    'tabs.update': async (id, o) => void updated.push({ id, ...o }),
    'downloads.search': async () => [],
    'runtime.getContexts': async () => [],
    'scripting.getRegisteredContentScripts': async () => [],
    'scripting.executeScript': async () => [{ result: playerLevels }],
    'i18n.getUILanguage': () => 'zh-CN',
  },
});
globalThis.chrome = fake.chrome;
const fmt = (mimeType, height) => ({ mimeType, height, bitrate: 1 });
globalThis.fetch = async () =>
  Response.json({
    videoDetails: { title: 'V', lengthSeconds: '60' },
    streamingData: { adaptiveFormats: [fmt('video/mp4; codecs="avc1.640028"', 1080), fmt('audio/mp4; codecs="mp4a"', 0)] },
  });
console.warn = () => {};
await import('../src/background.js');

const onMessage = fake.handlers['runtime.onMessage'][0];
const call = (m, s = {}) => new Promise((res) => onMessage(m, s, res));
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const URL1 = 'https://www.youtube.com/watch?v=abc';
const scan = (tabId, pageUrl = URL1) =>
  call({ type: 'scan', pageUrl, title: 'V - YouTube', images: [], videos: [], site: [], keys: [] }, { tab: { id: tabId }, frameId: 0 });
const videos = async () => (await call({ type: 'getState', tabId: 1 })).videos;

test('cancelling a new-tab download closes the background tab and tells the panel, even before it started recording', async () => {
  await scan(1);
  await tick(200);
  const [item] = await videos();
  assert.deepEqual(item.qualities.map((q) => q.type), ['tab']);
  await call({ type: 'download', tabId: 1, entries: [{ item, q: 0 }] });
  assert.match(created[0].url, /vl_dl=1&vl_h=1080&vl_job=[a-z0-9]+&vl_name=V&vl_tag=%E3%80%90VL[^&]+$/); // the file name rides along: the tab saves the file itself
  assert.equal(created[0].active, false);
  await tick(900); // once loaded, the tab is shown for a moment (Chrome limits playback in a never-visible tab)...
  assert.deepEqual(updated, [{ id: 2, muted: true }, { id: 2, active: true }, { id: 1, active: true }]); // ...then the tab you were on is brought back
  sent.length = 0;
  const r = await call({ type: 'capture-ctl', tabId: 1, cmd: 'fill-stop' });
  assert.equal(r.ok, true);
  for (let i = 0; i < 40 && !removed.length; i++) await tick(25); // the tab is closed after its files are cleaned up
  assert.deepEqual(removed, [2]);
  assert.deepEqual(sent.filter((m) => m.type === 'dl').map((m) => m.state), ['cancelled']);
  assert.ok(!sent.some((m) => m.to === 2 && m.m.cmd !== 'cleanup'), 'only the file cleanup is sent to the closed tab');
  // The card is untouched: the same option is still offered
  assert.deepEqual((await videos())[0].qualities.map((q) => q.type), ['tab']);
});

test('after the mode changes, a page that is still open says it needs a reload, until it is reloaded', async () => {
  globalThis.fetch = async () => {
    throw new Error('offline'); // no direct links, as often happens: only a page with the capture script can offer anything
  };
  const old = { ...storage.store.local.settings };
  storage.store.local.settings = { ...old, ytMode: 'page' };
  for (const f of fake.handlers['storage.onChanged']) f({ settings: { oldValue: old, newValue: storage.store.local.settings } }, 'local');
  await tick(200);
  const [item] = await videos();
  assert.equal(item.qualities.length, 0);
  assert.equal(item.needsReload, true);
  for (const f of fake.handlers['webNavigation.onCommitted']) f({ tabId: 1, frameId: 0, url: URL1 });
  await tick(100);
  assert.notEqual((await call({ type: 'getState', tabId: 1 })).videos[0]?.needsReload, true);
});

test('when YouTube lists no formats, new-tab mode takes the heights from the player instead of showing an empty card', async () => {
  const old = { ...storage.store.local.settings };
  storage.store.local.settings = { ...old, ytMode: 'tab' };
  for (const f of fake.handlers['storage.onChanged']) f({ settings: { oldValue: old, newValue: storage.store.local.settings } }, 'local');
  playerLevels = ['hd2160', 'hd1440', 'hd1080', 'hd720', 'large', 'auto'];
  await scan(3, 'https://www.youtube.com/watch?v=zzz');
  await tick(300);
  const [item] = (await call({ type: 'getState', tabId: 3 })).videos;
  assert.deepEqual(item.qualities.map((q) => [q.type, q.height]), [['tab', 1080], ['tab', 720], ['tab', 480]]);
});
