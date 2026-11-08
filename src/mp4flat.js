// Rewrites a fragmented MP4 (an init segment plus moof/mdat fragments, as mux.js produces from MPEG-TS)
// as a standard MP4: ftyp + moov with complete sample tables + one mdat.
//
// Why: a fragmented file has no total duration and no index, so players show a bogus length, cannot
// seek, and after a seek start decoding in the middle of a GOP (smeared picture). A standard MP4 carries
// the real duration, a sync-sample table (keyframes) and audio/video interleaved in ~1 second chunks.
// Sample data is referenced, not copied: the result is a list of parts for `new Blob(parts)`.

const enc = (s) => new TextEncoder().encode(s);
const dvOf = (u) => new DataView(u.buffer, u.byteOffset, u.byteLength);
const u32b = (n) => {
  const o = new Uint8Array(4);
  new DataView(o.buffer).setUint32(0, n >>> 0);
  return o;
};
const words = (arr, signed) => {
  const o = new Uint8Array(arr.length * 4);
  const dv = new DataView(o.buffer);
  arr.forEach((x, i) => (signed ? dv.setInt32(i * 4, x) : dv.setUint32(i * 4, x >>> 0)));
  return o;
};
const rle = (vals) => {
  const out = [];
  for (const v of vals) {
    const last = out[out.length - 1];
    if (last && last[1] === v) last[0]++;
    else out.push([1, v]);
  }
  return out;
};

function boxes(u, start = 0, end = u.length) {
  const out = [];
  const dv = dvOf(u);
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    const type = String.fromCharCode(u[p + 4], u[p + 5], u[p + 6], u[p + 7]);
    let hdr = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = Number(dv.getBigUint64(p + 8));
      hdr = 16;
    } else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) break;
    out.push({ type, start: p, hdr, end: p + size });
    p += size;
  }
  return out;
}
const child = (u, b, type) => (b ? boxes(u, b.start + b.hdr, b.end).find((x) => x.type === type) : undefined);

function mk(type, parts) {
  let n = 8;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  new DataView(out.buffer).setUint32(0, n);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let o = 8;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Set the duration field of a copied mvhd / tkhd / mdhd box (cs = start of its version byte) */
function setDur(b, cs, v1off, v0off, dur) {
  const d = dvOf(b);
  if (b[cs] === 1) {
    d.setUint32(cs + v1off, Math.floor(dur / 4294967296));
    d.setUint32(cs + v1off + 4, dur >>> 0);
  } else d.setUint32(cs + v0off, dur >>> 0);
}

function parseInit(init) {
  const moov = boxes(init).find((b) => b.type === 'moov');
  if (!moov) throw new Error('init segment without moov');
  const dv = dvOf(init);
  const mvhd = child(init, moov, 'mvhd');
  const mcs = mvhd.start + mvhd.hdr;
  const movieTs = dv.getUint32(mcs + (init[mcs] === 1 ? 20 : 12));
  const trex = new Map();
  const mvex = child(init, moov, 'mvex');
  for (const t of mvex ? boxes(init, mvex.start + mvex.hdr, mvex.end) : []) {
    if (t.type !== 'trex') continue;
    const c = t.start + t.hdr;
    trex.set(dv.getUint32(c + 4), { dur: dv.getUint32(c + 12), size: dv.getUint32(c + 16), flags: dv.getUint32(c + 20) });
  }
  const traks = boxes(init, moov.start + moov.hdr, moov.end)
    .filter((b) => b.type === 'trak')
    .map((box) => {
      const tkhd = child(init, box, 'tkhd');
      const tcs = tkhd.start + tkhd.hdr;
      const mdhd = child(init, child(init, box, 'mdia'), 'mdhd');
      const dcs = mdhd.start + mdhd.hdr;
      return {
        box,
        id: dv.getUint32(tcs + (init[tcs] === 1 ? 20 : 12)),
        ts: dv.getUint32(dcs + (init[dcs] === 1 ? 20 : 12)),
      };
    });
  return { moov, mvhd, movieTs, trex, traks };
}

/** Add the samples of every traf in one buffer of [moof mdat]... to the track they belong to */
function parseFragment(u, trexMap, perTrack) {
  const dv = dvOf(u);
  for (const moof of boxes(u).filter((b) => b.type === 'moof')) {
    for (const traf of boxes(u, moof.start + moof.hdr, moof.end).filter((b) => b.type === 'traf')) {
      const tk = boxes(u, traf.start + traf.hdr, traf.end);
      const tfhd = tk.find((b) => b.type === 'tfhd');
      const c = tfhd.start + tfhd.hdr;
      const tflags = dv.getUint32(c) & 0xffffff;
      const trackId = dv.getUint32(c + 4);
      const dest = perTrack.get(trackId);
      if (!dest) continue;
      const def = trexMap.get(trackId) || { dur: 0, size: 0, flags: 0 };
      let p = c + 8;
      let base = moof.start;
      if (tflags & 1) {
        base = Number(dv.getBigUint64(p));
        p += 8;
      }
      if (tflags & 2) p += 4;
      let dDur = def.dur;
      let dSize = def.size;
      let dFlags = def.flags;
      if (tflags & 8) {
        dDur = dv.getUint32(p);
        p += 4;
      }
      if (tflags & 0x10) {
        dSize = dv.getUint32(p);
        p += 4;
      }
      if (tflags & 0x20) dFlags = dv.getUint32(p);
      const tfdt = tk.find((b) => b.type === 'tfdt');
      if (tfdt && dest.start === null) {
        const q = tfdt.start + tfdt.hdr;
        dest.start = u[q] === 1 ? Number(dv.getBigUint64(q + 4)) : dv.getUint32(q + 4);
      }
      let next = base;
      for (const trun of tk.filter((b) => b.type === 'trun')) {
        const rc = trun.start + trun.hdr;
        const ver = u[rc];
        const fl = dv.getUint32(rc) & 0xffffff;
        const n = dv.getUint32(rc + 4);
        let q = rc + 8;
        let pos = next;
        if (fl & 1) {
          pos = base + dv.getInt32(q);
          q += 4;
        }
        let first = null;
        if (fl & 4) {
          first = dv.getUint32(q);
          q += 4;
        }
        for (let i = 0; i < n; i++) {
          let dur = dDur;
          let size = dSize;
          let flags = dFlags;
          let cts = 0;
          if (fl & 0x100) {
            dur = dv.getUint32(q);
            q += 4;
          }
          if (fl & 0x200) {
            size = dv.getUint32(q);
            q += 4;
          }
          if (fl & 0x400) {
            flags = dv.getUint32(q);
            q += 4;
          } else if (i === 0 && first !== null) flags = first;
          if (fl & 0x800) {
            cts = ver === 1 ? dv.getInt32(q) : dv.getUint32(q);
            q += 4;
          }
          // subarray() quietly clamps bad offsets, so check the bounds ourselves
          if (pos < 0 || pos + size > u.length) throw new Error('sample out of bounds');
          dest.samples.push({ dur, size, sync: !(flags & 0x10000), cts, data: u.subarray(pos, pos + size) });
          pos += size;
        }
        next = pos;
      }
    }
  }
}

function buildTrak(init, trakBox, tr, tbl, movieTs, edits) {
  const parts = [];
  for (const c of boxes(init, trakBox.start + trakBox.hdr, trakBox.end)) {
    if (c.type === 'edts') continue;
    if (c.type === 'tkhd') {
      const b = init.slice(c.start, c.end);
      setDur(b, 8, 28, 20, edits.total);
      parts.push(b);
      if (edits.lead) {
        // The track starts later than the others: an empty edit keeps audio and video in sync
        const e = (d, t) => [u32b(d), u32b(t), u32b(0x00010000)];
        parts.push(mk('edts', [mk('elst', [u32b(0), u32b(2), ...e(edits.lead, 0xffffffff), ...e(edits.media, 0)])]));
      }
    } else if (c.type === 'mdia') {
      const mp = [];
      for (const m of boxes(init, c.start + c.hdr, c.end)) {
        if (m.type === 'mdhd') {
          const b = init.slice(m.start, m.end);
          setDur(b, 8, 24, 16, tr.dur);
          mp.push(b);
        } else if (m.type === 'minf') {
          const ip = [];
          for (const n of boxes(init, m.start + m.hdr, m.end)) {
            if (n.type !== 'stbl') {
              ip.push(init.slice(n.start, n.end));
              continue;
            }
            const stsd = boxes(init, n.start + n.hdr, n.end).find((x) => x.type === 'stsd');
            const sp = [init.slice(stsd.start, stsd.end)];
            sp.push(mk('stts', [u32b(0), u32b(tbl.stts.length), words(tbl.stts.flat())]));
            if (tbl.ctts) {
              sp.push(
                mk('ctts', [
                  u32b(tbl.ctts.neg ? 0x01000000 : 0),
                  u32b(tbl.ctts.e.length),
                  words(tbl.ctts.e.flat(), tbl.ctts.neg),
                ]),
              );
            }
            if (tbl.stss) sp.push(mk('stss', [u32b(0), u32b(tbl.stss.length), words(tbl.stss)]));
            sp.push(mk('stsc', [u32b(0), u32b(tbl.stsc.length), words(tbl.stsc.flat())]));
            sp.push(mk('stsz', [u32b(0), u32b(0), u32b(tr.samples.length), words(tr.samples.map((x) => x.size))]));
            sp.push(mk('stco', [u32b(0), u32b(tbl.stco.length), words(tbl.stco)]));
            ip.push(mk('stbl', sp));
          }
          mp.push(mk('minf', ip));
        } else mp.push(init.slice(m.start, m.end));
      }
      parts.push(mk('mdia', mp));
    } else parts.push(init.slice(c.start, c.end));
  }
  return mk('trak', parts);
}

/**
 * @param {Uint8Array} init       init segment (ftyp + moov, with mvex)
 * @param {Uint8Array[]} fragments buffers of moof/mdat pairs, in playing order
 * @returns {Uint8Array[]} parts of the standard MP4, in order
 */
export function flattenFragmentedMp4(init, fragments) {
  const info = parseInit(init);
  const perTrack = new Map(info.traks.map((t) => [t.id, { t, samples: [], start: null, dur: 0 }]));
  for (const frag of fragments) parseFragment(frag, info.trex, perTrack);
  const tracks = info.traks.map((t) => perTrack.get(t.id)).filter((x) => x.samples.length);
  if (!tracks.length) throw new Error('no samples');
  for (const tr of tracks) tr.dur = tr.samples.reduce((s, x) => s + x.dur, 0);
  const startSec = tracks.map((tr) => (tr.start || 0) / tr.t.ts);
  const minStart = Math.min(...startSec);

  // Data area: ~1 second chunks of every track, interleaved by time
  const chunks = [];
  tracks.forEach((tr, ti) => {
    let dts = 0;
    let cur = null;
    for (const s of tr.samples) {
      const sec = dts / tr.t.ts;
      if (!cur || sec - cur.rel >= 1) {
        cur = { ti, rel: sec, sec: startSec[ti] + sec, samples: [] };
        chunks.push(cur);
      }
      cur.samples.push(s);
      dts += s.dur;
    }
  });
  chunks.sort((a, b) => a.sec - b.sec || a.ti - b.ti);
  const rel = tracks.map(() => []);
  const pieces = [];
  let off = 0;
  for (const c of chunks) {
    rel[c.ti].push(off);
    // Samples that sit next to each other in the source become one piece
    let runStart = 0;
    const flush = (end) => {
      const a = c.samples[runStart].data;
      let len = 0;
      for (let i = runStart; i < end; i++) len += c.samples[i].size;
      pieces.push(new Uint8Array(a.buffer, a.byteOffset, len));
      off += len;
    };
    for (let i = 1; i <= c.samples.length; i++) {
      const prev = c.samples[i - 1].data;
      const next = c.samples[i]?.data;
      if (!next || prev.buffer !== next.buffer || prev.byteOffset + prev.length !== next.byteOffset) {
        flush(i);
        runStart = i;
      }
    }
  }
  if (off + 8 > 0xffffffff) throw new Error('over 4 GB');

  const tables = tracks.map((tr, i) => {
    const smp = tr.samples;
    const tbl = { stts: rle(smp.map((x) => x.dur)) };
    if (smp.some((x) => x.cts !== 0)) tbl.ctts = { e: rle(smp.map((x) => x.cts)), neg: smp.some((x) => x.cts < 0) };
    let first = 1;
    const mine = chunks.filter((c) => c.ti === i);
    tbl.stsc = rle(mine.map((c) => c.samples.length)).map(([n, v]) => {
      const e = [first, v, 1];
      first += n;
      return e;
    });
    if (smp.some((x) => !x.sync)) tbl.stss = smp.flatMap((x, k) => (x.sync ? [k + 1] : []));
    return tbl;
  });

  const toMovie = (v, ts) => Math.round((v / ts) * info.movieTs);
  const edits = tracks.map((tr, i) => {
    const media = toMovie(tr.dur, tr.t.ts);
    const lead = Math.round((startSec[i] - minStart) * info.movieTs);
    return { media, lead, total: media + lead };
  });
  const movieDur = Math.max(...edits.map((e) => e.total));
  const ftyp = mk('ftyp', [enc('isom'), u32b(512), enc('isomiso2avc1mp41')]);
  const buildMoov = (base) => {
    const mvhd = init.slice(info.mvhd.start, info.mvhd.end);
    setDur(mvhd, 8, 24, 16, movieDur);
    dvOf(mvhd).setUint32(8 + (mvhd[8] === 1 ? 108 : 96), Math.max(...info.traks.map((t) => t.id)) + 1);
    const traks = tracks.map((tr, i) =>
      buildTrak(init, tr.t.box, tr, { ...tables[i], stco: rel[i].map((r) => base + r) }, info.movieTs, edits[i]),
    );
    return mk('moov', [mvhd, ...traks]);
  };
  const moovLen = buildMoov(0).length;
  const moov = buildMoov(ftyp.length + moovLen + 8);
  const mdatHead = new Uint8Array(8);
  new DataView(mdatHead.buffer).setUint32(0, off + 8);
  mdatHead.set(enc('mdat'), 4);
  return [ftyp, moov, mdatHead, ...pieces];
}
