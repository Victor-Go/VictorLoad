// Shared helpers and the "main content" rules (ES module used by the background and the side panel)

export const DEFAULTS = {
  // Main-image filter
  imgMinW: 300,
  imgMinH: 300,
  imgMinKB: 30,
  // Main-video filter
  vidMinW: 320,
  vidMinH: 240,
  vidMinDur: 10, // seconds; unknown duration is not filtered
  vidMinMB: 0,
  // Behavior
  showBadge: true, // show a green check on already-downloaded images/videos in the page
  autoRemember: true, // remember the tag structure of what was selected on "Download selected"
  // Folder (inside the browser's Downloads folder) to save into. Placeholders: {site} {date} {year} {month}.
  // Empty = the Downloads folder itself.
  savePath: 'VictorLoad/{site}/',
  ytH264: true, // prefer H.264+AAC on YouTube so captured audio/video can be muxed into one mp4 (1080p max)
  // File name template. Placeholders: {tab} {name} {duration} {resolution}
  nameFormat: '{tab}',
  // UI language: 'auto' (default, follows the browser; Chinese browsers get Chinese, everything else English), 'zh' or 'en'
  uiLang: 'auto',
  // Where the UI opens: 'sidepanel' (docked, live) or 'popup' (floating, closes on blur)
  uiMode: 'sidepanel',
  // UI memory
  tab: 'video',
  imgMode: 'main',
  vidMode: 'main',
  prefHeight: 1080,
};

/** Stored settings on top of the defaults; the old "one folder per site" switch becomes a save path */
export function mergeSettings(stored) {
  const st = { ...(stored || {}) };
  if (st.savePath === undefined && st.subfolder === false) st.savePath = '';
  delete st.subfolder;
  return { ...DEFAULTS, ...st };
}

export const HISTORY_LIMIT = 5000;

// ---- History records ----
// A history record only has to draw one row in the list and mark the page's thumbnails as
// downloaded, so it is kept small: capped strings, no data: URLs, and the match keys stored as hashes.
// (chrome.storage.local holds about 10 MB, and the whole array is rewritten on every download.)
const HISTORY_CAPS = { title: 200, name: 200, pageUrl: 400, q: 40, videoUrl: 200, imageUrl: 600, thumb: 600 };

/**
 * Short, stable hash of a match key (cyrb53, 53 bits). 25 000 keys collide with a probability around
 * 1e-8, and a collision only means one extra green check. Already-hashed keys pass through unchanged.
 */
export function keyHash(k) {
  if (typeof k !== 'string' || !k) return '';
  if (k.startsWith('h:')) return k;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < k.length; i++) {
    const c = k.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 'h:' + (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Collect normalized download keys from history. */
export function downloadedKeySet(history) {
  const set = new Set();
  for (const r of history || []) for (const k of r.keys || []) set.add(keyHash(k));
  return set;
}

const isDataUrl = (s) => typeof s === 'string' && s.startsWith('data:');

/** The smallest record that still serves the history list. Idempotent. */
export function compactHistoryRecord(rec) {
  const cap = (s, n) => (typeof s === 'string' ? s.slice(0, n) : '');
  const kind = rec.kind === 'image' ? 'image' : 'video';
  // A data: URL can be megabytes long; it is neither shown nor needed to recognise the page again
  let url = isDataUrl(rec.url) ? '' : String(rec.url || '');
  if (kind === 'image') {
    if (url.length > HISTORY_CAPS.imageUrl) url = ''; // a cut-off image URL is useless as a thumbnail
  } else url = url.slice(0, HISTORY_CAPS.videoUrl); // only a display fallback
  let thumb = isDataUrl(rec.thumb) ? '' : String(rec.thumb || '');
  if (thumb.length > HISTORY_CAPS.thumb) thumb = '';
  if (thumb === url) thumb = ''; // images use the same address twice: store it once (see historyThumb)
  return {
    id: rec.id,
    time: rec.time,
    kind,
    title: cap(rec.title, HISTORY_CAPS.title),
    pageUrl: cap(rec.pageUrl, HISTORY_CAPS.pageUrl),
    host: cap(rec.host, 100),
    thumb,
    url,
    q: cap(rec.q, HISTORY_CAPS.q),
    keys: [...new Set((rec.keys || []).map(keyHash).filter(Boolean))],
    name: cap(rec.name, HISTORY_CAPS.name),
  };
}

/** Thumbnail address of a history record */
export function historyThumb(r) {
  return r.thumb || (r.kind === 'image' && !isDataUrl(r.url) ? r.url || '' : '');
}

export const isHistoryQuotaError = (e) => /quota/i.test(String((e && e.message) || e));

export function hostOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Normalize a URL into the key used to tell whether something was already downloaded */
export function normKey(u) {
  if (!u || typeof u !== 'string') return '';
  if (u.startsWith('data:')) return 'data:' + u.length + ':' + u.slice(5, 60);
  try {
    const x = new URL(u);
    if (x.hostname === 'pbs.twimg.com' && x.pathname.startsWith('/media/')) {
      return 'tw:' + x.pathname.split('/')[2].replace(/\.\w+$/, '');
    }
    if (x.hostname.endsWith('.twimg.com')) return x.origin + x.pathname;
    x.hash = '';
    return x.href;
  } catch {
    return u;
  }
}

/** Page-level key for single-video pages (Bilibili / YouTube) whose <video> is a blob */
export function pageKeyOf(u) {
  try {
    const x = new URL(u);
    const h = x.hostname;
    if (/(^|\.)bilibili\.com$/.test(h)) {
      const p = x.searchParams.get('p');
      return 'page:' + x.origin + x.pathname + (p && p !== '1' ? '?p=' + p : '');
    }
    if (/(^|\.)youtube\.com$/.test(h) || h === 'youtu.be') {
      const v = x.searchParams.get('v') || x.pathname.split('/').filter(Boolean).pop();
      return 'page:yt:' + v;
    }
    return 'page:' + x.origin + x.pathname;
  } catch {
    return 'page:' + u;
  }
}

export function safeName(s, max = 80) {
  s = String(s || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (s.length > max) s = s.slice(0, max).trim();
  return s;
}

export function fmtBytes(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return (n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i];
}

export function fmtDur(s) {
  if (!s || !isFinite(s)) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
}

/** Duration as a file-name-safe string: 45s, 5m32s, 1h02m03s */
export function fmtDurName(s) {
  if (!s || !isFinite(s)) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  if (h) return `${h}h${p(m)}m${p(ss)}s`;
  if (m) return `${m}m${p(ss)}s`;
  return `${ss}s`;
}

export const NAME_TOKENS = ['{tab}', '{name}', '{duration}', '{resolution}'];

/**
 * Expand a file name template. Unknown / empty values become empty strings, then
 * leftover empty brackets and dangling separators are cleaned up.
 *   {tab}         page (tab) title
 *   {name}        the media's own name (file name, or the video title on site extractors)
 *   {duration}    e.g. 5m32s
 *   {resolution}  e.g. 1080p for videos, 1920x1080 for images
 */
export function formatName(tpl, vars, max = 150) {
  const clean = (x) => safeName(x, 120);
  let s = String(tpl || '{tab}').replace(/\{(tab|name|duration|resolution)\}/g, (_, k) => clean(vars[k] || ''));
  s = s.replace(/\[\s*\]|\(\s*\)|\{\s*\}/g, '');
  s = safeName(s, max);
  return s.replace(/^[\s._-]+|[\s._-]+$/g, '');
}

export const PATH_TOKENS = ['{site}', '{date}', '{year}', '{month}'];

/**
 * Expand the save path template into a relative folder like "VictorLoad/example.com/" ('' = Downloads itself).
 * Each segment is cleaned of characters Windows rejects; empty, "." and ".." segments are dropped, so the
 * result can never leave the Downloads folder.
 *   {site}   host name of the page, without "www."
 *   {date}   2026-11-08
 *   {year} {month}   2026 / 11
 */
export function expandSavePath(tpl, vars = {}, now = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  const y = String(now.getFullYear());
  const m = p2(now.getMonth() + 1);
  const v = { site: vars.site || 'misc', date: `${y}-${m}-${p2(now.getDate())}`, year: y, month: m };
  const segs = String(tpl ?? '')
    .replace(/\{(site|date|year|month)\}/g, (_, k) => safeName(v[k], 100))
    .split(/[\\/]+/)
    .map((x) => safeName(x, 100))
    .filter((x) => x && x !== '.' && x !== '..');
  return segs.length ? segs.join('/') + '/' : '';
}

export function maxHeight(it) {
  let h = it.h || 0;
  for (const q of it.qualities || []) h = Math.max(h, q.height || 0);
  return h;
}

// ---- Main-content rules ----
/**
 * Returns the set of ids of the "main" images.
 * Rules: remembered tag structure > site rules (e.g. Twitter tweetPhoto) > size/weight thresholds,
 * finally larger images sharing a tag structure with a main image are promoted to main as well.
 */
export function classifyImages(items, S, remSigs, dims) {
  const main = new Set();
  const mainSigs = new Set();
  for (const it of items) {
    if (isMainImage(it, S, remSigs, dims[it.id])) {
      main.add(it.id);
      if (it.sig && it.siteMain == null && !it.upgraded) mainSigs.add(it.sig);
    }
  }
  for (const it of items) {
    if (main.has(it.id) || it.siteMain === false || it.inChrome) continue;
    const w = it.w || dims[it.id]?.w || 0;
    const h = it.h || dims[it.id]?.h || 0;
    if (it.sig && mainSigs.has(it.sig) && w >= 120 && h >= 120) main.add(it.id);
  }
  return main;
}

export function isMainImage(it, S, remSigs, dim) {
  if (it.sig && remSigs.has(it.sig)) return true;
  if (it.siteMain === false) return false;
  if (it.siteMain === true) return true;
  if (it.inChrome) return false;
  if (it.upgraded) return (it.rw || 0) >= 100 && (it.rh || 0) >= 100;
  const w = it.w || dim?.w || 0;
  const h = it.h || dim?.h || 0;
  if (!w || !h) return false;
  if (Math.max(w, h) / Math.min(w, h) > 10) return false;
  if (w < S.imgMinW || h < S.imgMinH) return false;
  if (it.size && it.size < S.imgMinKB * 1024) return false;
  return true;
}

export function isMainVideo(it, S, remSigs) {
  if (it.sig && remSigs.has(it.sig)) return true;
  if (it.siteMain === true) return true;
  const h = maxHeight(it) || it.rh || 0;
  const w = it.w || it.rw || 0;
  if (h && h < S.vidMinH) return false;
  if (w && w < S.vidMinW) return false;
  if (it.duration && it.duration < S.vidMinDur) return false;
  const size = it.size || it.qualities?.[0]?.size || 0;
  if (size && S.vidMinMB && size < S.vidMinMB * 1024 * 1024) return false;
  return true;
}
