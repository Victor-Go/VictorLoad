// Files that outgrow 32-bit offsets (4 GB) get co64 and a 64-bit mdat size. The threshold is lowered to test it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCapture, readMp4 } from './helpers/mse-page.mjs';

const r = await runCapture({ opfs: 'ok', bigAt: 100 });

test('a big recording is written with co64 and a 64-bit mdat, and the offsets point at the data', () => {
  assert.equal(r.result.state, 'done', r.result.error);
  const { types, payload } = readMp4(r.file);
  assert.deepEqual(types, ['ftyp', 'moov', 'mdat']);
  assert.ok(payload.equals(r.expected));
  assert.equal(r.file.indexOf('stco'), -1);
  const at = r.file.indexOf('co64');
  assert.ok(at > 0, 'has a co64 box');
  const firstChunk = Number(r.file.readBigUInt64BE(at + 12));
  assert.equal(firstChunk, r.file.length - payload.length, 'the first chunk offset is where the mdat data starts');
  assert.equal(r.file.readUInt32BE(r.file.length - payload.length - 16), 1, 'the mdat uses the 64-bit size form');
});
