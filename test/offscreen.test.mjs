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
