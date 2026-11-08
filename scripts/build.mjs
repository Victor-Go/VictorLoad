// Builds dist/VictorLoad-v<version>.zip containing only what the extension needs.
// Dependency-free: a small ZIP writer is included so it runs the same on Windows, macOS and Linux.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep, dirname } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// What goes into the extension package (everything else - tests, dev pages, docs, CI - stays out)
const INCLUDE = ['manifest.json', '_locales', 'icons', 'rules', 'src', 'vendor'];

function walk(p, out = []) {
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const name of readdirSync(p).sort()) walk(join(p, name), out);
  } else out.push(p);
  return out;
}

// CRC-32 (zlib.crc32 only exists on newer Node versions)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** entries: [{ name, data }] -> Buffer (a standard ZIP archive, deterministic) */
export function makeZip(entries) {
  const DOS_TIME = 0;
  const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1; // fixed date => reproducible output
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = data.length ? deflateRawSync(data, { level: 9 }) : Buffer.alloc(0);
    const useDeflate = data.length > 0 && compressed.length < data.length;
    const body = useDeflate ? compressed : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0x0800, 6); // UTF-8 names
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, v2.0
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); // -rw-r--r--
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
  }

  const centralSize = centrals.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

export function collectFiles(root = ROOT) {
  const files = [];
  for (const item of INCLUDE) {
    const p = join(root, item);
    if (!existsSync(p)) throw new Error(`Missing required path: ${item}`);
    walk(p, files);
  }
  return files.map((f) => ({ name: relative(root, f).split(sep).join('/'), path: f }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  const files = collectFiles();
  const entries = files.map((f) => ({ name: f.name, data: readFileSync(f.path) }));
  const zip = makeZip(entries);
  const outDir = join(ROOT, 'dist');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `VictorLoad-v${manifest.version}.zip`);
  writeFileSync(out, zip);
  console.log(`Packed ${entries.length} files -> ${relative(ROOT, out)} (${(zip.length / 1024).toFixed(1)} KiB)`);
  console.log(`sha256 ${createHash('sha256').update(zip).digest('hex')}`);
}
