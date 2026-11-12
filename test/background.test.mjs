// Drives src/background.js (the service worker) with a fake chrome API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeChrome, createStorage } from './helpers/fake-chrome.mjs';

const storage = createStorage({ local: { settings: { nameFormat: '{tab}', nameFormatV: 2 } } });
const store = storage.store;
const sent = []; // messages sent to extension pages / tabs
const downloads = [];
let dlSeq = 100;
let realTabTitle = '(3) Hello World - YouTube';

// Strict fake: a chrome.* call that is not listed here (or in COMMON_NOOP) throws and fails the test
const fake = createFakeChrome({
  overrides: {
    ...storage.overrides,
    'runtime.sendMessage': async (m) => void sent.push(m),
    'tabs.sendMessage': async (_id, m) => void (m.type === 'cap-save' && sent.push({ capSave: m })),
    'tabs.get': async (id) => ({ id, url: 'https://www.youtube.com/watch?v=abc', title: realTabTitle }),
    'downloads.download': async (o) => (downloads.push(o), ++dlSeq),
    'downloads.search': async () => [
      { filename: 'C:\\Users\\x\\Downloads\\' + downloads.at(-1).filename.replace(/\//g, '\\') },
    ],
    'runtime.getContexts': async () => [],
    'scripting.getRegisteredContentScripts': async () => [],
  },
});
const handlers = fake.handlers;
globalThis.chrome = fake.chrome;
globalThis.fetch = async () => {
  throw new Error('offline'); // the YouTube extractor runs on scan; keep the tests off the network
};
const originalConsoleInfo = console.info;
const originalConsoleWarn = console.warn;
console.info = () => {};
console.warn = () => {}; // failed extractor requests are logged on purpose
await import('../src/background.js');
console.info = originalConsoleInfo;

const onMessage = handlers['runtime.onMessage'][0];
const call = (msg, sender = {}) => new Promise((res) => onMessage(msg, sender, res));
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const lastCapSave = () => sent.filter((m) => m.capSave).at(-1)?.capSave;
const capItem = (id) => ({
  id,
  kind: 'video',
  source: 'site',
  title: 'Hello World',
  keys: [id],
  qualities: [
    { label: '720p H.264', height: 720, type: 'capture', vgid: 'g1', agid: 'g2', ext: 'mp4', cov: 1, holes: 0 },
  ],
});

test('{tab} is the real tab title, even when the cached title is empty', async () => {
  await call(
    {
      type: 'scan',
      pageUrl: 'https://www.youtube.com/watch?v=abc',
      title: '',
      images: [],
      videos: [],
      site: [],
      keys: [],
    },
    { tab: { id: 5 }, frameId: 0 },
  );
  await call({ type: 'download', tabId: 5, entries: [{ item: capItem('yt:abc'), q: 0 }] });
  await tick();
  assert.equal(lastCapSave().name, 'Hello World - YouTube'); // unread-count prefix removed
  assert.equal(lastCapSave().auto, false); // fully buffered: save directly
});

test('a finished capture save is written to the history', async () => {
  await call(
    { type: 'cap-result', jobId: lastCapSave().jobId, state: 'done', name: 'Hello World - YouTube.mp4' },
    { tab: { id: 5 }, frameId: 0 },
  );
  await tick();
  const h = store.local.history.at(0);
  assert.equal(h.name, 'Hello World - YouTube.mp4');
  assert.equal(h.host, 'youtube.com');
  assert.equal(h.q, '720p H.264');
  assert.deepEqual(Object.keys(store.session.captureJobs || {}), []); // job cleaned up
});

test('a finished save is still recorded when the job record was lost', async () => {
  await call(
    {
      type: 'cap-result',
      jobId: 'lost',
      state: 'done',
      name: 'x.mp4',
      pageUrl: 'https://www.youtube.com/watch?v=zzz',
      title: '(2) Another - YouTube',
    },
    { tab: { id: 5 }, frameId: 0 },
  );
  await tick();
  assert.equal(store.local.history.at(0).title, 'Another');
});

test('incomplete captures are buffered first (auto download), unless forced', async () => {
  const partial = capItem('yt:partial');
  partial.qualities[0].cov = 0.4;
  partial.qualities[0].holes = 2;
  await call({ type: 'download', tabId: 5, entries: [{ item: partial, q: 0 }] });
  await tick();
  assert.equal(lastCapSave().auto, true);
  await call({ type: 'download', tabId: 5, entries: [{ item: partial, q: 0, force: true }] });
  await tick();
  assert.equal(lastCapSave().auto, false);
});

test('direct downloads use the name template and reach the history on completion', async () => {
  realTabTitle = 'Photos';
  const img = {
    id: 'i:x',
    kind: 'image',
    url: 'https://example.com/pics/cat.jpg',
    thumb: 'https://example.com/pics/cat.jpg',
    w: 1200,
    h: 800,
    keys: ['https://example.com/pics/cat.jpg'],
  };
  await call({ type: 'download', tabId: 5, entries: [{ item: img, q: 0 }] });
  await tick();
  assert.equal(downloads.at(-1).filename, 'VictorLoad/youtube.com/Photos.jpg');
  await handlers['downloads.onChanged'][0]({ id: dlSeq, state: { current: 'complete' } });
  await tick();
  assert.equal(store.local.history.at(0).name, 'Photos.jpg');
});

test('{resolution} / {name} / {duration} templates', async () => {
  store.local.settings.nameFormat = '{name}_{resolution}_{duration}';
  const img = { id: 'i:y', kind: 'image', url: 'https://example.com/a/dog.png', thumb: 'x', w: 640, h: 480, keys: [] };
  await call({ type: 'download', tabId: 5, entries: [{ item: img, q: 0 }] });
  await tick();
  assert.equal(downloads.at(-1).filename, 'VictorLoad/youtube.com/dog_640x480.png'); // empty {duration} is dropped
});

test('a page that never answers a capture request fails with a clear error instead of hanging', async () => {
  store.local.settings.nameFormat = '{tab}';
  const before = sent.length;
  await call({ type: 'download', tabId: 5, entries: [{ item: capItem('yt:silent'), q: 0 }] });
  await tick(8600);
  const msgs = sent.slice(before).filter((m) => m.type === 'dl' && m.id === 'yt:silent');
  assert.equal(
    msgs.some((m) => m.state === 'queued'),
    false,
  );
  assert.equal(msgs.at(-1).state, 'error');
  assert.match(msgs.at(-1).msg, /页面脚本没有响应/);
});

test('cancel reports a disconnected page and rejects a missing acknowledgement', async () => {
  const original = fake.overrides['tabs.sendMessage'];
  try {
    fake.overrides['tabs.sendMessage'] = async () => {
      throw new Error('Receiving end does not exist');
    };
    const failed = await call({ type: 'capture-ctl', tabId: 5, cmd: 'fill-stop' });
    assert.match(failed.error, /取消失败.*刷新/);
    assert.equal(failed.ok, undefined);
    fake.overrides['tabs.sendMessage'] = async () => undefined;
    assert.match((await call({ type: 'capture-ctl', tabId: 5, cmd: 'fill-stop' })).error, /取消失败/);
    fake.overrides['tabs.sendMessage'] = async () => ({ ok: true });
    assert.deepEqual(await call({ type: 'capture-ctl', tabId: 5, cmd: 'fill-stop' }), { ok: true });
  } finally {
    fake.overrides['tabs.sendMessage'] = original;
  }
});

test('the service worker used no chrome API the test did not expect', () => {
  console.warn = originalConsoleWarn;
  assert.deepEqual(fake.unexpected, []);
});

test('{title} names an X video after its card, while {tab} keeps the page title', async () => {
  const item = {
    ...capItem('x'),
    id: 'tw-vid:1',
    title: '@eric 太粉了',
    qualities: [{ label: '720p', height: 720, url: 'https://video.twimg.com/a.mp4', type: 'direct', ext: 'mp4' }],
  };
  store.local.settings.nameFormat = '{title}';
  await call({ type: 'download', tabId: 5, entries: [{ item, q: 0 }] });
  await tick();
  assert.equal(downloads.at(-1).filename, 'VictorLoad/youtube.com/@eric 太粉了.mp4');
  store.local.settings.nameFormat = '{tab}';
  await call({ type: 'download', tabId: 5, entries: [{ item, q: 0 }] });
  await tick();
  assert.equal(downloads.at(-1).filename, 'VictorLoad/youtube.com/Photos.mp4');
});

test('excluded items disappear until the page is reloaded', async () => {
  const sender = { tab: { id: 9 }, frameId: 0 };
  const vid = (n) => ({
    key: 'v' + n,
    qualities: [{ label: '720p', height: 720, url: `https://example.com/${n}.mp4`, type: 'direct', ext: 'mp4' }],
  });
  const scan = () =>
    call(
      {
        type: 'scan',
        pageUrl: 'https://example.com/p',
        title: 'P',
        images: [],
        videos: [vid(1), vid(2)],
        site: [],
        keys: [],
      },
      sender,
    );
  await scan();
  let s = await call({ type: 'getState', tabId: 9 });
  assert.deepEqual(s.videos.map((v) => v.id).sort(), ['v1', 'v2']);
  s = await call({ type: 'exclude', tabId: 9, ids: ['v1'] });
  assert.deepEqual(
    s.videos.map((v) => v.id),
    ['v2'],
  );
  await scan(); // the same item is sniffed again: still hidden
  assert.deepEqual(
    (await call({ type: 'getState', tabId: 9 })).videos.map((v) => v.id),
    ['v2'],
  );
  await handlers['webNavigation.onCommitted'][0]({ tabId: 9, frameId: 0, url: 'https://example.com/p' }); // reload
  await scan();
  assert.deepEqual((await call({ type: 'getState', tabId: 9 })).videos.map((v) => v.id).sort(), ['v1', 'v2']);
});
