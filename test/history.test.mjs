// The download history: compact records, and what happens when storage is full or a write fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTORY_LIMIT,
  compactHistoryRecord,
  downloadedKeySet,
  historyThumb,
  isHistoryQuotaError,
  keyHash,
  normKey,
} from '../src/shared.js';
import { createFakeChrome, createStorage } from './helpers/fake-chrome.mjs';

const QUOTA = 10 * 1024 * 1024;
const bytes = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');

// ---- compact records (pure) ----

const longUrl = 'https://upos.example.com/v.mp4?' + 'a=b&'.repeat(200);
const videoInput = () => ({
  id: 'x1',
  time: 1,
  kind: 'video',
  title: 'T'.repeat(500),
  pageUrl: 'https://www.bilibili.com/video/BV1/',
  host: 'bilibili.com',
  thumb: 'https://i0.hdslb.com/a.jpg',
  url: longUrl,
  q: '1080P',
  keys: [normKey(longUrl), normKey('https://i0.hdslb.com/a.jpg'), normKey(longUrl)],
  name: 'a.mp4',
});

test('a data: URL image is not stored (it can be megabytes) but the page is still recognised', () => {
  const data = 'data:image/png;base64,' + 'A'.repeat(300_000);
  const rec = compactHistoryRecord({ id: 'i', time: 1, kind: 'image', thumb: data, url: data, keys: [normKey(data)] });
  assert.ok(bytes(rec) < 500, `record is ${bytes(rec)} bytes`);
  assert.equal(rec.url, '');
  assert.equal(rec.thumb, '');
  assert.deepEqual(rec.keys, [keyHash(normKey(data))]);
});

test('keys are hashed, de-duplicated and still match the raw keys the pages send', () => {
  const rec = compactHistoryRecord(videoInput());
  assert.equal(rec.keys.length, 2);
  assert.ok(rec.keys.every((k) => /^h:[0-9a-z]+$/.test(k)));
  const set = downloadedKeySet([rec]);
  assert.ok(set.has(keyHash(normKey(longUrl))));
  assert.ok(!set.has(keyHash('https://other.example.com/')));
});

test('compacting twice changes nothing, long text is capped', () => {
  const once = compactHistoryRecord(videoInput());
  assert.deepEqual(compactHistoryRecord(once), once);
  assert.equal(once.title.length, 200);
  assert.ok(once.url.length <= 200);
});

test('an image keeps its address once and the history can still draw the thumbnail', () => {
  const url = 'https://pbs.twimg.com/media/AbC?format=jpg&name=orig';
  const rec = compactHistoryRecord({ id: 'i', time: 1, kind: 'image', thumb: url, url, keys: [url] });
  assert.equal(rec.thumb, '');
  assert.equal(historyThumb(rec), url);
  assert.equal(historyThumb({ kind: 'video', thumb: '', url: 'https://x/v.mp4' }), '');
});

test('5000 realistic records fit in the storage quota with room to spare', () => {
  const recs = Array.from({ length: HISTORY_LIMIT }, (_, i) =>
    compactHistoryRecord({ ...videoInput(), id: 'id' + i, keys: [normKey(longUrl + i), 'bili:' + i, 'page:x' + i] }),
  );
  const size = bytes(recs);
  assert.ok(size < QUOTA / 2, `5000 records take ${(size / 1048576).toFixed(2)} MB`);
});

test('quota errors are recognised by their message', () => {
  assert.ok(isHistoryQuotaError(new Error('QUOTA_BYTES quota exceeded')));
  assert.ok(isHistoryQuotaError('Resource::kQuotaBytes quota exceeded'));
  assert.ok(!isHistoryQuotaError(new Error('boom')));
});

// ---- the service worker: quota and failures ----

const storage = createStorage({
  local: {
    settings: { nameFormat: '{tab}' },
    // Stored records use the same compact format as addHistory in background.js.
    history: [
      compactHistoryRecord({
        id: 'image1',
        time: 1,
        kind: 'image',
        title: 'Saved image',
        pageUrl: 'https://example.com/g',
        host: 'example.com',
        thumb: 'https://example.com/already.jpg',
        url: 'https://example.com/already.jpg',
        q: '',
        keys: ['https://example.com/already.jpg'],
        name: 'image.jpg',
      }),
    ],
  },
});
const sent = [];
const fake = createFakeChrome({
  overrides: {
    ...storage.overrides,
    'runtime.sendMessage': async (m) => void sent.push(m),
    'tabs.sendMessage': async () => {},
    'tabs.get': async (id) => ({ id, url: 'https://example.com/', title: 'Page' }),
    'runtime.getContexts': async () => [],
    'scripting.getRegisteredContentScripts': async () => [],
  },
});
globalThis.chrome = fake.chrome;
globalThis.fetch = async () => {
  throw new Error('offline');
};
const warn = console.warn;
const warnings = [];
console.warn = (...a) => void warnings.push(a);
await import('../src/background.js');

const onMessage = fake.handlers['runtime.onMessage'][0];
const call = (msg, sender = {}) => new Promise((res) => onMessage(msg, sender, res));
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const finish = (extra = {}) =>
  call({
    type: 'cap-result',
    jobId: 'lost' + ++n,
    state: 'done',
    name: `v${n}.mp4`,
    pageUrl: 'https://www.youtube.com/watch?v=vid' + n,
    title: 'Video ' + n,
    ...extra,
  });
const notices = () => sent.filter((m) => m.type === 'history-notice');

test('startup loads saved download history without rewriting it', async () => {
  const stored = structuredClone(storage.store.local.history);
  const originalSet = fake.overrides['storage.local.set'];
  let historyWrites = 0;
  fake.overrides['storage.local.set'] = async (values) => {
    if (Object.hasOwn(values, 'history')) historyWrites++;
    return originalSet(values);
  };
  try {
    await call({ type: 'getState', tabId: 1 }); // first message loads the stored history
    await tick();
    assert.deepEqual(storage.store.local.history, stored);
    assert.equal(historyWrites, 0);
  } finally {
    fake.overrides['storage.local.set'] = originalSet;
  }
});

test('the green check still matches after the keys were hashed', async () => {
  const res = await call(
    {
      type: 'scan',
      pageUrl: 'https://example.com/',
      title: 'p',
      images: [],
      videos: [],
      site: [],
      keys: ['https://example.com/already.jpg', 'https://example.com/other.jpg'],
    },
    { tab: { id: 1 }, frameId: 0 },
  );
  assert.deepEqual(res.down, ['https://example.com/already.jpg']);
});

test('when storage is full the oldest records go, the new one is kept and the user is told', async () => {
  // Fill the history, then shrink the quota below its size
  await storage.overrides['storage.local.set']({
    history: Array.from({ length: 300 }, (_, i) => compactHistoryRecord({ ...videoInput(), id: 'f' + i })),
  });
  const full = bytes(storage.store.local);
  storage.quotaBytes = full + 200; // room for about half a record: the next write must trim
  const before = notices().length;
  await finish();
  await tick();
  const h = storage.store.local.history;
  assert.equal(h[0].title, 'Video ' + n, 'the new record is at the top');
  assert.ok(h.length < 301, `oldest records were dropped (${h.length} left)`);
  const note = notices().at(-1);
  assert.equal(notices().length, before + 1);
  assert.equal(note.notice.kind, 'trimmed');
  assert.ok(note.notice.dropped >= 1);
  assert.deepEqual(storage.store.session.historyNotice, note.notice, 'also stored for a panel that is closed');
  storage.quotaBytes = Infinity;
});

test('a failed write is reported and does not block the writes after it', async () => {
  const realSet = fake.overrides['storage.local.set'];
  let fail = true;
  // fail the next history write once, with an error that is not about the quota
  fake.overrides['storage.local.set'] = async (o) => {
    if (fail && o.history) {
      fail = false;
      throw new Error('disk on fire');
    }
    return realSet(o);
  };
  const before = notices().length;
  await finish();
  await tick();
  const failed = notices().slice(before).at(-1);
  assert.equal(failed.notice.kind, 'failed');
  assert.match(failed.notice.error, /disk on fire/);

  await finish(); // the queue is still alive
  await tick();
  assert.equal(storage.store.local.history[0].title, 'Video ' + n);
  assert.ok(warnings.some((w) => String(w[0]).includes('could not write the history')));
  fake.overrides['storage.local.set'] = realSet;
});

test.after(() => {
  console.warn = warn;
});
