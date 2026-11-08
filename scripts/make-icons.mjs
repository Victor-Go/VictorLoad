// Draws the extension icons (icons/icon16|32|48|128.png) with no dependencies.
//
// The icon is the monogram "VL" in a liquid-glass style: a golden V and a clear L next to each other.
// Where they meet, the L is cut back so a thin gap of background shows between the letters. The L's
// stem rises out of the V like the shaft of a download arrow (the V is the head), and its foot is the tray.
// The letters are translucent: the background shows through and bends near the edges, a thin highlight
// runs along the edges and a soft gloss sits on top. The background is a deep indigo gradient with a
// cyan glow in the top-left corner and a fuchsia glow in the bottom-right, on a rounded square.
//
// Usage: node scripts/make-icons.mjs   (or: npm run icons)
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [16, 32, 48, 128];

// ---- geometry ----
// The letters are designed on a 225 x 240 grid and mapped into the unit square (0..1).

const SCALE = 0.56 / 240; // letter height = 56% of the icon
const OX = 0.5 - (225 / 2) * SCALE; // horizontally centred
const OY = 0.5 - (240 / 2) * SCALE; // vertically centred
const map = (pts) => pts.map(([x, y]) => [OX + (x - 60) * SCALE, OY + (y - 55) * SCALE]);

// V: two slanted arms meeting in a flat point; the inner edges meet at the notch (167.5, 231.6)
const V = map([
  [60, 55],
  [105, 55],
  [167.5, 231.6],
  [230, 55],
  [275, 55],
  [190, 295],
  [145, 295],
]);
// L: stem + foot (the foot runs out to the right, past the V)
const L = map([
  [144.5, 55],
  [190.5, 55],
  [190.5, 253],
  [285, 253],
  [285, 295],
  [144.5, 295],
]);

/** Soften every corner of a polygon: each vertex is replaced by a small quadratic curve */
function roundPoly(pts, r, steps = 6) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i + n - 1) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const l1 = Math.hypot(p0[0] - p1[0], p0[1] - p1[1]);
    const l2 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const t = Math.min(r, l1 * 0.45, l2 * 0.45);
    const a = [p1[0] + ((p0[0] - p1[0]) / l1) * t, p1[1] + ((p0[1] - p1[1]) / l1) * t];
    const b = [p1[0] + ((p2[0] - p1[0]) / l2) * t, p1[1] + ((p2[1] - p1[1]) / l2) * t];
    for (let k = 0; k <= steps; k++) {
      const u = k / steps;
      out.push([
        (1 - u) * (1 - u) * a[0] + 2 * (1 - u) * u * p1[0] + u * u * b[0],
        (1 - u) * (1 - u) * a[1] + 2 * (1 - u) * u * p1[1] + u * u * b[1],
      ]);
    }
  }
  return out;
}
const CORNER_R = 0.02; // how soft the letter corners are (unit square)
const VR = roundPoly(V, CORNER_R);
const LR = roundPoly(L, CORNER_R);

const CORNER = 0.225; // squircle corner radius
const BASE = [
  [0.0, [0x0a, 0x1a, 0x66]], // deep navy
  [0.5, [0x34, 0x24, 0xc4]], // electric indigo
  [1.0, [0x7a, 0x2b, 0xd6]], // vivid violet
];
const GLOW_A = { at: [0.0, 0.0], radius: 0.62, color: [0x19, 0xd3, 0xf5], strength: 0.95 }; // cyan, top-left
const GLOW_B = { at: [1.0, 1.0], radius: 0.55, color: [0xe0, 0x3c, 0xf0], strength: 0.85 }; // fuchsia, bottom-right
const GAP = 0.024; // width of the cut that separates the L from the V (unit square)
const YELLOW = [0xff, 0xd6, 0x0a];
const WHITE = [255, 255, 255];

const mix = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
const smooth = (e0, e1, v) => {
  const t = Math.max(0, Math.min(1, (v - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

function background(x, y) {
  // 1. diagonal base gradient
  const t = Math.max(0, Math.min(1, (x + y) / 2));
  let c = BASE[BASE.length - 1][1];
  for (let i = 1; i < BASE.length; i++) {
    if (t <= BASE[i][0]) {
      c = mix(BASE[i - 1][1], BASE[i][1], (t - BASE[i - 1][0]) / (BASE[i][0] - BASE[i - 1][0]));
      break;
    }
  }
  // 2. two corner glows (kept away from the letters so they stay readable)
  for (const g of [GLOW_A, GLOW_B]) {
    const d = Math.hypot(x - g.at[0], y - g.at[1]);
    c = mix(c, g.color, (1 - smooth(0, g.radius, d)) * g.strength);
  }
  // 3. glassy highlight fading out along the top
  c = mix(c, [255, 255, 255], (1 - smooth(0, 0.5, y)) * 0.07);
  // 4. light rim, strongest on the top-left edge
  const depth = -sdSquircle(x, y);
  c = mix(c, [255, 255, 255], (1 - smooth(0, 0.022, depth)) * (0.1 + 0.3 * (1 - (x + y) / 2)));
  return c;
}

/** signed distance to the rounded square (negative inside) */
function sdSquircle(x, y) {
  const qx = Math.abs(x - 0.5) - (0.5 - CORNER);
  const qy = Math.abs(y - 0.5) - (0.5 - CORNER);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - CORNER;
}

/** signed distance to a polygon (negative inside) */
function sdPolygon(x, y, pts) {
  let d = Infinity;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, ay] = pts[j];
    const [bx, by] = pts[i];
    const ex = bx - ax;
    const ey = by - ay;
    const h = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey)));
    d = Math.min(d, Math.hypot(x - ax - ex * h, y - ay - ey * h));
    if (ay > y !== by > y && x < ax + ((y - ay) / (by - ay)) * ex) inside = !inside;
  }
  return inside ? -d : d;
}

// ---- rendering ----
const norm = (vx, vy) => {
  const l = Math.hypot(vx, vy) || 1;
  return [vx / l, vy / l];
};
const LIGHT = norm(-0.55, -0.83); // light comes from the top-left
const centroid = (pts) => [
  pts.reduce((a, p) => a + p[0], 0) / pts.length,
  pts.reduce((a, p) => a + p[1], 0) / pts.length,
];
const bounds = (pts) => ({ top: Math.min(...pts.map((p) => p[1])), bottom: Math.max(...pts.map((p) => p[1])) });

// the L after the cut: L minus a margin around the V (boolean subtract, exact enough as a distance)
const sdV = (x, y) => sdPolygon(x, y, VR);
const sdL = (x, y) => Math.max(sdPolygon(x, y, LR), GAP - sdPolygon(x, y, VR));

// V: golden glass gel (mostly saturated, so the yellow stays vivid). L: clear frosted glass.
const GLASS = {
  V: { sd: sdV, top: [255, 236, 110], bottom: [255, 172, 0], alpha: 0.9, center: centroid(VR), box: bounds(VR) },
  L: { sd: sdL, top: [255, 255, 255], bottom: [225, 235, 255], alpha: 0.4, center: centroid(LR), box: bounds(LR) },
};

/** colour of a glass letter at (x, y), where d is its signed distance (<= 0 inside) */
function glass(x, y, d, g, clarity) {
  const E = 0.0025;
  const n = norm(g.sd(x + E, y) - g.sd(x - E, y), g.sd(x, y + E) - g.sd(x, y - E)); // outward normal
  const depth = -d;
  const facing = n[0] * LIGHT[0] + n[1] * LIGHT[1]; // +1: this edge faces the light
  const t = Math.max(0, Math.min(1, (y - g.box.top) / (g.box.bottom - g.box.top)));

  // what is behind: magnified a little and bent near the edges (refraction)
  const bend = 0.04 * (1 - smooth(0, 0.06, depth));
  const sx = g.center[0] + (x - g.center[0]) * 0.93 - n[0] * bend;
  const sy = g.center[1] + (y - g.center[1]) * 0.93 - n[1] * bend;
  const behind = background(sx, sy);

  // body: tinted glass, top lighter than bottom
  const tint = mix(g.top, g.bottom, t);
  let c = mix(behind, tint, Math.min(0.97, g.alpha * clarity));
  // a little depth: the middle of the glass is slightly deeper in colour
  c = c.map((v) => v * (1 - 0.07 * smooth(0.03, 0.12, depth)));
  // soft gloss on the upper part
  c = mix(c, [255, 255, 255], (1 - smooth(0, 0.55, t)) * 0.28);
  // glow just inside every edge
  c = mix(c, [255, 255, 255], (1 - smooth(0, 0.035, depth)) * 0.26);
  // light gathered by refraction on the side away from the light
  c = mix(c, [255, 255, 255], (1 - smooth(0, 0.05, depth)) * Math.pow(Math.max(0, -facing), 1.5) * 0.24);
  // thin specular line along the edge, strongest where the edge faces the light
  const line = 1 - smooth(0, 0.009, depth);
  return mix(c, [255, 255, 255], Math.min(1, line * (0.3 + 0.7 * Math.pow(Math.max(0, facing), 1.5))));
}

function shade(x, y, clarity) {
  let c = background(x, y);
  const dV = sdV(x, y);
  const dL = sdL(x, y);
  // soft shadow under both letters lifts them off the background
  const shadow = Math.max(
    1 - smooth(-0.01, 0.045, sdV(x - 0.012, y - 0.024)),
    1 - smooth(-0.01, 0.045, sdL(x - 0.012, y - 0.024)),
  );
  c = c.map((v) => v * (1 - shadow * 0.3));
  if (dL <= 0) c = glass(x, y, dL, GLASS.L, clarity);
  if (dV <= 0) c = glass(x, y, dV, GLASS.V, clarity);
  return c;
}

export function render(size) {
  const SS = 4; // 4x4 supersampling
  const clarity = size <= 24 ? 1.3 : size <= 48 ? 1.12 : 1; // small icons: less transparent, so the letters stay readable
  const px = 1 / size;
  const out = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (i + (sx + 0.5) / SS) * px;
          const y = (j + (sy + 0.5) / SS) * px;
          if (sdSquircle(x, y) > 0) continue;
          const [cr, cg, cb] = shade(x, y, clarity);
          r += cr;
          g += cg;
          b += cb;
          a += 1;
        }
      }
      const o = (j * size + i) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  return out;
}

// ---- PNG writer ----
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const v of buf) c = CRC[(c ^ v) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = join(ROOT, 'icons');
  mkdirSync(dir, { recursive: true });
  for (const s of SIZES) {
    writeFileSync(join(dir, `icon${s}.png`), png(s, render(s)));
    console.log(`icons/icon${s}.png`);
  }
}
