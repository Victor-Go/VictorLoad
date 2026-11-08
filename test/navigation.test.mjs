import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeChrome, createStorage } from './helpers/fake-chrome.mjs';

const storage = createStorage({
  session: {
    tabsState: {
      7: {
        pageUrl: 'https://example.com/a',
        title: 'A',
        net: {
          old: { key: 'v:old', qualities: [{ url: 'https://cdn.example/old.mp4', type: 'direct' }] },
        },
      },
    },
  },
});
let releasePlaylist;
const sent = [];
const fake = createFakeChrome({
  overrides: {
    ...storage.overrides,
    'runtime.sendMessage': async (m) => void sent.push(m),
    'tabs.sendMessage': async () => {},
    'tabs.get': async (id) => ({ id, title: 'Test', url: 'https://example.com/d' }),
    'scripting.getRegisteredContentScripts': async () => [],
  },
});

test.after(() => assert.deepEqual(fake.unexpected, []));
globalThis.chrome = fake.chrome;
globalThis.fetch = () =>
  new Promise((r) => {
    releasePlaylist = r;
  });
await import('../src/background.js');
const call = (m, sender = {}) => new Promise((r) => fake.handlers['runtime.onMessage'][0](m, sender, r));
const scan = (url) =>
  call(
    { type: 'scan', pageUrl: url, title: url, images: [], videos: [], site: [], keys: [] },
    { tab: { id: 7 }, frameId: 0 },
  );
const state = () => call({ type: 'getState', tabId: 7 });
const net = fake.handlers['webRequest.onResponseStarted'][0];
const image = (url) =>
  net({
    tabId: 7,
    url,
    statusCode: 200,
    type: 'image',
    responseHeaders: [
      { name: 'content-type', value: 'image/jpeg' },
      { name: 'content-length', value: '40000' },
    ],
  });

test('SPA navigation clears old network media, image metadata and removed frames', async () => {
  assert.equal((await state()).videos.length, 1);
  image('https://cdn.example/old.jpg');
  await new Promise((r) => setImmediate(r));
  await call({ type: 'scan', images: [{ url: 'https://cdn.example/frame.jpg' }] }, { tab: { id: 7 }, frameId: 2 });
  assert.equal((await state()).images.length, 2);
  await scan('https://example.com/b');
  const s = await state();
  assert.equal(s.pageUrl, 'https://example.com/b');
  assert.deepEqual(s.videos, []);
  assert.deepEqual(s.images, []);
  image('https://cdn.example/new.jpg');
  await new Promise((r) => setImmediate(r));
  const next = await state();
  assert.equal(next.images.length, 1);
  assert.equal(next.images[0].url, 'https://cdn.example/new.jpg');
});

test('the initial content scan keeps media sniffed before the page URL was first reported', async () => {
  net({
    tabId: 8,
    url: 'https://cdn.example/initial.mp4',
    statusCode: 200,
    type: 'media',
    responseHeaders: [{ name: 'content-type', value: 'video/mp4' }],
  });
  await new Promise((r) => setImmediate(r));
  await call(
    {
      type: 'scan',
      pageUrl: 'https://example.com/initial',
      title: 'Initial',
      images: [],
      videos: [],
      site: [],
      keys: [],
    },
    { tab: { id: 8 }, frameId: 0 },
  );
  const s = await call({ type: 'getState', tabId: 8 });
  assert.equal(s.videos.length, 1);
  assert.equal(s.videos[0].qualities[0].url, 'https://cdn.example/initial.mp4');
});

test('a delayed HLS response cannot update a same-URL item on the next SPA page', async () => {
  const url = 'https://cdn.example/master.m3u8';
  const response = {
    tabId: 7,
    url,
    statusCode: 200,
    type: 'xmlhttprequest',
    responseHeaders: [{ name: 'content-type', value: 'application/vnd.apple.mpegurl' }],
  };
  net(response);
  await new Promise((r) => setImmediate(r));
  const oldResponse = releasePlaylist;
  await scan('https://example.com/c');
  net(response);
  await new Promise((r) => setImmediate(r));
  oldResponse(new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=10,RESOLUTION=1920x1080\nold.m3u8'));
  await new Promise((r) => setImmediate(r));
  const s = await state();
  assert.equal(s.videos.length, 1);
  assert.equal(s.videos[0].qualities[0].url, url);
  releasePlaylist(new Response('#EXTM3U\n#EXTINF:4,\nnew.ts\n#EXT-X-ENDLIST'));
});

test('sniffed variants retain the external-audio restriction when their direct URL is selected', async () => {
  await scan('https://example.com/d');
  await call(
    {
      type: 'scan',
      pageUrl: 'https://example.com/d',
      images: [],
      site: [],
      keys: [],
      videos: [{ key: 'dom:video', qualities: [{ url: 'https://cdn.example/video.m3u8', type: 'hls' }] }],
    },
    { tab: { id: 7 }, frameId: 0 },
  );
  net({
    tabId: 7,
    url: 'https://cdn.example/audio-master.m3u8',
    statusCode: 200,
    type: 'xmlhttprequest',
    responseHeaders: [{ name: 'content-type', value: 'application/vnd.apple.mpegurl' }],
  });
  await new Promise((r) => setImmediate(r));
  releasePlaylist(
    new Response(
      '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",URI="audio.m3u8"\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="aud"\nvideo.m3u8',
    ),
  );
  await new Promise((r) => setImmediate(r));
  const s = await state();
  const it = s.videos[0];
  assert.match(it.qualities[0].error, /独立音轨/);
  assert.equal(it.qualities[0].url, 'https://cdn.example/video.m3u8');
  await call({ type: 'download', tabId: 7, entries: [{ item: it, q: 0 }] });
  assert.ok(sent.some((m) => m.type === 'dl' && m.state === 'error' && /独立音轨/.test(m.msg)));
  assert.equal(
    sent.some((m) => m.type === 'hls-start'),
    false,
  );
});
