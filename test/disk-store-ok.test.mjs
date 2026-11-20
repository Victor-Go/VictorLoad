// Recording to disk (origin-private file system): scenario "ok". See helpers/mse-page.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCapture, readMp4 } from './helpers/mse-page.mjs';

const r = await runCapture({ opfs: 'ok' });

test('the recording is saved as one MP4 whose data is exactly what the player appended', () => {
  assert.equal(r.result.state, 'done', r.result.error);
  assert.deepEqual(readMp4(r.file).types, ['ftyp', 'moov', 'mdat']);
  assert.ok(readMp4(r.file).payload.equals(r.expected));
  assert.equal(r.status.video[0].n, 3);
  assert.equal(r.status.full, false);
});

test('every segment went to its own file on disk, and cleanup removes them', async () => {
  assert.equal(r.written.length, 3);
  assert.equal(new Set(r.written).size, 3);
  r.send({ cmd: 'cleanup', requestId: 'c1' });
  for (let i = 0; i < 50 && !r.posted.some((d) => d.kind === 'mse-control' && d.requestId === 'c1'); i++) {
    await new Promise((x) => setTimeout(x, 20));
  }
  const base = await r.root.getDirectoryHandle('victorload');
  assert.equal(base.dirs.size, 0, 'the session folder is gone');
});
