// Runs inside the YouTube page itself (MAIN world, document_start).
// It hooks MSE (MediaSource / SourceBuffer) to record every segment the player hands to the decoder,
// puts the segments in time order and writes them out as a file. With H.264 + AAC the audio and
// video are merged into one mp4. Nothing here relies on YouTube's APIs, signatures or PO tokens.
(() => {
  if (window.__vlMse) return;
  window.__vlMse = true;

  // Read once at document_start, before any page script runs. The override exists so tests can reach the limit.
  const MAX_BYTES = +window.__vlMseMaxBytes || 1.5e9;
  let total = 0;
  let gseq = 0;
  const groups = new Map(); // gid -> group
  const sourceBuffers = new WeakMap(); // SourceBuffer -> {mime, kind, cur, vid}
  const post = (d) => window.postMessage({ __victorload: 1, ...d }, '*');

  const vidOf = () => {
    try {
      const u = new URL(location.href);
      return u.searchParams.get('v') || (u.pathname.match(/^\/(shorts|live|embed)\/([\w-]{6,})/) || [])[2] || '';
    } catch {
      return '';
    }
  };
  const mainVideo = () => document.querySelector('video.html5-main-video') || document.querySelector('video');

  // ---- MP4 box helpers ----
  function boxes(u, start = 0, end = u.length) {
    const out = [];
    const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
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
      out.push({ type, start: p, size, hdr, end: p + size });
      p += size;
    }
    return out;
  }
  const child = (u, b, type) => (b ? boxes(u, b.start + b.hdr, b.end).find((x) => x.type === type) : undefined);
  const dvOf = (u) => new DataView(u.buffer, u.byteOffset, u.byteLength);

  function parseInit(u) {
    const r = { ts: 0, w: 0, h: 0, handler: '' };
    const moov = boxes(u).find((b) => b.type === 'moov');
    const trak = child(u, moov, 'trak');
    if (!trak) return r;
    const dv = dvOf(u);
    const tkhd = child(u, trak, 'tkhd');
    if (tkhd) {
      const cs = tkhd.start + tkhd.hdr;
      const off = u[cs] === 1 ? 88 : 76;
      r.w = Math.round(dv.getUint32(cs + off) / 65536);
      r.h = Math.round(dv.getUint32(cs + off + 4) / 65536);
    }
    const mdia = child(u, trak, 'mdia');
    const mdhd = child(u, mdia, 'mdhd');
    if (mdhd) {
      const cs = mdhd.start + mdhd.hdr;
      r.ts = dv.getUint32(cs + (u[cs] === 1 ? 20 : 12));
    }
    const hdlr = child(u, mdia, 'hdlr');
    if (hdlr) {
      const cs = hdlr.start + hdlr.hdr + 8;
      r.handler = String.fromCharCode(u[cs], u[cs + 1], u[cs + 2], u[cs + 3]);
    }
    return r;
  }

  function parseMoof(u, moof) {
    const dv = dvOf(u);
    const traf = child(u, moof, 'traf');
    const tfdt = child(u, traf, 'tfdt');
    const tfhd = child(u, traf, 'tfhd');
    if (!tfdt) return null;
    const cs = tfdt.start + tfdt.hdr;
    const t = u[cs] === 1 ? Number(dv.getBigUint64(cs + 4)) : dv.getUint32(cs + 4);
    let defDur = 0;
    if (tfhd) {
      const c = tfhd.start + tfhd.hdr;
      const flags = dv.getUint32(c) & 0xffffff;
      let p = c + 8;
      if (flags & 1) p += 8;
      if (flags & 2) p += 4;
      if (flags & 8) defDur = dv.getUint32(p);
    }
    let dur = 0;
    for (const trun of boxes(u, traf.start + traf.hdr, traf.end).filter((b) => b.type === 'trun')) {
      const c = trun.start + trun.hdr;
      const flags = dv.getUint32(c) & 0xffffff;
      const count = dv.getUint32(c + 4);
      let p = c + 8;
      if (flags & 1) p += 4;
      if (flags & 4) p += 4;
      const per = (flags & 0x100 ? 4 : 0) + (flags & 0x200 ? 4 : 0) + (flags & 0x400 ? 4 : 0) + (flags & 0x800 ? 4 : 0);
      if (flags & 0x100) {
        for (let i = 0; i < count; i++) dur += dv.getUint32(p + i * per);
      } else dur += defDur * count;
    }
    return { t, dur };
  }

  // ---- WebM helpers ----
  function vint(u, p, keepMarker) {
    if (p >= u.length) return null;
    const b = u[p];
    let len = 1;
    let mask = 0x80;
    while (len <= 8 && !(b & mask)) {
      len++;
      mask >>= 1;
    }
    if (len > 8 || p + len > u.length) return null;
    let v = keepMarker ? b : b & (mask - 1);
    let unknown = (b & (mask - 1)) === mask - 1;
    for (let i = 1; i < len; i++) {
      v = v * 256 + u[p + i];
      if (u[p + i] !== 255) unknown = false;
    }
    return { v, len, unknown };
  }
  const readUint = (u, s, e) => {
    let v = 0;
    for (let i = s; i < e; i++) v = v * 256 + u[i];
    return v;
  };

  function webmRes(u) {
    let w = 0;
    let h = 0;
    const masters = [0x18538067, 0x1654ae6b, 0xae, 0xe0];
    const walk = (s, e) => {
      let p = s;
      while (p < e) {
        const id = vint(u, p, true);
        if (!id) return;
        const sz = vint(u, p + id.len, false);
        if (!sz) return;
        const ds = p + id.len + sz.len;
        const de = sz.unknown ? e : Math.min(e, ds + sz.v);
        if (masters.includes(id.v)) walk(ds, de);
        else if (id.v === 0xb0) w = readUint(u, ds, de);
        else if (id.v === 0xba) h = readUint(u, ds, de);
        p = de;
      }
    };
    walk(0, u.length);
    return { w, h };
  }

  function clusterTime(u, s, e) {
    let p = s;
    while (p < e) {
      const id = vint(u, p, true);
      if (!id) return -1;
      const sz = vint(u, p + id.len, false);
      if (!sz) return -1;
      const ds = p + id.len + sz.len;
      if (id.v === 0xe7) return readUint(u, ds, ds + sz.v);
      if (sz.unknown) return -1;
      p = ds + sz.v;
    }
    return -1;
  }

  // ---- Capture ----
  function hashBytes(u) {
    let h = 2166136261;
    for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619);
    return (h >>> 0).toString(16) + ':' + u.length;
  }

  function newGroup(st, u, container) {
    const hash = hashBytes(u);
    for (const g of groups.values()) {
      if (g.hash === hash && g.kind === st.kind && g.vid === st.vid) {
        st.cur = g;
        return;
      }
    }
    let info;
    if (container === 'mp4') info = parseInit(u);
    else info = { ...webmRes(u), ts: 1000 };
    const codec = (st.mime.match(/codecs="?([^"]+)"?/i) || [])[1] || '';
    const g = {
      gid: 'g' + ++gseq,
      kind: st.kind,
      container,
      mime: st.mime,
      codec,
      init: u,
      hash,
      ts: info.ts || 1000,
      w: info.w,
      h: info.h,
      segs: new Map(),
      bytes: u.length,
      vid: st.vid,
    };
    if (container === 'mp4') g.trex = trexDefaults(u);
    total += u.length;
    groups.set(g.gid, g);
    st.cur = g;
  }

  function storeSeg(g, t, dur, data) {
    if (t < 0) t = -1 - g.segs.size; // fall back to arrival order when the timestamp cannot be parsed
    if (g.segs.has(t)) return;
    g.segs.set(t, { t, dur, data });
    lastGroupId[g.kind] = g.gid;
    g.bytes += data.length;
    total += data.length;
  }

  const concat = (a, b) => {
    const o = new Uint8Array(a.length + b.length);
    o.set(a, 0);
    o.set(b, a.length);
    return o;
  };

  // True when the bytes look like the start of an MP4 box (sane size, printable fourcc).
  function validBoxHead(b) {
    if (b.length < 8) return true;
    const size = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0);
    if (size !== 0 && size !== 1 && size < 8) return false;
    for (let i = 4; i < 8; i++) {
      const c = b[i];
      if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 32 || c === 169))
        return false;
    }
    return true;
  }

  // Every sample must be fully present, otherwise the segment is truncated or misaligned.
  function segmentIsComplete(g, seg) {
    try {
      const smp = parseSamples(seg, g.trex || (g.trex = trexDefaults(g.init)));
      return smp.length > 0 && smp.every((s) => s.data.length === s.size);
    } catch {
      return false;
    }
  }

  // Diagnostics for segments we could not use: counted in the status and logged (first few only)
  let rejectedCount = 0;
  function noteReject(g, seg) {
    rejectedCount++;
    if (rejectedCount > 3) return;
    try {
      const bs = boxes(seg);
      const moof = bs.find((b) => b.type === 'moof');
      const traf = moof && child(seg, moof, 'traf');
      const tfhd = traf && child(seg, traf, 'tfhd');
      const trun = traf && child(seg, traf, 'trun');
      const dv = dvOf(seg);
      console.warn('[VictorLoad] unusable segment', {
        kind: g.kind,
        bytes: seg.length,
        boxes: bs.map((b) => `${b.type}:${b.size}`),
        tfhdFlags: tfhd ? dv.getUint32(tfhd.start + tfhd.hdr) & 0xffffff : null,
        trunFlags: trun ? dv.getUint32(trun.start + trun.hdr) & 0xffffff : null,
        trunSamples: trun ? dv.getUint32(trun.start + trun.hdr + 4) : null,
        dataOffset: trun && dv.getUint32(trun.start + trun.hdr) & 1 ? dv.getInt32(trun.start + trun.hdr + 8) : null,
      });
    } catch {
      // Diagnostics only: the segment is already counted as rejected
    }
  }

  // Errors thrown while recording a segment. They must never reach the player, so they are counted
  // and reported in the status (the side panel warns the user) instead of being thrown.
  let captureErrorCount = 0;
  function noteCaptureError(e) {
    captureErrorCount++;
    if (captureErrorCount <= 3) console.warn('[VictorLoad] could not record a segment', e);
  }

  /**
   * The player appends arbitrary byte ranges, not whole boxes (an mdat often arrives in several
   * pieces), so collect the bytes per SourceBuffer and only act on complete boxes.
   */
  function captureMp4(st, u) {
    let buf = st.pending ? concat(st.pending, u) : u;
    if (!validBoxHead(buf)) {
      st.pending = null;
      st.moof = null;
      if (!validBoxHead(u)) return;
      buf = u;
    }
    const bs = boxes(buf);
    const consumed = bs.length ? bs[bs.length - 1].end : 0;
    for (const b of bs) {
      const bytes = buf.subarray(b.start, b.end);
      if (b.type === 'ftyp') st.initParts = [bytes.slice()];
      else if (b.type === 'moov') {
        const init = concat((st.initParts || [new Uint8Array(0)])[0], bytes.slice());
        st.initParts = null;
        newGroup(st, init, 'mp4');
      } else if (b.type === 'moof') st.moof = bytes.slice();
      else if (b.type === 'mdat') {
        const g = st.cur;
        if (g && st.moof) {
          const seg = concat(st.moof, bytes);
          const moofBox = boxes(seg).find((x) => x.type === 'moof');
          const info = moofBox && parseMoof(seg, moofBox);
          if (info && segmentIsComplete(g, seg)) storeSeg(g, info.t, info.dur, seg);
          else noteReject(g, seg);
        }
        st.moof = null;
      }
    }
    st.pending = consumed < buf.length ? buf.slice(consumed) : null;
    if (st.pending && st.pending.length > 64 * 1024 * 1024) st.pending = null;
  }

  function capture(st, data) {
    if (total > MAX_BYTES) return;
    const src = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    const u = src.slice();
    if (/mp4/i.test(st.mime)) {
      captureMp4(st, u);
    } else if (/webm/i.test(st.mime)) {
      if (u[0] === 0x1a && u[1] === 0x45 && u[2] === 0xdf && u[3] === 0xa3) return newGroup(st, u, 'webm');
      const g = st.cur;
      if (!g) return;
      let p = 0;
      while (p < u.length) {
        const id = vint(u, p, true);
        if (!id) break;
        const sz = vint(u, p + id.len, false);
        if (!sz) break;
        const hs = id.len + sz.len;
        const end = sz.unknown ? u.length : Math.min(u.length, p + hs + sz.v);
        if (id.v === 0x1f43b675) storeSeg(g, clusterTime(u, p + hs, end), 0, u.slice(p, end));
        p = end;
      }
    }
  }

  const addSB = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    const sb = addSB.call(this, mime);
    try {
      sourceBuffers.set(sb, {
        mime: String(mime),
        kind: /^audio/i.test(mime) ? 'audio' : 'video',
        cur: null,
        vid: vidOf(),
      });
    } catch (e) {
      noteCaptureError(e);
    }
    return sb;
  };
  // A seek aborts the in-flight segment: drop any half-received box.
  const abortOrig = SourceBuffer.prototype.abort;
  SourceBuffer.prototype.abort = function () {
    try {
      const st = sourceBuffers.get(this);
      if (st) {
        st.pending = null;
        st.moof = null;
      }
    } catch {
      // Only clears our own buffers; whatever happens here, the player's abort() must still run
    }
    return abortOrig.apply(this, arguments);
  };
  const appendOrig = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    try {
      const st = sourceBuffers.get(this);
      if (st) {
        capture(st, data);
        scheduleStatus();
      }
    } catch (e) {
      noteCaptureError(e);
      scheduleStatus();
    }
    return appendOrig.call(this, data);
  };

  // ---- Coverage and gap detection ----
  const GAP_TOLERANCE = 0.6; // seconds; smaller holes are rounding noise
  const TAIL_TOLERANCE = 1.5; // the last segment may end slightly before the reported duration
  const lastGroupId = { video: '', audio: '' }; // most recently appended group per kind (what is playing now)

  /** Covered time spans [start, end] in seconds, merged and sorted */
  function spans(g) {
    const segs = sortedSegs(g);
    // WebM clusters carry no duration: use the smallest start-to-start distance as the typical length
    let typical = 5;
    if (g.container !== 'mp4' && segs.length > 1) {
      typical = Infinity;
      for (let i = 1; i < segs.length; i++) {
        const d = (segs[i].t - segs[i - 1].t) / g.ts;
        if (d > 0.05) typical = Math.min(typical, d);
      }
      if (!isFinite(typical)) typical = 5;
    }
    const out = [];
    for (const s of segs) {
      const a = s.t / g.ts;
      const b = a + (g.container === 'mp4' ? s.dur / g.ts : typical);
      const last = out[out.length - 1];
      if (last && a <= last[1] + 0.05) last[1] = Math.max(last[1], b);
      else out.push([a, b]);
    }
    return out;
  }

  /** Uncovered ranges inside [0, dur] */
  function gapsOf(sp, dur) {
    const out = [];
    let pos = 0;
    for (const [a, b] of sp) {
      if (a - pos > GAP_TOLERANCE) out.push([pos, a]);
      pos = Math.max(pos, b);
    }
    if (dur - pos > TAIL_TOLERANCE) out.push([pos, dur]);
    return out;
  }

  function unionGaps(a, b) {
    const all = [...a, ...b].sort((x, y) => x[0] - y[0]);
    const out = [];
    for (const g of all) {
      const last = out[out.length - 1];
      if (last && g[0] <= last[1]) last[1] = Math.max(last[1], g[1]);
      else out.push([g[0], g[1]]);
    }
    return out;
  }

  const sumGaps = (gs) => gs.reduce((s, g) => s + (g[1] - g[0]), 0);
  const round1 = (x) => Math.round(x * 10) / 10;

  function status() {
    const vid = vidOf();
    const v = mainVideo();
    const dur = v && isFinite(v.duration) ? v.duration : 0;
    const video = [];
    const audio = [];

    // Audio first: the video entries report gaps combined with the best audio group,
    // because the saved file needs both tracks to be complete.
    let bestAudio = null;
    for (const g of groups.values()) {
      if (g.vid !== vid || g.kind !== 'audio') continue;
      const gaps = dur ? gapsOf(spans(g), dur) : [];
      const o = {
        gid: g.gid,
        w: 0,
        h: 0,
        codec: g.codec,
        container: g.container,
        bytes: g.bytes,
        n: g.segs.size,
        gaps,
        cov: dur && g.segs.size ? Math.max(0, 1 - sumGaps(gaps) / dur) : 0,
      };
      audio.push(o);
      if (!bestAudio || o.cov > bestAudio.cov) bestAudio = o;
    }
    for (const g of groups.values()) {
      if (g.vid !== vid || g.kind !== 'video') continue;
      const own = dur ? gapsOf(spans(g), dur) : [];
      const gaps = bestAudio ? unionGaps(own, bestAudio.gaps) : own;
      video.push({
        gid: g.gid,
        w: g.w,
        h: g.h,
        codec: g.codec,
        container: g.container,
        bytes: g.bytes,
        n: g.segs.size,
        gaps,
        cov: dur && g.segs.size ? Math.max(0, 1 - sumGaps(gaps) / dur) : 0,
      });
    }
    for (const o of [...video, ...audio]) {
      o.holes = o.gaps.length;
      o.gaps = o.gaps.slice(0, 8).map(([a, b]) => [round1(a), round1(b)]);
    }
    return {
      videoId: vid,
      title: document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube$/, ''),
      duration: dur,
      video,
      audio,
      filling: !!fillTimer,
      fillResult,
      rejected: rejectedCount,
      captureErrors: captureErrorCount,
      full: total > MAX_BYTES,
    };
  }

  let statusTimer = null;
  function scheduleStatus() {
    if (statusTimer) return;
    statusTimer = setTimeout(() => {
      statusTimer = null;
      sendStatus();
    }, 800);
  }
  const sendStatus = () => post({ kind: 'mse-status', status: status() });

  window.addEventListener('yt-navigate-finish', () => {
    if (fillTimer) stopFill('stopped');
    fillResult = '';
    const vid = vidOf();
    for (const [k, g] of groups) {
      if (g.vid !== vid) {
        total -= g.bytes;
        groups.delete(k);
      }
    }
    sendStatus();
  });

  // ---- Auto fill ----
  // Find the first hole in what we have captured, seek there so the player fetches it, wait for the
  // data, then move on to the next hole. This also repairs holes left by seeking around.

  let fillTimer = null;
  let fill = null;
  let fillResult = ''; // '' | 'done' | 'stuck' | 'stopped' | 'noplay'

  const QUALITY_BY_HEIGHT = [
    [4320, 'highres'],
    [2160, 'hd2160'],
    [1440, 'hd1440'],
    [1080, 'hd1080'],
    [720, 'hd720'],
    [480, 'large'],
    [360, 'medium'],
    [240, 'small'],
    [144, 'tiny'],
  ];
  const qualityFor = (h) =>
    (QUALITY_BY_HEIGHT.find(([x]) => h >= x) || QUALITY_BY_HEIGHT[QUALITY_BY_HEIGHT.length - 1])[1];

  // Pin the player to one quality while filling. With adaptive switching the segments end up in
  // different groups and the holes never close. This uses YouTube's internal player API, so it may do nothing.
  function lockQuality(height) {
    try {
      const pl = document.getElementById('movie_player');
      if (!pl || !pl.setPlaybackQualityRange || !height) return null;
      const saved = localStorage.getItem('yt-player-quality');
      const q = qualityFor(height);
      pl.setPlaybackQualityRange(q, q);
      return { saved };
    } catch {
      return null;
    }
  }

  function unlockQuality(lock) {
    try {
      if (!lock) return;
      if (lock.saved === null) localStorage.removeItem('yt-player-quality');
      else localStorage.setItem('yt-player-quality', lock.saved);
      const pl = document.getElementById('movie_player');
      const levels = (pl.getAvailableQualityLevels && pl.getAvailableQualityLevels()) || [];
      pl.setPlaybackQualityRange('tiny', levels[0] || 'highres');
    } catch {
      // Internal player API that may not exist; the user can still pick a quality by hand
    }
  }

  function fillGaps(dur) {
    const vg = groups.get(fill.vgid);
    if (!fill.agid && lastGroupId.audio) fill.agid = lastGroupId.audio;
    const ag = fill.agid ? groups.get(fill.agid) : null;
    return unionGaps(vg ? gapsOf(spans(vg), dur) : [], ag ? gapsOf(spans(ag), dur) : []);
  }

  function startFill(target) {
    const v = mainVideo();
    if (!v || fillTimer) return;
    // Fill the quality the user picked; fall back to whatever is playing right now
    const vg = (target && groups.get(target.vgid)) || groups.get(lastGroupId.video);
    if (!vg || vg.vid !== vidOf()) {
      fillResult = 'noplay';
      sendStatus();
      return;
    }
    fillResult = '';
    fill = {
      vgid: vg.gid,
      agid: (target && target.agid) || lastGroupId.audio,
      saved: { t: v.currentTime, rate: v.playbackRate, muted: v.muted, paused: v.paused },
      lock: lockQuality(vg.h),
      lastTotal: total,
      lastProgress: Date.now(),
      seekAt: 0,
      tries: new Map(),
    };
    v.muted = true;
    v.playbackRate = 16;
    v.play().catch(() => {});
    fillTimer = setInterval(fillTick, 600);
    fillTick();
  }

  // "Auto download": fill the holes, then save. It runs in the page, so it carries on even if the
  // popup or side panel is closed.
  let autoJob = null;

  function autoSave(m) {
    if (fillTimer || autoJob) {
      post({ kind: 'mse-save', jobId: m.jobId, state: 'error', error: '已有缓冲任务在进行' });
      return;
    }
    autoJob = m;
    startFill({ vgid: m.vgid, agid: m.agid });
    if (!fillTimer && autoJob) {
      // startFill bailed out: nothing has been played yet
      autoJob = null;
      post({ kind: 'mse-save', jobId: m.jobId, state: 'error', error: '请先播放视频几秒，再点下载' });
    }
  }

  function stopFill(outcome, gaps) {
    const job = autoJob;
    autoJob = null;
    clearInterval(fillTimer);
    fillTimer = null;
    const v = mainVideo();
    if (v && fill) {
      v.playbackRate = fill.saved.rate || 1;
      v.muted = !!fill.saved.muted;
      try {
        v.currentTime = fill.saved.t || 0;
      } catch {
        // The player may have no seekable range right now; leaving the playhead where it is is fine
      }
      if (fill.saved.paused) v.pause();
      unlockQuality(fill.lock);
    }
    fill = null;
    fillResult = outcome || 'stopped';
    sendStatus();
    if (job) {
      if (outcome === 'done') save(job);
      else if (outcome === 'stuck') {
        const g = (gaps || []).slice(0, 8).map(([a, b]) => [round1(a), round1(b)]);
        post({ kind: 'mse-save', jobId: job.jobId, state: 'stuck', holes: (gaps || []).length, gaps: g });
      } else post({ kind: 'mse-save', jobId: job.jobId, state: 'cancelled' });
    }
  }

  function fillTick() {
    const v = mainVideo();
    if (!v || !fill) return stopFill('stopped');
    const vg = groups.get(fill.vgid);
    if (!vg || vg.vid !== vidOf()) return stopFill('stopped');
    const dur = v.duration;
    if (!dur || !isFinite(dur)) return;

    const gaps = fillGaps(dur);
    if (!gaps.length) return stopFill('done');

    const now = Date.now();
    if (total !== fill.lastTotal) {
      fill.lastTotal = total;
      fill.lastProgress = now;
    }
    if (autoJob)
      post({
        kind: 'mse-save',
        jobId: autoJob.jobId,
        state: 'buffering',
        pct: Math.max(0, Math.round((1 - sumGaps(gaps) / dur) * 100)),
      });
    const open = gaps.find((g) => (fill.tries.get(Math.round(g[0])) || 0) < 3);
    if (!open) return stopFill('stuck', gaps);

    const pos = v.currentTime;
    const stalled = now - fill.lastProgress > 2500; // nothing arrived for a while
    const behind = pos < open[0] - 0.5; // still playing through media we already have
    const inside = !behind && pos < open[1];
    const ahead = pos >= open[1]; // jumped past the hole

    // Only touch the playhead when needed, so in-flight fetches are not aborted needlessly
    if ((behind && stalled) || ahead || (inside && stalled)) {
      if (inside && stalled) {
        const k = Math.round(open[0]);
        fill.tries.set(k, (fill.tries.get(k) || 0) + 1);
      }
      if (now - fill.seekAt > 1200) {
        try {
          v.currentTime = Math.min(open[0] + 0.2, dur - 0.2);
        } catch {
          // Not seekable yet: the next tick tries again, and the hole's try counter stops endless retries
        }
        fill.seekAt = now;
        fill.lastProgress = now;
      }
    }
    if (v.paused || v.playbackRate !== 16) {
      v.playbackRate = 16;
      v.muted = true;
      v.play().catch(() => {});
    }
    sendStatus();
  }

  // ---- Muxing and saving ----
  function mk(type, parts) {
    let n = 8;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, n);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    let o = 8;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  const sortedSegs = (g) => [...g.segs.values()].sort((a, b) => a.t - b.t);

  // ---- fMP4 -> standard MP4 (ftyp + moov with full sample tables + mdat) ----
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

  function trexDefaults(init) {
    const d = { dur: 0, size: 0, flags: 0 };
    const moov = boxes(init).find((b) => b.type === 'moov');
    const trex = child(init, child(init, moov, 'mvex'), 'trex');
    if (trex) {
      const dv = dvOf(init);
      const c = trex.start + trex.hdr;
      d.dur = dv.getUint32(c + 12);
      d.size = dv.getUint32(c + 16);
      d.flags = dv.getUint32(c + 20);
    }
    return d;
  }

  /** Parse every sample in one [moof+mdat] fragment */
  function parseSamples(u, def) {
    const out = [];
    const dv = dvOf(u);
    for (const moof of boxes(u).filter((b) => b.type === 'moof')) {
      for (const traf of boxes(u, moof.start + moof.hdr, moof.end).filter((b) => b.type === 'traf')) {
        const tk = boxes(u, traf.start + traf.hdr, traf.end);
        const tfhd = tk.find((b) => b.type === 'tfhd');
        const c = tfhd.start + tfhd.hdr;
        const tflags = dv.getUint32(c) & 0xffffff;
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
        if (tflags & 0x20) {
          dFlags = dv.getUint32(p);
          p += 4;
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
            // subarray() quietly clamps or wraps bad offsets, so check the bounds ourselves
            if (pos < 0 || pos + size > u.length) throw new Error('sample out of bounds');
            out.push({ dur, size, sync: !(flags & 0x10000), cts, data: u.subarray(pos, pos + size) });
            pos += size;
          }
          next = pos;
        }
      }
    }
    return out;
  }

  /** Turn all fragments of one group (single-track fMP4) into per-chunk sample data */
  function trackData(g) {
    const chunks = [];
    for (const s of sortedSegs(g)) {
      let smp;
      try {
        smp = parseSamples(s.data, g.trex || (g.trex = trexDefaults(g.init)));
      } catch {
        continue; // skip a bad segment instead of failing the whole file
      }
      if (smp.length && smp.every((x) => x.data.length === x.size)) chunks.push({ sec: s.t / g.ts, samples: smp });
    }
    const all = chunks.flatMap((c) => c.samples);
    return { g, chunks, all, dur: all.reduce((s, x) => s + x.dur, 0) };
  }

  const setDur = (b, cs, v1off, v0off, dur) => {
    const d = dvOf(b);
    if (b[cs] === 1) {
      d.setUint32(cs + v1off, 0);
      d.setUint32(cs + v1off + 4, dur);
    } else d.setUint32(cs + v0off, dur);
  };

  function buildTrak(init, trakBox, td, tbl, movieTs, newId) {
    const parts = [];
    for (const c of boxes(init, trakBox.start + trakBox.hdr, trakBox.end)) {
      if (c.type === 'edts') continue;
      if (c.type === 'tkhd') {
        const b = init.slice(c.start, c.end);
        const cs = 8;
        if (newId) dvOf(b).setUint32(cs + (b[cs] === 1 ? 20 : 12), newId);
        setDur(b, cs, 28, 20, Math.round((td.dur / td.g.ts) * movieTs));
        parts.push(b);
      } else if (c.type === 'mdia') {
        const mp = [];
        for (const m of boxes(init, c.start + c.hdr, c.end)) {
          if (m.type === 'mdhd') {
            const b = init.slice(m.start, m.end);
            setDur(b, 8, 24, 16, td.dur);
            mp.push(b);
          } else if (m.type === 'minf') {
            const ip = [];
            for (const n of boxes(init, m.start + m.hdr, m.end)) {
              if (n.type !== 'stbl') {
                ip.push(init.slice(n.start, n.end));
                continue;
              }
              const stsd = child(init, n, 'stbl') || boxes(init, n.start + n.hdr, n.end).find((x) => x.type === 'stsd');
              const sp = [init.slice(stsd.start, stsd.end)];
              sp.push(mk('stts', [u32b(0), u32b(tbl.stts.length), words(tbl.stts.flat())]));
              if (tbl.ctts)
                sp.push(
                  mk('ctts', [
                    u32b(tbl.ctts.neg ? 0x01000000 : 0),
                    u32b(tbl.ctts.e.length),
                    words(tbl.ctts.e.flat(), tbl.ctts.neg),
                  ]),
                );
              sp.push(mk('stsc', [u32b(0), u32b(tbl.stsc.length), words(tbl.stsc.flat())]));
              sp.push(mk('stsz', [u32b(0), u32b(0), u32b(td.all.length), words(td.all.map((x) => x.size))]));
              sp.push(mk('stco', [u32b(0), u32b(tbl.stco.length), words(tbl.stco)]));
              if (tbl.stss) sp.push(mk('stss', [u32b(0), u32b(tbl.stss.length), words(tbl.stss)]));
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

  function flatMp4(gs, onProgress) {
    const tds = gs.map(trackData);
    for (const td of tds) if (!td.all.length) throw new Error('没有可用的样本数据');
    // Track ids: keep them unique
    const used = new Set();
    const ids = tds.map((td) => {
      const moov = boxes(td.g.init).find((b) => b.type === 'moov');
      const tk = child(td.g.init, child(td.g.init, moov, 'trak'), 'tkhd');
      const cs = tk.start + tk.hdr;
      let id = dvOf(td.g.init).getUint32(cs + (td.g.init[cs] === 1 ? 20 : 12));
      let changed = false;
      while (used.has(id)) {
        id++;
        changed = true;
      }
      used.add(id);
      return { id, changed };
    });

    // Data area: interleave the chunks of all tracks by time
    const order = [];
    tds.forEach((td, ti) => td.chunks.forEach((c, ci) => order.push({ ti, ci, sec: c.sec })));
    order.sort((a, b) => a.sec - b.sec || a.ti - b.ti);
    const rel = tds.map((td) => new Array(td.chunks.length).fill(0));
    const pieces = [];
    let off = 0;
    for (const o of order) {
      const smp = tds[o.ti].chunks[o.ci].samples;
      rel[o.ti][o.ci] = off;
      let contiguous = true;
      for (let i = 1; i < smp.length; i++) {
        const a = smp[i - 1].data;
        const b = smp[i].data;
        if (a.buffer !== b.buffer || a.byteOffset + a.length !== b.byteOffset) {
          contiguous = false;
          break;
        }
      }
      if (contiguous) {
        const a = smp[0].data;
        const len = smp.reduce((s, x) => s + x.size, 0);
        pieces.push(new Uint8Array(a.buffer, a.byteOffset, len));
        off += len;
      } else {
        for (const x of smp) {
          pieces.push(x.data);
          off += x.size;
        }
      }
    }
    if (off + 8 > 0xffffffff) throw new Error('文件超过 4GB，无法生成标准 MP4');

    const tables = tds.map((td) => {
      const smp = td.all;
      const tbl = { stts: rle(smp.map((x) => x.dur)).map(([n, v]) => [n, v]) };
      if (smp.some((x) => x.cts !== 0)) tbl.ctts = { e: rle(smp.map((x) => x.cts)), neg: smp.some((x) => x.cts < 0) };
      const spc = rle(td.chunks.map((c) => c.samples.length));
      let first = 1;
      tbl.stsc = spc.map(([n, v]) => {
        const e = [first, v, 1];
        first += n;
        return e;
      });
      if (smp.some((x) => !x.sync)) tbl.stss = smp.flatMap((x, i) => (x.sync ? [i + 1] : []));
      return tbl;
    });

    const vi = tds[0].g.init;
    const vmoov = boxes(vi).find((b) => b.type === 'moov');
    const mvhdBox = child(vi, vmoov, 'mvhd');
    const movieTs = dvOf(vi).getUint32(mvhdBox.start + 8 + (vi[mvhdBox.start + 8] === 1 ? 20 : 12));
    const movieDur = Math.max(...tds.map((td) => Math.round((td.dur / td.g.ts) * movieTs)));

    const ftyp = mk('ftyp', [enc('isom'), u32b(512), enc('isomiso2avc1mp41')]);
    const buildMoov = (base) => {
      const mvhd = vi.slice(mvhdBox.start, mvhdBox.end);
      setDur(mvhd, 8, 24, 16, movieDur);
      dvOf(mvhd).setUint32(8 + (mvhd[8] === 1 ? 108 : 96), Math.max(...ids.map((x) => x.id)) + 1);
      const traks = tds.map((td, i) => {
        const moov = boxes(td.g.init).find((b) => b.type === 'moov');
        const trak = child(td.g.init, moov, 'trak');
        const tbl = { ...tables[i], stco: rel[i].map((r) => base + r) };
        return buildTrak(td.g.init, trak, td, tbl, movieTs, ids[i].changed ? ids[i].id : 0);
      });
      return mk('moov', [mvhd, ...traks]);
    };
    const moovLen = buildMoov(0).length;
    const moov = buildMoov(ftyp.length + moovLen + 8);
    const mdatHead = new Uint8Array(8);
    new DataView(mdatHead.buffer).setUint32(0, off + 8);
    mdatHead.set(enc('mdat'), 4);
    return [ftyp, moov, mdatHead, ...pieces];
  }
  const enc = (s) => new TextEncoder().encode(s);

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    // An invalid name makes Chrome ignore the attribute and save under a random blob name,
    // so turn anything illegal into a space instead (the extension was already sanitized by the caller).
    const dot = filename.lastIndexOf('.');
    const stem = (dot > 0 ? filename.slice(0, dot) : filename)
      .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '')
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '');
    a.download = (stem || 'video') + (dot > 0 ? filename.slice(dot) : '');
    a.style.display = 'none';
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }

  function save(m) {
    const reply = (d) => post({ kind: 'mse-save', jobId: m.jobId, ...d });
    try {
      const vg = groups.get(m.vgid);
      let ag = m.agid ? groups.get(m.agid) : null;
      if (!ag) {
        // Pick the audio stream with the highest coverage
        const vid = vidOf();
        const dur = status().duration;
        const covered = (g) => (dur ? 1 - sumGaps(gapsOf(spans(g), dur)) / dur : 0);
        ag = [...groups.values()]
          .filter((g) => g.kind === 'audio' && g.vid === vid)
          .sort((a, b) => covered(b) - covered(a))[0];
      }
      if (!vg && !ag) throw new Error('没有已缓冲的数据，请先播放视频');
      reply({ state: 'progress', pct: 10 });
      const files = [];
      if (vg && ag && vg.container === 'mp4' && ag.container === 'mp4') {
        files.push({ name: m.name + '.mp4', parts: flatMp4([vg, ag]) });
      } else if (vg && !ag && vg.container === 'mp4') {
        files.push({ name: m.name + '.mp4', parts: flatMp4([vg]) });
      } else if (ag && !vg && ag.container === 'mp4') {
        files.push({ name: m.name + '.m4a', parts: flatMp4([ag]) });
      } else {
        if (vg)
          files.push({
            name: m.name + (ag ? '.video' : '') + (vg.container === 'webm' ? '.webm' : '.mp4'),
            parts: [vg.init, ...sortedSegs(vg).map((s) => s.data)],
          });
        if (ag)
          files.push({
            name: m.name + (vg ? '.audio' : '') + (ag.container === 'webm' ? '.webm' : '.m4a'),
            parts: [ag.init, ...sortedSegs(ag).map((s) => s.data)],
          });
      }
      reply({ state: 'progress', pct: 70 });
      for (const f of files) {
        const type = /\.webm$/.test(f.name) ? 'video/webm' : /\.m4a$/.test(f.name) ? 'audio/mp4' : 'video/mp4';
        triggerDownload(new Blob(f.parts, { type }), f.name);
      }
      reply({ state: 'done', name: files.map((f) => f.name).join(' + ') });
    } catch (e) {
      reply({ state: 'error', error: String((e && e.message) || e) });
    }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__victorloadCmd !== 1) return;
    const m = e.data;
    if (m.cmd === 'save') save(m);
    else if (m.cmd === 'autosave') autoSave(m);
    else if (m.cmd === 'fill-stop') {
      stopFill('stopped');
      post({ kind: 'mse-control', requestId: m.requestId, ok: true });
    } else if (m.cmd === 'status') sendStatus();
  });
})();
