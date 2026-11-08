import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeChrome } from './helpers/fake-chrome.mjs';

let seq = 0;
const waitFor = async (check) => {
  const deadline = Date.now() + 1500;
  while (!check()) {
    if (Date.now() > deadline) assert.fail('HLS queue did not reach the expected state');
    await new Promise((r) => setTimeout(r, 5));
  }
};
const item = (id) => ({
  id,
  kind: 'video',
  title: id,
  keys: [id],
  qualities: [{ type: 'hls', url: `https://cdn.example/${id}.m3u8`, ext: 'ts' }],
});
const record = { kind: 'video', title: 'Recovered', pageUrl: 'https://example.com', keys: ['recovered'] };

function environment(session = {}, browserDownloads = []) {
  const store = { session, local: { settings: {} } };
  const sent = [];
  const created = [];
  return { store, sent, created, browserDownloads };
}

async function boot(env) {
  const { store, sent, created, browserDownloads } = env;
  const overrides = {
    'tabs.get': async (id) => ({ id, title: 'Test', url: 'https://example.com' }),
    'tabs.sendMessage': async () => {},
    'scripting.getRegisteredContentScripts': async () => [],
    'runtime.getContexts': async () => [{}],
    'runtime.sendMessage': async (m) => void sent.push(structuredClone(m)),
    'downloads.download': async (o) => {
      const d = { ...o, id: 100 + browserDownloads.length, state: 'in_progress' };
      created.push(d);
      browserDownloads.push(d);
      return d.id;
    },
    'downloads.search': async (q) =>
      structuredClone(browserDownloads.filter((d) => (q.id !== undefined ? d.id === q.id : d.url === q.url))),
  };
  for (const area of ['local', 'session']) {
    overrides[`storage.${area}.get`] = async (keys) =>
      structuredClone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((k) => [k, store[area][k]])));
    overrides[`storage.${area}.set`] = async (data) => void Object.assign(store[area], structuredClone(data));
  }
  const fake = createFakeChrome({ overrides });
  globalThis.chrome = fake.chrome;
  await import(`../src/background.js?hls-recovery=${++seq}`);
  const call = (m) => new Promise((r) => fake.handlers['runtime.onMessage'][0](m, {}, r));
  return { fake, call, changed: fake.handlers['downloads.onChanged'][0] };
}
const starts = (env) => env.sent.filter((m) => m.type === 'hls-start');
const download = (worker, ids) =>
  worker.call({ type: 'download', tabId: 1, entries: ids.map((id) => ({ item: item(id) })) });
const done = (worker, jobId, blobUrl) => worker.call({ type: 'hls-done', jobId, blobUrl, ext: 'ts' });

test('HLS queue survives a worker restart, keeps order, completes history and revokes blobs', async () => {
  const env = environment();
  let worker = await boot(env);
  await download(worker, ['first', 'second']);
  await waitFor(() => starts(env).length === 1);
  const firstId = starts(env)[0].jobId;
  assert.equal(Object.keys(env.store.session.hlsJobs).length, 2);
  assert.equal(Object.values(env.store.session.hlsJobs)[1].state, 'queued');

  // A new module has fresh Maps and Promises, but only serialized session data survives.
  worker = await boot(env);
  await waitFor(() => starts(env).length === 2);
  assert.equal(starts(env)[1].jobId, firstId);
  await done(worker, firstId, 'blob:first');
  await waitFor(() => starts(env).length === 3);
  const secondId = starts(env)[2].jobId;
  assert.notEqual(secondId, firstId);
  assert.equal(env.created.length, 1);

  env.browserDownloads[0].state = 'complete';
  await worker.changed({ id: env.browserDownloads[0].id, state: { current: 'complete' } });
  assert.equal(env.store.local.history.length, 1);
  assert.equal(env.store.local.history[0].title, 'first');
  assert.deepEqual(env.store.session.pending, {});
  assert.ok(env.sent.some((m) => m.type === 'revoke' && m.jobId === firstId));

  await done(worker, secondId, 'blob:second');
  await worker.changed({
    id: env.browserDownloads[1].id,
    state: { current: 'interrupted' },
    error: { current: 'NETWORK_FAILED' },
  });
  assert.equal(env.store.local.history.length, 1);
  assert.ok(env.sent.some((m) => m.type === 'dl' && m.id === 'second' && m.state === 'error'));
  assert.deepEqual(env.store.session.hlsJobs, {});
  assert.deepEqual(worker.fake.unexpected, []);
});

test('a completed offscreen result is saved once even if it is delivered twice', async () => {
  const env = environment();
  const worker = await boot(env);
  await download(worker, ['duplicate']);
  await waitFor(() => starts(env).length === 1);
  const id = starts(env)[0].jobId;
  await Promise.all([done(worker, id, 'blob:duplicate'), done(worker, id, 'blob:duplicate')]);
  assert.equal(env.created.length, 1);
});

test('restart between browser download creation and pending persistence reuses the existing download', async () => {
  const env = environment(
    {
      hlsJobs: {
        saved: {
          itemId: 'recovered',
          url: 'https://cdn.example/p.m3u8',
          filename: 'recovered.ts',
          record,
          state: 'ready',
          blobUrl: 'blob:already-saved',
          ext: 'ts',
        },
      },
    },
    [{ id: 42, url: 'blob:already-saved', filename: 'recovered.ts', state: 'complete' }],
  );
  await boot(env);
  await waitFor(() => env.store.local.history?.length === 1);
  assert.equal(env.created.length, 0);
  assert.equal(env.store.local.history[0].name, 'recovered.ts');
  assert.deepEqual(env.store.session.hlsJobs, {});
  assert.deepEqual(env.store.session.pending, {});
});

test('an HLS error releases the queue and cleans the failed offscreen job', async () => {
  const env = environment();
  const worker = await boot(env);
  await download(worker, ['bad', 'good']);
  await waitFor(() => starts(env).length === 1);
  const id = starts(env)[0].jobId;
  await worker.call({ type: 'hls-error', jobId: id, error: 'HTTP 403' });
  await waitFor(() => starts(env).length === 2);
  assert.ok(env.sent.some((m) => m.type === 'revoke' && m.jobId === id));
  assert.equal(Object.keys(env.store.session.hlsJobs).length, 1);
});

test('a rejected browser save releases the next HLS task', async () => {
  const env = environment();
  const worker = await boot(env);
  worker.fake.overrides['downloads.download'] = async () => {
    throw new Error('download rejected');
  };
  await download(worker, ['bad-save', 'next']);
  await waitFor(() => starts(env).length === 1);
  await done(worker, starts(env)[0].jobId, 'blob:rejected');
  await waitFor(() => starts(env).length === 2);
  assert.equal(Object.keys(env.store.session.hlsJobs).length, 1);
});

test('the watchdog recovers a completed result even if its push notification was lost', async () => {
  const env = environment();
  const worker = await boot(env);
  await download(worker, ['lost-push']);
  await waitFor(() => starts(env).length === 1);
  const send = worker.fake.overrides['runtime.sendMessage'];
  worker.fake.overrides['runtime.sendMessage'] = async (m) =>
    m.type === 'hls-status'
      ? { state: 'finished', result: { type: 'hls-done', blobUrl: 'blob:recovered-push', ext: 'ts' } }
      : send(m);
  await worker.fake.handlers['alarms.onAlarm'][0]({ name: 'victorload-hls-watchdog' });
  assert.equal(env.created.length, 1);
  assert.equal(env.created[0].url, 'blob:recovered-push');
  assert.deepEqual(env.store.session.hlsJobs, {});
});

test('persistent offscreen disconnection reaches the user and releases the next job', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const env = environment();
  const worker = await boot(env);
  await download(worker, ['lost', 'next']);
  await waitFor(() => starts(env).length === 1);
  const send = worker.fake.overrides['runtime.sendMessage'];
  worker.fake.overrides['runtime.sendMessage'] = async (m) => {
    if (m.type === 'hls-status') throw new Error('Offscreen connection lost');
    return send(m);
  };
  const alarm = worker.fake.handlers['alarms.onAlarm'][0];
  await alarm({ name: 'victorload-hls-watchdog' });
  assert.ok(env.sent.some((m) => m.type === 'dl' && m.id === 'lost' && m.reconnecting));
  await alarm({ name: 'victorload-hls-watchdog' });
  assert.ok(env.sent.some((m) => m.type === 'dl' && m.id === 'lost' && m.state === 'error' && /失去连接/.test(m.msg)));
  await waitFor(() => starts(env).length === 2);
  assert.equal(Object.keys(env.store.session.hlsJobs).length, 1);
});

test('a healthy watchdog response resets missed checks without reporting a download failure', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const env = environment();
  const worker = await boot(env);
  await download(worker, ['healthy']);
  await waitFor(() => starts(env).length === 1);
  let connected = false;
  const send = worker.fake.overrides['runtime.sendMessage'];
  worker.fake.overrides['runtime.sendMessage'] = async (m) => {
    if (m.type !== 'hls-status') return send(m);
    if (!connected) throw new Error('Temporary disconnect');
    return { state: 'running', pct: 42 };
  };
  const alarm = worker.fake.handlers['alarms.onAlarm'][0];
  await alarm({ name: 'victorload-hls-watchdog' });
  connected = true;
  await alarm({ name: 'victorload-hls-watchdog' });
  assert.equal(Object.values(env.store.session.hlsJobs)[0].contactMisses, 0);
  assert.ok(env.sent.some((m) => m.type === 'dl' && m.id === 'healthy' && m.pct === 42));
  assert.equal(
    env.sent.some((m) => m.type === 'dl' && m.state === 'error'),
    false,
  );
});
