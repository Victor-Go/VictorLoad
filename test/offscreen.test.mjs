import { test } from 'node:test';
import assert from 'node:assert/strict';

const nativeFetch = globalThis.fetch;
let seq = 0;
async function offscreen(fixtures, send = async () => ({ ok: true })) {
  const sent = [];
  const fetched = [];
  let listener;
  globalThis.chrome = {
    runtime: {
      onMessage: {
        addListener: (fn) => {
          listener = fn;
        },
      },
      sendMessage: async (m) => {
        sent.push(m);
        return send(m);
      },
    },
  };
  globalThis.fetch = async (url) => {
    fetched.push(url);
    assert.ok(fixtures[url] !== undefined, `unexpected media request: ${url}`);
    const data = typeof fixtures[url] === 'function' ? await fixtures[url]() : fixtures[url];
    return new Response(data);
  };
  await import(`../src/offscreen.js?test=${++seq}`);
  const message = (m, respond = () => {}) => listener({ target: 'offscreen', ...m }, {}, respond);
  const wait = async (check) => {
    const deadline = Date.now() + 1000;
    while (!check()) {
      if (Date.now() > deadline) assert.fail('offscreen did not answer');
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return { sent, fetched, message, wait };
}

test('external HLS audio is rejected instead of reporting a silent video as done', async () => {
  const p = 'https://cdn.example/master.m3u8';
  const env = await offscreen({
    [p]: '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO="aud"\nvideo.m3u8',
  });
  env.message({ type: 'hls-start', jobId: 'audio', url: p });
  await env.wait(() => env.sent.some((m) => m.type === 'hls-error'));
  assert.match(env.sent.at(-1).error, /独立音轨/);
  assert.equal(
    env.sent.some((m) => m.type === 'hls-done'),
    false,
  );
  assert.deepEqual(env.fetched, [p]);
  env.message({ type: 'revoke', jobId: 'audio' });
});

test('reattaching to an active or completed job does not download its segments twice', async () => {
  const p = 'https://cdn.example/video.m3u8';
  let release;
  const env = await offscreen({
    [p]: '#EXTM3U\n#EXTINF:4,\nsegment.ts\n#EXT-X-ENDLIST',
    'https://cdn.example/segment.ts': () =>
      new Promise((r) => {
        release = () => r(new Uint8Array([1, 2, 3]));
      }),
  });
  const start = { type: 'hls-start', jobId: 'resume', url: p };
  env.message(start);
  await env.wait(() => release);
  env.message(start);
  assert.equal(env.sent.at(-1).type, 'hls-progress');
  release();
  await env.wait(() => env.sent.some((m) => m.type === 'hls-done'));
  const result = env.sent.find((m) => m.type === 'hls-done');
  env.message(start);
  assert.deepEqual(env.sent.at(-1), result);
  assert.equal(env.fetched.length, 2);
  assert.deepEqual(new Uint8Array(await (await nativeFetch(result.blobUrl)).arrayBuffer()), new Uint8Array([1, 2, 3]));
  env.message({ type: 'revoke', jobId: 'resume' });
  await assert.rejects(nativeFetch(result.blobUrl));
});

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

test('a rejected HLS completion is retried until the background acknowledges it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => {
    warnings.push(args);
  });
  let attempts = 0;
  const p = 'https://cdn.example/retry.m3u8';
  const env = await offscreen(
    { [p]: '#EXTM3U\n#EXTINF:4,\ns.ts\n#EXT-X-ENDLIST', 'https://cdn.example/s.ts': 'segment' },
    async (m) => {
      if (m.type === 'hls-done' && ++attempts < 3) throw new Error('Message port closed');
      return { ok: true };
    },
  );
  env.message({ type: 'hls-start', jobId: 'retry', url: p });
  await flush();
  assert.equal(attempts, 1);
  t.mock.timers.tick(500);
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(attempts, 3);
  assert.equal(warnings.length, 2);
  assert.equal(env.fetched.length, 2);
  env.message({ type: 'revoke', jobId: 'retry' });
});

test('unacknowledged results stop retrying but remain available to the background watchdog', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(console, 'warn', () => {});
  const p = 'https://cdn.example/lost.m3u8';
  const env = await offscreen(
    { [p]: '#EXTM3U\n#EXTINF:4,\ns.ts\n#EXT-X-ENDLIST', 'https://cdn.example/s.ts': 'segment' },
    async (m) => (m.type === 'hls-done' ? { error: 'not stored' } : { ok: true }),
  );
  env.message({ type: 'hls-start', jobId: 'lost', url: p });
  await flush();
  for (const delay of [500, 1000, 2000, 4000]) {
    t.mock.timers.tick(delay);
    await flush();
  }
  assert.equal(env.sent.filter((m) => m.type === 'hls-done').length, 5);
  let reply;
  env.message({ type: 'hls-status', jobId: 'lost' }, (r) => {
    reply = r;
  });
  assert.equal(reply.state, 'finished');
  assert.equal(reply.result.type, 'hls-done');
  assert.deepEqual(
    new Uint8Array(await (await nativeFetch(reply.result.blobUrl)).arrayBuffer()),
    new TextEncoder().encode('segment'),
  );
  env.message({ type: 'revoke', jobId: 'lost' });
});

test('TS segments are repackaged as an MP4 when mux.js is available, and fall back to .ts otherwise', async () => {
  const { readFileSync } = await import('node:fs');
  const seg = readFileSync(new URL('./fixtures/h264-segment.ts', import.meta.url));
  const lib = readFileSync(new URL('../vendor/mux-mp4.min.js', import.meta.url), 'utf8');
  const p = 'https://cdn.example/ts.m3u8';
  const playlist = '#EXTM3U\n#EXTINF:4,\na.ts\n#EXTINF:4,\nb.ts\n#EXT-X-ENDLIST';
  const fixtures = { [p]: playlist, 'https://cdn.example/a.ts': seg, 'https://cdn.example/b.ts': seg };
  const boxes = (u8) => {
    const out = [];
    for (let i = 0; i + 8 <= u8.length; ) {
      const size = new DataView(u8.buffer, u8.byteOffset + i).getUint32(0);
      out.push(String.fromCharCode(...u8.subarray(i + 4, i + 8)));
      if (size < 8) break;
      i += size;
    }
    return out;
  };

  const findBox = (u, type, within) => {
    const d = new DataView(u.buffer, u.byteOffset);
    const walk = (s, e) => {
      for (let p = s; p + 8 <= e; ) {
        const size = d.getUint32(p);
        const t = String.fromCharCode(...u.subarray(p + 4, p + 8));
        if (t === type) return { start: p + 8, end: p + size };
        // descend into the containers that hold what the test looks for
        if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(t)) {
          const r = walk(p + 8, p + size);
          if (r) return r;
        }
        if (size < 8) break;
        p += size;
      }
      return null;
    };
    return within ? walk(within.start, within.end) : walk(0, u.length);
  };

  globalThis.window = globalThis;
  new Function(lib).call(globalThis);
  try {
    const env = await offscreen(fixtures);
    env.message({ type: 'hls-start', jobId: 'mux', url: p });
    await env.wait(() => env.sent.some((m) => m.type === 'hls-done'));
    const done = env.sent.find((m) => m.type === 'hls-done');
    assert.equal(done.ext, 'mp4');
    const mp4 = new Uint8Array(await (await nativeFetch(done.blobUrl)).arrayBuffer());
    // A standard MP4 (not fragmented): the index comes first, then one mdat, no moof
    assert.deepEqual(boxes(mp4), ['ftyp', 'moov', 'mdat']);
    assert.ok(mp4.length > seg.length && mp4.length < seg.length * 5, `unexpected size ${mp4.length}`);
    // mvhd carries the real duration: two copies of the segment, about 2 x 10.4 s of video
    const moov = findBox(mp4, 'moov');
    const mvhd = findBox(mp4, 'mvhd', moov);
    const dv = new DataView(mp4.buffer, mp4.byteOffset);
    const seconds = dv.getUint32(mvhd.start + 16) / dv.getUint32(mvhd.start + 12); // version 0: timescale, duration
    assert.ok(seconds > 15 && seconds < 40, `duration ${seconds}s`);
    assert.ok(findBox(mp4, 'stss', moov), 'keyframes are indexed so that seeking lands on them');
    env.message({ type: 'revoke', jobId: 'mux' });
  } finally {
    delete globalThis.muxjs;
    delete globalThis.window;
  }

  const env = await offscreen(fixtures);
  env.message({ type: 'hls-start', jobId: 'raw', url: p });
  await env.wait(() => env.sent.some((m) => m.type === 'hls-done'));
  assert.equal(env.sent.find((m) => m.type === 'hls-done').ext, 'ts');
  env.message({ type: 'revoke', jobId: 'raw' });
});

test('a stream mux.js cannot repackage is still saved as .ts', async (t) => {
  const { readFileSync } = await import('node:fs');
  const lib = readFileSync(new URL('../vendor/mux-mp4.min.js', import.meta.url), 'utf8');
  t.mock.method(console, 'warn', () => {});
  globalThis.window = globalThis;
  new Function(lib).call(globalThis);
  try {
    const p = 'https://cdn.example/junk.m3u8';
    const env = await offscreen({
      [p]: '#EXTM3U\n#EXTINF:4,\nj.ts\n#EXT-X-ENDLIST',
      'https://cdn.example/j.ts': new Uint8Array(1880).fill(7),
    });
    env.message({ type: 'hls-start', jobId: 'junk', url: p });
    await env.wait(() => env.sent.some((m) => m.type === 'hls-done'));
    assert.equal(env.sent.find((m) => m.type === 'hls-done').ext, 'ts');
    env.message({ type: 'revoke', jobId: 'junk' });
  } finally {
    delete globalThis.muxjs;
    delete globalThis.window;
  }
});
