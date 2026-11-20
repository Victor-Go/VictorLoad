// Runs the real src/mse.js in a tiny fake page and records a synthetic fragmented MP4 through it,
// the way the player would hand segments to a SourceBuffer, then saves it and returns the file.
// `opfs`: 'ok' (a working origin-private file system), 'fail' (writes throw) or 'none' (no OPFS at all).
// mse.js installs itself once per process, so every scenario lives in its own test file.

const enc = (s) => new TextEncoder().encode(s);
const cat = (...a) => {
  const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of a) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};
const u32 = (n) => {
  const o = new Uint8Array(4);
  new DataView(o.buffer).setUint32(0, n);
  return o;
};
const box = (type, ...payload) => {
  const p = cat(...payload);
  return cat(u32(8 + p.length), enc(type), p);
};
const zeros = (n) => new Uint8Array(n);

/** ftyp + moov for one video track (timescale 1000) */
function initSegment() {
  const mvhd = box('mvhd', zeros(100)); // version 0, 108 bytes in all
  const tkhd = (() => {
    const p = zeros(84);
    new DataView(p.buffer).setUint32(76, 1280 * 65536); // width, 16.16
    new DataView(p.buffer).setUint32(80, 720 * 65536);
    return box('tkhd', p);
  })();
  const mdhd = (() => {
    const p = zeros(24);
    new DataView(p.buffer).setUint32(12, 1000); // timescale
    return box('mdhd', p);
  })();
  const hdlr = box('hdlr', zeros(8), enc('vide'), zeros(13));
  const stbl = box('stbl', box('stsd', zeros(8)));
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', stbl)));
  const trex = box('trex', zeros(24));
  return cat(box('ftyp', enc('isom'), zeros(4), enc('isom')), box('moov', mvhd, trak, box('mvex', trex)));
}

/** One [moof + mdat] fragment: samples are { size, sync } and 40 ms long */
function fragment(startMs, samples, fill) {
  const trunBody = (dataOffset) =>
    cat(
      u32(0x000701), // version 0, flags: data offset, sample duration, sample size, sample flags
      u32(samples.length),
      u32(dataOffset),
      ...samples.map((s) => cat(u32(40), u32(s.size), u32(s.sync ? 0 : 0x10000))),
    );
  const build = (dataOffset) =>
    box(
      'moof',
      box('mfhd', zeros(8)),
      box('traf', box('tfhd', u32(0x020000), u32(1)), box('tfdt', zeros(4), u32(startMs)), box('trun', trunBody(dataOffset))),
    );
  const moof = build(build(0).length + 8);
  const payload = cat(...samples.map((s, i) => new Uint8Array(s.size).fill((fill + i) & 255)));
  return { bytes: cat(moof, box('mdat', payload)), payload };
}

export async function runCapture({ opfs = 'ok', bigAt = 0 } = {}) {
  if (bigAt) globalThis.__vlMseBigAt = bigAt;
  // mse.js revokes the download URL after two minutes; that timer must not keep the test process alive
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...a) => {
    const t = realSetTimeout(fn, ms, ...a);
    if (ms >= 60000) t.unref?.();
    return t;
  };
  const listeners = {};
  const posted = [];
  const blobs = [];
  const written = []; // names of the files the fake OPFS received
  const video = { duration: 1.2, currentTime: 0, playbackRate: 1, muted: false, paused: true, play: async () => {}, pause() {} };

  // ---- a fake origin-private file system ----
  class FileHandle {
    constructor(dir, name) {
      Object.assign(this, { dir, name });
    }
    async createWritable() {
      if (opfs === 'fail') throw new Error('disk error');
      const chunks = [];
      return {
        write: async (b) => void chunks.push(b),
        close: async () => {
          this.dir.files.set(this.name, new Blob(chunks));
          written.push(this.name);
        },
      };
    }
    async getFile() {
      return this.dir.files.get(this.name);
    }
  }
  class Dir {
    files = new Map();
    dirs = new Map();
    async getDirectoryHandle(name, { create } = {}) {
      if (!this.dirs.has(name)) {
        if (!create) throw new Error('NotFoundError');
        this.dirs.set(name, new Dir());
      }
      return this.dirs.get(name);
    }
    async getFileHandle(name, { create } = {}) {
      if (!this.files.has(name) && !create) throw new Error('NotFoundError');
      return new FileHandle(this, name);
    }
    async removeEntry(name) {
      this.files.delete(name);
      this.dirs.delete(name);
    }
    async *entries() {
      for (const e of this.dirs) yield e;
    }
  }
  const root = new Dir();
  const navigatorFake = {
    storage: opfs === 'none' ? undefined : { getDirectory: async () => root },
    locks: { request: () => new Promise(() => {}), query: async () => ({ held: [] }) },
  };
  Object.defineProperty(globalThis, 'navigator', { value: navigatorFake, configurable: true });

  URL.createObjectURL = (b) => (blobs.push(b), 'blob:fake');
  Object.assign(globalThis, {
    window: globalThis,
    location: { hostname: 'www.youtube.com', href: 'https://www.youtube.com/watch?v=abc123', search: '?v=abc123' },
    document: {
      title: 'Clip - YouTube',
      documentElement: { appendChild() {} },
      querySelector: (s) => (/video/.test(s) ? video : null),
      getElementById: () => null,
      createElement: () => ({ style: {}, click() {}, remove() {} }),
    },
    addEventListener: (type, fn) => void (listeners[type] ||= []).push(fn),
    postMessage: (data) => {
      posted.push(data);
      setTimeout(() => listeners.message?.forEach((fn) => fn({ source: globalThis, data })), 0);
    },
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
  await import('../../src/mse.js');

  const sb = new MediaSource().addSourceBuffer('video/mp4; codecs="avc1.64001f"');
  sb.appendBuffer(initSegment());
  const frags = [
    fragment(0, [{ size: 120, sync: true }, { size: 80, sync: false }, { size: 90, sync: false }], 10),
    fragment(120, [{ size: 150, sync: true }, { size: 60, sync: false }], 50),
    fragment(240, [{ size: 200, sync: true }, { size: 70, sync: false }, { size: 40, sync: false }], 90),
  ];
  // The player appends arbitrary pieces: split every fragment in two
  for (const f of frags) {
    const cut = Math.floor(f.bytes.length / 3);
    sb.appendBuffer(f.bytes.slice(0, cut));
    sb.appendBuffer(f.bytes.slice(cut));
  }
  const send = (data) => listeners.message.forEach((fn) => fn({ source: globalThis, data: { __victorloadCmd: 1, ...data } }));
  const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
  await tick(100);
  posted.length = 0;
  send({ cmd: 'status' });
  await tick();
  const status = posted.filter((d) => d.kind === 'mse-status').at(-1).status;
  const vgid = status.video[0]?.gid;
  send({ cmd: 'save', jobId: 'j1', vgid, agid: '', name: 'out' });
  for (let i = 0; i < 100 && !posted.some((d) => d.kind === 'mse-save' && (d.state === 'done' || d.state === 'error')); i++) {
    await tick(20);
  }
  const result = posted.filter((d) => d.kind === 'mse-save').at(-1);
  const file = blobs[0] ? Buffer.from(await blobs[0].arrayBuffer()) : null;
  return {
    result,
    file,
    status,
    written,
    expected: Buffer.from(cat(...frags.map((f) => f.payload))),
    send,
    posted,
    root,
  };
}

/** The payload of the top-level mdat box in an MP4 file, and the box types in order */
export function readMp4(file) {
  const types = [];
  let payload = null;
  let p = 0;
  while (p + 8 <= file.length) {
    let size = file.readUInt32BE(p);
    const type = file.toString('latin1', p + 4, p + 8);
    let hdr = 8;
    if (size === 1) {
      size = Number(file.readBigUInt64BE(p + 8));
      hdr = 16;
    }
    types.push(type);
    if (type === 'mdat') payload = file.subarray(p + hdr, p + size);
    p += size;
  }
  return { types, payload };
}
