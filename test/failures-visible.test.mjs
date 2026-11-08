// Failure paths of the YouTube buffer capture must reach the user.
// This runs the real src/mse.js (page), src/content.js (content script) and src/background.js (service worker)
// in one process, wired together the way the browser does, and checks the text the side panel would show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeChrome, createStorage } from './helpers/fake-chrome.mjs';

// ---- a tiny page: window, location, document, MediaSource ----
const listeners = {};
const posted = [];
const video = {
  duration: 100,
  currentTime: 0,
  playbackRate: 1,
  muted: false,
  paused: false,
  play: async () => {},
  pause() {},
};
Object.assign(globalThis, {
  window: globalThis,
  top: globalThis,
  innerWidth: 1000,
  innerHeight: 800,
  location: { hostname: 'www.youtube.com', href: 'https://www.youtube.com/watch?v=abc123' },
  document: {
    title: '(3) Test clip - YouTube',
    baseURI: 'https://www.youtube.com/watch?v=abc123',
    images: [],
    visibilityState: 'hidden',
    documentElement: { appendChild() {} },
    querySelector: (s) => (/video/.test(s) ? video : null),
    querySelectorAll: () => [],
    getElementById: () => null,
    addEventListener() {},
  },
  MutationObserver: class {
    observe() {}
  },
  addEventListener: (type, fn) => void (listeners[type] ||= []).push(fn),
  // Like window.postMessage: delivered asynchronously to every message listener, with source === window
  postMessage: (data) => {
    posted.push(data);
    setTimeout(() => listeners.message?.forEach((fn) => fn({ source: globalThis, data })), 0);
  },
  setInterval: () => 0, // content.js polls forever; the test drives it by hand
});
class SourceBuffer {
  appendBuffer() {}
  abort() {}
}
class MediaSource {
  addSourceBuffer() {
    return new SourceBuffer();
  }
}
Object.assign(globalThis, { SourceBuffer, MediaSource });

// ---- the extension: service worker + content script wired together ----
const storage = createStorage({ local: { settings: {} } });
const toPanel = [];
let bgOnMessage;
const fake = createFakeChrome({
  overrides: {
    ...storage.overrides,
    // content script -> service worker (with a callback); service worker -> side panel (without)
    'runtime.sendMessage': (msg, cb) => {
      if (typeof cb !== 'function') return Promise.resolve(void toPanel.push(msg));
      bgOnMessage(msg, { tab: { id: 7 }, frameId: 0 }, cb);
    },
    'tabs.sendMessage': async () => {},
    'tabs.get': async (id) => ({ id, url: location.href, title: document.title }),
    'runtime.getContexts': async () => [],
    'scripting.getRegisteredContentScripts': async () => [],
  },
});
// content.js reads chrome.runtime.lastError after a callback; the proxy would answer with a function, so pin it
globalThis.chrome = new Proxy(fake.chrome, {
  get: (t, p) =>
    p === 'runtime' ? new Proxy(t.runtime, { get: (r, q) => (q === 'lastError' ? undefined : r[q]) }) : t[p],
});
globalThis.fetch = async () => {
  throw new Error('offline');
};
const warn = console.warn;
console.warn = () => {}; // mse.js and the service worker log what they drop; the test checks the status instead

const MAX = 6000;
globalThis.__vlMseMaxBytes = MAX; // see MAX_BYTES in mse.js
await import('../src/mse.js'); // hooks MediaSource / SourceBuffer
await import('../src/background.js');
bgOnMessage = fake.handlers['runtime.onMessage'][0];
await import('../src/content.js');
const { captureWarning } = await import('../src/notices.js');
const { setLang } = await import('../src/i18n.js');

// ---- helpers: MP4 boxes ----
const box = (type, payload = new Uint8Array(0)) => {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(payload, 8);
  return out;
};
const cat = (...a) => Uint8Array.from(a.flatMap((x) => [...x]));
const init = (padding = 0) => cat(box('ftyp', new Uint8Array(8)), box('moov', box('free', new Uint8Array(padding))));
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// created the way the player does it; mse.js wraps addSourceBuffer and starts recording
const trackedSb = new MediaSource().addSourceBuffer('video/mp4; codecs="avc1.64001f"');

/** The status mse.js reports for the video (what content.js receives) */
async function status() {
  posted.length = 0;
  listeners.message.forEach((fn) => fn({ source: globalThis, data: { __victorloadCmd: 1, cmd: 'status' } }));
  await tick();
  return posted.filter((d) => d.kind === 'mse-status').at(-1).status;
}

/** The video item the side panel receives for this tab, after a full scan */
async function panelVideo() {
  await tick(160); // content.js waits 100 ms after a status before it scans
  const state = await new Promise((res) => bgOnMessage({ type: 'getState', tabId: 7 }, {}, res));
  return state.videos.find((v) => v.id === 'yt:abc123');
}

setLang('zh');

test('a healthy capture shows no warning', async () => {
  trackedSb.appendBuffer(init(100));
  const s = await status();
  assert.equal(s.full, false);
  assert.equal(s.rejected, 0);
  assert.equal(s.captureErrors, 0);
  const item = await panelVideo();
  assert.ok(item, 'the capture is listed for the tab');
  assert.equal(captureWarning(item.capture), '');
});

test('segments that cannot be parsed are counted and the panel says so', async () => {
  // moof without a traf box, then an mdat: a segment we cannot use
  trackedSb.appendBuffer(cat(box('moof'), box('mdat', new Uint8Array(4))));
  const s = await status();
  assert.equal(s.rejected, 1);
  const item = await panelVideo();
  assert.equal(item.capture.rejected, 1);
  assert.match(captureWarning(item.capture), /1 个分片无法解析/);
});

test('an error while recording is counted and the panel says so', async () => {
  trackedSb.appendBuffer(Symbol('not bytes')); // makes the capture code throw; the player's own append must still run
  const s = await status();
  assert.equal(s.captureErrors, 1);
  const item = await panelVideo();
  assert.match(captureWarning(item.capture), /记录分片时出错 1 次/);
});

test('hitting the buffer limit is reported instead of silently stopping', async () => {
  trackedSb.appendBuffer(init(MAX)); // a new init segment bigger than the limit
  const s = await status();
  assert.equal(s.full, true);
  const item = await panelVideo();
  assert.equal(item.capture.full, true);
  const text = captureWarning(item.capture);
  assert.match(text, /已达到缓冲上限/);
  assert.match(text, /1\.5 GB/);
});

test('the warning is translated', async () => {
  setLang('en');
  const item = await panelVideo();
  const text = captureWarning(item.capture);
  assert.match(text, /buffer limit was reached/);
  assert.match(text, /Unreadable video segments/);
  setLang('zh');
});

test('the content script acknowledges cancellation only after the MAIN-world script processes it', async () => {
  const controlListener = fake.handlers['runtime.onMessage'][1];
  const result = await new Promise((resolve) => {
    assert.equal(controlListener({ type: 'cap-ctl', cmd: 'fill-stop', requestId: 'cancel-test' }, {}, resolve), true);
  });
  assert.deepEqual(result, { ok: true });
  assert.ok(posted.some((m) => m.kind === 'mse-control' && m.requestId === 'cancel-test'));
});

test('a missing MAIN-world acknowledgement returns failure rather than claiming cancellation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controlListener = fake.handlers['runtime.onMessage'][1];
  let result;
  controlListener({ type: 'cap-ctl', cmd: 'unknown-command', requestId: 'no-ack' }, {}, (r) => {
    result = r;
  });
  t.mock.timers.tick(4000);
  assert.deepEqual(result, { ok: false });
});

test.after(() => {
  console.warn = warn;
  assert.deepEqual(fake.unexpected, [], 'no unexpected chrome calls');
});
