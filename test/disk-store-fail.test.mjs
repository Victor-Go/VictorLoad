// Recording to disk (origin-private file system): scenario "fail". See helpers/mse-page.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCapture, readMp4 } from './helpers/mse-page.mjs';

const r = await runCapture({ opfs: 'fail' });

test('the recording is saved as one MP4 whose data is exactly what the player appended', () => {
  assert.equal(r.result.state, 'done', r.result.error);
  assert.deepEqual(readMp4(r.file).types, ['ftyp', 'moov', 'mdat']);
  assert.ok(readMp4(r.file).payload.equals(r.expected));
  assert.equal(r.status.video[0].n, 3);
  assert.equal(r.status.full, false);
});

test('a failing disk only means the data stays in memory', () => {
  assert.equal(r.written.length, 0);
});
