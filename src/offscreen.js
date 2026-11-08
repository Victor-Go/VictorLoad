// Offscreen document: downloads HLS segments (AES-128 and fMP4 init segments supported),
// merges them into one Blob and hands it back to the background for download
import { parseM3U8, EXTERNAL_AUDIO_ERROR } from './hlsparse.js';
import { flattenFragmentedMp4 } from './mp4flat.js';

const blobUrls = new Map();
const jobs = new Map(); // survives service worker restarts for as long as this document is alive

function sendResult(jobId, result) {
  const job = jobs.get(jobId);
  if (!job) return;
  if (result.type === 'hls-progress') {
    return chrome.runtime.sendMessage({ jobId, ...result }).catch((e) => {
      console.warn('[VictorLoad] could not report HLS progress; the background will check the job', jobId, e);
    });
  }
  if (job.delivery) return job.delivery;
  job.delivery = (async () => {
    for (let attempt = 0; attempt < 5 && jobs.get(jobId) === job; attempt++) {
      try {
        const reply = await chrome.runtime.sendMessage({ jobId, ...result });
        if (!reply?.ok) throw new Error(reply?.error || 'No result acknowledgement');
        return true;
      } catch (e) {
        console.warn('[VictorLoad] could not deliver HLS result', jobId, attempt + 1, e);
        if (attempt < 4) await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempt, 4000)));
      }
    }
    // Retain the Blob and result: the background alarm can recover them through hls-status.
    return false;
  })().finally(() => {
    job.delivery = null;
  });
  return job.delivery;
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg.target !== 'offscreen') return;
  if (msg.type === 'hls-status') {
    const job = jobs.get(msg.jobId);
    respond(
      job ? { state: job.result ? 'finished' : 'running', pct: job.pct, result: job.result } : { state: 'missing' },
    );
    return;
  }
  if (msg.type === 'hls-start') {
    const job = jobs.get(msg.jobId);
    if (job?.result) sendResult(msg.jobId, job.result);
    else if (job) sendResult(msg.jobId, { type: 'hls-progress', pct: job.pct });
    else {
      jobs.set(msg.jobId, { pct: 0 });
      run(msg.jobId, msg.url);
    }
  }
  if (msg.type === 'revoke') {
    const u = blobUrls.get(msg.jobId);
    if (u) URL.revokeObjectURL(u);
    blobUrls.delete(msg.jobId);
    jobs.delete(msg.jobId);
  }
});

async function fetchRetry(url, init, tries = 4) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { credentials: 'include', ...init, signal: AbortSignal.timeout(30_000) });
      if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status);
      return r;
    } catch (e) {
      err = e;
      await new Promise((res) => setTimeout(res, 400 * (i + 1)));
    }
  }
  throw err;
}

function ivFromSeq(seq) {
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setUint32(12, seq >>> 0);
  return iv;
}
function hexToBytes(hex) {
  hex = hex.replace(/^0x/i, '').padStart(32, '0');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/**
 * Repackage MPEG-TS segments as a standard MP4 (H.264 + AAC) without re-encoding: mux.js turns them into
 * fragmented MP4, which mp4flat.js then rewrites with the real duration, a keyframe index and interleaved
 * audio/video so that players can seek. Resolves to null when the library is missing or the stream has no
 * H.264/AAC that can be repackaged.
 */
export async function tsToMp4(segments) {
  const Transmuxer = globalThis.muxjs?.mp4?.Transmuxer || globalThis.muxjs?.Transmuxer;
  if (!Transmuxer) return null;
  const tm = new Transmuxer();
  let init = null;
  const frags = [];
  tm.on('data', (s) => {
    if (!s.data?.length) return;
    init ||= s.initSegment;
    frags.push(s.data);
  });
  for (const seg of segments) {
    tm.push(new Uint8Array(await seg.arrayBuffer()));
    tm.flush();
  }
  if (!init || !frags.length) return null;
  return new Blob(flattenFragmentedMp4(init, frags), { type: 'video/mp4' });
}

async function run(jobId, url) {
  const send = (m) => {
    const job = jobs.get(jobId);
    if (job) {
      if (m.type === 'hls-progress') job.pct = m.pct;
      else job.result = m;
    }
    return sendResult(jobId, m);
  };
  try {
    let text = await (await fetchRetry(url)).text();
    let pl = parseM3U8(text, url);
    if (pl.master) {
      // Pick the highest-bitrate variant
      const best = [...pl.variants].sort((a, b) => b.h - a.h || b.bandwidth - a.bandwidth)[0];
      if (!best) throw new Error('空的主清单');
      if (best.externalAudio) throw new Error(EXTERNAL_AUDIO_ERROR);
      url = best.url;
      text = await (await fetchRetry(url)).text();
      pl = parseM3U8(text, url);
    }
    if (pl.unsupported) throw new Error('不支持的加密方式：' + pl.unsupported);
    if (!pl.segs.length) throw new Error('没有分片');

    const keyCache = new Map();
    const getKey = async (k) => {
      if (!keyCache.has(k.uri)) {
        keyCache.set(
          k.uri,
          fetchRetry(k.uri)
            .then((r) => r.arrayBuffer())
            .then((b) => crypto.subtle.importKey('raw', b, 'AES-CBC', false, ['decrypt'])),
        );
      }
      return keyCache.get(k.uri);
    };

    const parts = [];
    if (pl.map) parts.push(await (await fetchRetry(pl.map.url)).blob());
    const first = parts.length;
    const total = pl.segs.length;
    const results = new Array(total);
    let next = 0;
    let done = 0;
    let lastPct = -1;

    const worker = async () => {
      while (true) {
        const i = next++;
        if (i >= total) return;
        const s = pl.segs[i];
        const init = s.range ? { headers: { Range: `bytes=${s.range.start}-${s.range.end}` } } : undefined;
        const r = await fetchRetry(s.url, init);
        if (s.key) {
          const buf = await r.arrayBuffer();
          const key = await getKey(s.key);
          const iv = s.key.iv ? hexToBytes(s.key.iv) : ivFromSeq(s.seq);
          results[i] = new Blob([await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, buf)]);
        } else {
          results[i] = await r.blob();
        }
        done++;
        const pct = Math.floor((done / total) * 100);
        if (pct !== lastPct) {
          lastPct = pct;
          send({ type: 'hls-progress', pct });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, total) }, worker));

    parts.push(...results);
    let ext = pl.map ? 'mp4' : 'ts';
    let blob = new Blob(parts, { type: ext === 'mp4' ? 'video/mp4' : 'video/mp2t' });
    if (ext === 'ts') {
      // MPEG-TS plays poorly outside VLC-like players: repackage it as MP4 (no re-encoding).
      // If that is not possible (other codecs, broken stream), the .ts file is still saved as before.
      const mp4 = await tsToMp4(results).catch((e) => {
        console.warn('[VictorLoad] could not repackage TS as MP4; saving the raw .ts', e);
        return null;
      });
      if (mp4) {
        blob = mp4;
        ext = 'mp4';
      }
    }
    const blobUrl = URL.createObjectURL(blob);
    blobUrls.set(jobId, blobUrl);
    send({ type: 'hls-done', blobUrl, ext, first });
  } catch (e) {
    send({ type: 'hls-error', error: String(e.message || e) });
  }
}
