// Background service worker: collects what the pages report, sniffs network requests,
// runs the downloads and keeps the history.
import {
  mergeSettings,
  expandSavePath,
  HISTORY_LIMIT,
  normKey,
  pageKeyOf,
  hostOf,
  safeName,
  formatName,
  fmtDurName,
  keyHash,
  downloadedKeySet,
  compactHistoryRecord,
  isHistoryQuotaError,
} from './shared.js';
import { siteOf, extractSite, hasVideoExtractor } from './sites.js';
import { parseM3U8, EXTERNAL_AUDIO_ERROR } from './hlsparse.js';

// ---- State ----
const tabs = new Map(); // tabId -> {pageUrl,title,frames,net,sizes,netImgs,site}
const downloadedKeys = new Set(); // keys of everything already downloaded
let pending = {}; // downloadId -> {itemId, record, jobId}
const jobs = new Map(); // persisted HLS queue, in insertion order
let loaded = null;

function load() {
  return (loaded ||= (async () => {
    const s = await chrome.storage.session.get(['tabsState', 'pending', 'captureJobs', 'hlsJobs']);
    for (const [k, v] of Object.entries(s.tabsState || {})) {
      tabs.set(+k, { frames: {}, sizes: {}, netImgs: {}, net: {}, site: null, pageUrl: '', title: '', ...v });
    }
    pending = s.pending || {};
    for (const [k, v] of Object.entries(s.hlsJobs || {})) jobs.set(k, v);
    for (const [k, v] of Object.entries(s.captureJobs || {})) captureJobs.set(k, v);
    const { history = [] } = await chrome.storage.local.get('history');
    rebuildDk(history);
  })());
}

// Holds hashed keys (see keyHash in shared.js), so it stays small and matches the compact history records
function rebuildDk(history) {
  downloadedKeys.clear();
  for (const k of downloadedKeySet(history)) downloadedKeys.add(k);
}

let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const out = {};
    for (const [id, t] of tabs) {
      out[id] = { pageUrl: t.pageUrl, title: t.title, net: t.net, site: t.site };
    }
    // Losing this only costs the sniffed list after a service worker restart; the next scan rebuilds it
    chrome.storage.session
      .set({ tabsState: out })
      .catch((e) => console.warn('[VictorLoad] could not save tab state', e));
  }, 1500);
}

function tabOf(id) {
  let t = tabs.get(id);
  if (!t) {
    t = { pageUrl: '', title: '', frames: {}, net: {}, sizes: {}, netImgs: {}, site: null };
    tabs.set(id, t);
  }
  return t;
}

async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  return mergeSettings(settings);
}

// Nobody is listening when the side panel is closed, and sendMessage rejects then: that is normal
const emit = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

// ---- State push ----
const notifyTimers = new Map();
const lastPrune = new Map();

function schedule(tabId) {
  if (notifyTimers.has(tabId)) return;
  notifyTimers.set(
    tabId,
    setTimeout(async () => {
      notifyTimers.delete(tabId);
      const t = tabs.get(tabId);
      if (!t) return;
      const now = Date.now();
      if (now - (lastPrune.get(tabId) || 0) > 3000) {
        lastPrune.set(tabId, now);
        await pruneFrames(tabId, t);
      }
      const state = buildState(tabId);
      emit({ type: 'state', tabId, state });
      // The tab can be gone by now, which makes both badge calls reject: nothing to show then
      chrome.action
        .setBadgeText({ tabId, text: state.videos.length ? String(state.videos.length) : '' })
        .catch(() => {});
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#4f46e5' }).catch(() => {});
      persist();
    }, 150),
  );
}

async function pruneFrames(tabId, t) {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    if (!frames) return;
    const ids = new Set(frames.map((f) => String(f.frameId)));
    for (const k of Object.keys(t.frames)) if (!ids.has(k)) delete t.frames[k];
  } catch {
    // The tab was closed while we asked; its state is dropped by tabs.onRemoved
  }
}

function broadcastRescan() {
  // Tabs without our content script (browser pages, not yet reloaded) reject the message: expected
  for (const id of tabs.keys()) chrome.tabs.sendMessage(id, { type: 'rescan' }).catch(() => {});
}

// ---- Building the list ----
function stripQuery(u) {
  try {
    const x = new URL(u);
    return x.origin + x.pathname;
  } catch {
    return u;
  }
}

function qKey(q) {
  if (q.type === 'capture') return 'cap:' + q.vgid + ':' + q.agid;
  return normKey(q.type === 'hls' || /\.(mp4|webm|m3u8|flv|mov)$/i.test(stripQuery(q.url)) ? stripQuery(q.url) : q.url);
}

function buildState(tabId) {
  const t = tabs.get(tabId) || tabOf(tabId);
  const imgs = new Map();
  const vids = new Map();
  const videoKeyByQuality = new Map(); // quality url key -> video key

  const addVideo = (v) => {
    const qs = v.qualities || [];
    const key = v.key || (qs[0] ? 'v:' + qKey(qs[0]) : null);
    if (!key) return;
    // Merge with an existing item through any quality URL
    let ex = vids.get(key);
    if (!ex) for (const q of qs) if (videoKeyByQuality.has(qKey(q))) ex = vids.get(videoKeyByQuality.get(qKey(q)));
    if (ex) {
      for (const q of qs) {
        const match = ex.qualities.find((e) => qKey(e) === qKey(q));
        if (!match) ex.qualities.push(q);
        else if (q.error) match.error = q.error;
      }
      for (const f of ['thumb', 'w', 'h', 'duration', 'sig', 'size', 'capture']) if (!ex[f] && v[f]) ex[f] = v[f];
      if (v.capture) ex.capture = v.capture;
      if (ex.qualities.length || ex.capture) delete ex.error;
      if (ex.capture) ex.title = v.capture ? v.title || ex.title : ex.title;
      ex.keys = [...new Set([...(ex.keys || []), ...(v.keys || [])])];
      return;
    }
    const item = {
      ...v,
      id: key,
      kind: 'video',
      title: v.title || t.title,
      qualities: qs.map((q) => ({ ...q })),
      keys: [...new Set([...(v.keys || []), key])],
    };
    vids.set(key, item);
    for (const q of qs) videoKeyByQuality.set(qKey(q), key);
  };

  for (const fr of Object.values(t.frames)) {
    for (const im of fr.images || []) {
      const k = normKey(im.url);
      const ex = imgs.get(k);
      if (ex) {
        for (const f of ['w', 'h', 'rw', 'rh']) if (!ex[f] && im[f]) ex[f] = im[f];
        continue;
      }
      const size = t.sizes[im.url] || t.sizes[im.thumb] || 0;
      const mime = t.netImgs[im.url]?.mime || t.netImgs[im.thumb]?.mime || '';
      imgs.set(k, { ...im, id: 'i:' + k, kind: 'image', size, mime });
    }
    for (const v of fr.videos || []) addVideo(v);
    for (const v of fr.site || []) addVideo(v);
  }
  for (const v of t.site?.items || []) addVideo(v);
  if (!hasVideoExtractor(t.pageUrl)) {
    for (const v of Object.values(t.net)) {
      addVideo({ ...v, qualities: v.qualities.map((q) => ({ ...q })) });
    }
  }
  for (const v of vids.values()) {
    if (!v.size) v.size = t.sizes[v.qualities[0]?.url] || 0;
    v.qualities.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0));
  }

  // Large images seen only in network requests (e.g. CSS backgrounds)
  let n = 0;
  for (const [url, info] of Object.entries(t.netImgs)) {
    const k = normKey(url);
    if (imgs.has(k) || n > 300) continue;
    n++;
    imgs.set(k, {
      id: 'i:' + k,
      kind: 'image',
      url,
      thumb: url,
      w: 0,
      h: 0,
      rw: 0,
      rh: 0,
      size: info.size,
      mime: info.mime,
      sig: 'net',
      inChrome: false,
      keys: [k],
      net: true,
    });
  }

  return {
    tabId,
    pageUrl: t.pageUrl,
    title: t.title,
    host: hostOf(t.pageUrl),
    images: [...imgs.values()],
    videos: [...vids.values()],
    noScan: Object.keys(t.frames).length === 0,
    loading: !!t.site?.loading,
    siteError: t.site?.error || '',
  };
}

// ---- Site extraction ----
async function maybeExtract(tabId, t) {
  const site = siteOf(t.pageUrl);
  if (!site || site === 'twitter') {
    t.site = null;
    return;
  }
  if (t.site && t.site.url === t.pageUrl) return;
  const url = t.pageUrl;
  const request = { url, items: [], loading: true, error: '' };
  t.site = request;
  schedule(tabId);
  let items = [];
  let error = '';
  try {
    items = await extractSite(site, url);
  } catch (e) {
    error = String(e.message || e);
  }
  const cur = tabs.get(tabId);
  if (!cur || cur.site !== request) return;
  cur.site = { url, items, loading: false, error };
  schedule(tabId);
}

// ---- Content script messages ----
async function onScan(msg, sender) {
  const tabId = sender.tab?.id;
  if (tabId == null) return { down: [] };
  const t = tabOf(tabId);
  if (sender.frameId === 0) {
    const changed = !!msg.pageUrl && t.pageUrl !== msg.pageUrl;
    if (changed && t.pageUrl) {
      // SPA navigation has no onCommitted event. Drop every source belonging to the previous page.
      t.frames = {};
      t.net = {};
      t.sizes = {};
      t.netImgs = {};
      t.site = null;
      t.title = '';
    }
    t.pageUrl = msg.pageUrl || t.pageUrl;
    t.title = msg.title || t.title;
    if (changed || !t.site) maybeExtract(tabId, t);
  }
  t.frames[sender.frameId] = { images: msg.images || [], videos: msg.videos || [], site: msg.site || [] };
  schedule(tabId);
  return { down: (msg.keys || []).filter((k) => downloadedKeys.has(keyHash(k))) };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'offscreen') return;
  (async () => {
    await load();
    switch (msg.type) {
      case 'scan':
        return onScan(msg, sender);
      case 'sync-ui-mode':
        await syncUiMode();
        return { ok: true };
      case 'getState': {
        const t = tabOf(msg.tabId);
        if (!t.pageUrl) {
          // The page has not reported yet (e.g. the tab was open before the extension was installed): ask the tab
          try {
            const tab = await chrome.tabs.get(msg.tabId);
            t.pageUrl = tab.url || '';
            t.title = tab.title || '';
          } catch {
            // The tab is gone; buildState below reports an empty page
          }
        }
        chrome.tabs.sendMessage(msg.tabId, { type: 'rescan' }).catch(() => {});
        if (t.pageUrl && !t.site) maybeExtract(msg.tabId, t);
        return buildState(msg.tabId);
      }
      case 'download':
        await handleDownload(msg.tabId, msg.entries);
        return { ok: true };
      case 'refresh': {
        // Start over: re-read the tab, forget the old page data, make sure the content script
        // is there, rescan and run the site extractor again.
        const t = tabOf(msg.tabId);
        try {
          const tab = await chrome.tabs.get(msg.tabId);
          t.pageUrl = tab.url || t.pageUrl;
          t.title = tab.title || t.title;
        } catch {
          // The tab is gone; keep the cached values
        }
        t.frames = {};
        t.site = null;
        try {
          await chrome.scripting.executeScript({
            target: { tabId: msg.tabId, allFrames: true },
            files: ['src/content.js'],
          });
        } catch (e) {
          // Expected on pages we may not script (browser pages, the store); the panel shows "no page data" then
          console.warn('[VictorLoad] could not inject the content script', e);
        }
        chrome.tabs.sendMessage(msg.tabId, { type: 'rescan' }).catch(() => {});
        maybeExtract(msg.tabId, t);
        await new Promise((r) => setTimeout(r, 400));
        return buildState(msg.tabId);
      }
      case 'capture-ctl':
        try {
          const reply = await withTimeout(
            chrome.tabs.sendMessage(msg.tabId, { type: 'cap-ctl', cmd: msg.cmd, requestId: uid() }, { frameId: 0 }),
            5000,
          );
          if (!reply?.ok) throw new Error(reply?.error || 'No page acknowledgement');
        } catch (e) {
          console.warn('[VictorLoad] could not forward capture control', e);
          throw new Error('取消失败，请刷新视频页面后重试。');
        }
        return { ok: true };
      case 'cap-result':
        return onCapResult(msg);
      case 'hls-progress': {
        const j = jobs.get(msg.jobId);
        if (j) {
          j.contactMisses = 0;
          emit({ type: 'dl', id: j.itemId, state: 'progress', pct: msg.pct });
        }
        return;
      }
      case 'hls-done':
        return { ok: (await onHlsDone(msg)) !== false };
      case 'hls-error': {
        await failHls(msg.jobId, msg.error);
        return { ok: true };
      }
    }
  })()
    .then(sendResponse)
    .catch((e) => sendResponse({ error: String(e.message || e) }));
  return true;
});

// ---- Navigation and tabs ----
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId === 0) {
    const t = tabOf(d.tabId);
    t.frames = {};
    t.net = {};
    t.sizes = {};
    t.netImgs = {};
    t.site = null;
    t.pageUrl = d.url;
    t.title = '';
    maybeExtract(d.tabId, t);
    schedule(d.tabId);
  } else {
    const t = tabs.get(d.tabId);
    if (t) {
      delete t.frames[d.frameId];
      schedule(d.tabId);
    }
  }
});

chrome.tabs.onRemoved.addListener((id) => {
  tabs.delete(id);
  persist();
});

// ---- Network sniffing ----
chrome.webRequest.onResponseStarted.addListener(
  (d) => {
    handleNet(d).catch((e) => console.warn('[VictorLoad] network sniffing failed for', d.url, e));
  },
  { urls: ['http://*/*', 'https://*/*'], types: ['media', 'xmlhttprequest', 'other', 'image'] },
  ['responseHeaders'],
);

async function handleNet(d) {
  if (d.tabId < 0 || d.statusCode >= 400) return;
  const hdr = (n) => d.responseHeaders?.find((x) => x.name.toLowerCase() === n)?.value || '';
  const ct = hdr('content-type').toLowerCase();
  let path;
  try {
    path = new URL(d.url).pathname.toLowerCase();
  } catch {
    return;
  }
  let size = +hdr('content-length') || 0;
  const cr = hdr('content-range').match(/\/(\d+)$/);
  if (cr) size = +cr[1];

  await load();
  const t = tabOf(d.tabId);

  if (ct.startsWith('image/')) {
    if (size) t.sizes[d.url] = size;
    if (size >= 30 * 1024 && Object.keys(t.netImgs).length < 400) {
      if (!t.netImgs[d.url]) {
        t.netImgs[d.url] = { size, mime: ct };
        schedule(d.tabId);
      }
    }
    return;
  }

  const isHls = /mpegurl/.test(ct) || path.endsWith('.m3u8');
  const isSegment = /\.(ts|m4s|aac|m4a|mp3)$/.test(path) || /mp2t/.test(ct);
  const isVideo =
    !isHls &&
    !isSegment &&
    (ct.startsWith('video/') || (d.type === 'media' && /\.(mp4|webm|m4v|mov|flv|mkv)$/.test(path)));
  if (!isHls && !isVideo) return;
  if (hasVideoExtractor(t.pageUrl)) return;
  if (isVideo && size && size < 80 * 1024) return;

  const key = 'v:' + normKey(stripQuery(d.url));
  if (t.net[key]) {
    if (size && !t.net[key].size) {
      t.net[key].size = size;
      schedule(d.tabId);
    }
    return;
  }
  const ext = isHls
    ? 'ts'
    : (path.match(/\.(mp4|webm|m4v|mov|flv|mkv)$/)?.[1] ?? (ct.includes('webm') ? 'webm' : 'mp4'));
  t.net[key] = {
    key,
    source: 'net',
    title: '',
    thumb: '',
    w: 0,
    h: 0,
    size,
    duration: 0,
    sig: '',
    keys: [key],
    qualities: [
      { label: isHls ? 'HLS' : ext.toUpperCase(), height: 0, url: d.url, ext, type: isHls ? 'hls' : 'direct', size },
    ],
  };
  if (size) t.sizes[d.url] = size;
  schedule(d.tabId);
  if (isHls) enrichHls(d.tabId, key, d.url);
}

async function enrichHls(tabId, key, url) {
  const t = tabs.get(tabId);
  const item = t?.net[key];
  try {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const text = (await r.text()).slice(0, 4_000_000);
    if (!text.includes('#EXTM3U')) throw new Error('not m3u8');
    const p = parseM3U8(text, url);
    if (!item || tabs.get(tabId) !== t || t.net[key] !== item) return;
    if (p.master) {
      const seen = new Set();
      item.qualities = p.variants
        .map((v) => ({
          label: v.h ? `${v.h}p` : v.bandwidth ? `${Math.round(v.bandwidth / 1000)}kbps` : 'HLS',
          height: v.h,
          bandwidth: v.bandwidth,
          url: v.url,
          ext: 'ts',
          type: 'hls',
          error: v.externalAudio ? EXTERNAL_AUDIO_ERROR : '',
        }))
        .filter((q) => {
          const k = q.url;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      const top = p.variants.reduce((a, b) => (b.h > a.h ? b : a), { h: 0, w: 0 });
      item.w = top.w;
      item.h = top.h;
      if (!item.qualities.length) item.qualities = [{ label: 'HLS', height: 0, url, ext: 'ts', type: 'hls' }];
    } else {
      if (!p.segs.length) {
        delete t.net[key];
      } else {
        item.duration = p.duration;
        if (p.unsupported) {
          item.error = '该 HLS 使用了不支持的加密方式';
          item.errorDetail = p.unsupported;
        }
        if (p.map) item.qualities[0].ext = 'mp4';
      }
    }
  } catch (e) {
    // Keep the original entry so a download can still be attempted
    console.warn('[VictorLoad] could not read the HLS playlist', url, e);
  }
  schedule(tabId);
}

// ---- Downloads ----
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

async function handleDownload(tabId, entries) {
  const S = await getSettings();
  const t = tabs.get(tabId);
  const host = hostOf(t?.pageUrl || '') || 'misc';
  const pageUrl = t?.pageUrl || '';
  // {tab} should be the title the browser shows, so ask the tab itself. Our cached copy
  // can be empty or stale (service worker restart, SPA navigation).
  let tabTitle = t?.title || '';
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.title) tabTitle = tab.title;
  } catch {
    // The tab is gone; the cached title is the best we have
  }
  // Some pages put an unread count in front of the title, e.g. "(3) ". Drop it.
  tabTitle = tabTitle.replace(/^\(\d+\)\s*/, '');
  for (const e of entries) {
    try {
      await downloadOne(S, host, pageUrl, e.item, e.q | 0, tabId, tabTitle, !!e.force);
    } catch (err) {
      emit({ type: 'dl', id: e.item.id, state: 'error', msg: String(err.message || err) });
    }
  }
}

function imgExt(url, mime) {
  if (url.startsWith('data:')) {
    const m = url.match(/^data:image\/(\w+)/);
    return m ? m[1].replace('jpeg', 'jpg') : 'png';
  }
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\.(jpe?g|png|gif|webp|avif|bmp|svg|ico|heic)$/i);
    if (m) return m[1].toLowerCase().replace('jpeg', 'jpg');
    const f = u.searchParams.get('format');
    if (f) return f.toLowerCase();
  } catch {
    // Not a parseable URL: fall back to the MIME type below
  }
  const mm = (mime || '').match(/image\/([\w.+-]+)/);
  if (mm) return mm[1].replace('jpeg', 'jpg').replace('svg+xml', 'svg');
  return 'jpg';
}

function imgBase(url) {
  if (url.startsWith('data:')) return 'image';
  try {
    const seg = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    return safeName(seg.replace(/\.\w{2,5}$/, ''), 60) || 'image';
  } catch {
    return 'image';
  }
}

function recordKeys(item, q) {
  return [
    ...new Set(
      [
        ...(item.keys || []),
        normKey(item.url || ''),
        normKey(item.thumb || ''),
        q?.url ? qKey(q) : '',
        q?.url ? normKey(q.url) : '',
      ].filter(Boolean),
    ),
  ];
}

const captureJobs = new Map(); // YouTube segment-capture save jobs

function saveCapJobs() {
  chrome.storage.session
    .set({ captureJobs: Object.fromEntries(captureJobs) })
    .catch((e) => console.warn('[VictorLoad] could not save capture jobs', e));
}

async function onCapResult(msg) {
  const j = captureJobs.get(msg.jobId);
  if (!j) {
    // We lost track of this job (the service worker restarted), but a finished save
    // still belongs in the history.
    if (msg.state === 'done' && msg.pageUrl) {
      await addHistory({
        kind: 'video',
        title: (msg.title || '').replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube$/, ''),
        pageUrl: msg.pageUrl,
        host: hostOf(msg.pageUrl),
        thumb: '',
        url: msg.pageUrl,
        q: '',
        keys: [pageKeyOf(msg.pageUrl)],
        name: msg.name || '',
      });
    }
    return;
  }
  j.seen = true;
  if (msg.state === 'progress') emit({ type: 'dl', id: j.itemId, state: 'progress', pct: msg.pct || 0 });
  else if (msg.state === 'buffering') emit({ type: 'dl', id: j.itemId, state: 'buffering', pct: msg.pct || 0 });
  else if (msg.state === 'stuck') {
    // Gaps we could not fill: the side panel asks whether to save anyway
    captureJobs.delete(msg.jobId);
    saveCapJobs();
    emit({ type: 'dl', id: j.itemId, state: 'stuck', holes: msg.holes || 0, gaps: msg.gaps || [] });
  } else if (msg.state === 'cancelled') {
    captureJobs.delete(msg.jobId);
    saveCapJobs();
    emit({ type: 'dl', id: j.itemId, state: 'cancelled' });
  } else if (msg.state === 'done') {
    captureJobs.delete(msg.jobId);
    saveCapJobs();
    await addHistory({ ...j.record, name: msg.name || '' });
    emit({ type: 'dl', id: j.itemId, state: 'done' });
  } else if (msg.state === 'error') {
    captureJobs.delete(msg.jobId);
    saveCapJobs();
    emit({ type: 'dl', id: j.itemId, state: 'error', msg: msg.error || '保存失败' });
  }
}

/** The video's own name: the title for site extractors, otherwise the file name in the URL */
function ownVideoName(item, q) {
  if (item.source === 'site' && item.title) return item.title;
  try {
    const seg = decodeURIComponent(new URL(q.url).pathname.split('/').pop() || '');
    const n = seg.replace(/\.\w{2,5}$/, '');
    if (n && !/^(index|playlist|master|manifest|chunklist|video|stream)$/i.test(n)) return n;
  } catch {
    // Not a parseable URL: use the title below
  }
  return item.title || '';
}

async function downloadOne(S, host, pageUrl, item, qi, tabId, tabTitle, force) {
  const dir = expandSavePath(S.savePath, { site: host });
  const id = item.id;

  if (item.kind === 'image') {
    const ext = imgExt(item.url, item.mime);
    const own = imgBase(item.url);
    const stem =
      formatName(S.nameFormat, {
        tab: tabTitle,
        name: own,
        resolution: item.w && item.h ? `${item.w}x${item.h}` : '',
      }) || own;
    const name = `${dir}${stem}.${ext}`;
    const record = {
      kind: 'image',
      title: item.title || '',
      pageUrl,
      host,
      thumb: item.thumb || item.url,
      url: item.url,
      q: item.w && item.h ? `${item.w}×${item.h}` : '',
      keys: recordKeys(item),
    };
    await startFile(item.url, name, id, record);
    return;
  }

  const q = item.qualities?.[qi] || item.qualities?.[0];
  if (!q) throw new Error(item.error || '没有可下载的地址');
  if (q.error) throw new Error(q.error);
  const resolution = q.height ? `${q.height}p` : item.w && item.h ? `${item.w}x${item.h}` : item.h ? `${item.h}p` : '';
  const base =
    formatName(S.nameFormat, {
      tab: tabTitle,
      name: ownVideoName(item, q),
      duration: fmtDurName(item.duration),
      resolution,
    }) ||
    safeName(item.title || host || 'video', 90) ||
    'video';
  const record = {
    kind: 'video',
    title: item.title || '',
    pageUrl,
    host,
    thumb: item.thumb || '',
    url: q.url,
    q: q.label || '',
    keys: recordKeys(item, q),
  };

  if (q.type === 'capture') {
    // mse.js (running in the page) assembles the buffered segments and saves the file itself
    const jobId = uid();
    captureJobs.set(jobId, { itemId: id, record, seen: false });
    saveCapJobs();
    // If the page never answers (it was loaded before the extension was updated and still runs
    // the old script), report an error instead of leaving the button hanging.
    setTimeout(() => {
      const j = captureJobs.get(jobId);
      if (j && !j.seen) {
        captureJobs.delete(jobId);
        saveCapJobs();
        emit({ type: 'dl', id, state: 'error', msg: '页面脚本没有响应，请刷新页面后重试' });
      }
    }, 8000);
    // Not fully buffered: let the page fill the gaps first ("auto download"), unless the user chose to save as is
    const auto = !force && (q.cov < 0.98 || q.holes > 0);
    await chrome.tabs.sendMessage(
      tabId,
      { type: 'cap-save', jobId, auto, vgid: q.vgid, agid: q.agid, name: `${base}` },
      { frameId: 0 },
    );
    return;
  }
  if (q.type === 'hls') {
    const name = `${dir}${base}.${q.ext || 'ts'}`;
    emit({ type: 'dl', id, state: 'queued' });
    const jobId = uid();
    jobs.set(jobId, { itemId: id, url: q.url, filename: name, record, state: 'queued' });
    try {
      await saveHlsJobs();
    } catch (e) {
      jobs.delete(jobId);
      throw e;
    }
    wakeHls();
    return;
  }
  if (q.type === 'split' && q.audioUrl) {
    await startFile(q.audioUrl, `${dir}${base}.audio.${q.audioExt || 'm4a'}`, id, null);
    await startFile(q.url, `${dir}${base}.video.${q.ext || 'mp4'}`, id, record);
    return;
  }
  await startFile(q.url, `${dir}${base}.${q.ext || 'mp4'}`, id, record);
}

async function startFile(url, filename, itemId, record) {
  console.info('[VictorLoad] download as', filename);
  const dlId = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
  pending[dlId] = { itemId, record, aux: !record };
  await chrome.storage.session.set({ pending });
  emit({ type: 'dl', id: itemId, state: 'start' });
  return dlId;
}

async function onDownloadChanged(delta) {
  if (!delta.state) return;
  await load();
  const p = pending[delta.id];
  if (!p) return;
  const st = delta.state.current;
  if (st !== 'complete' && st !== 'interrupted') return;
  delete pending[delta.id];
  chrome.storage.session
    .set({ pending })
    .catch((e) => console.warn('[VictorLoad] could not save pending downloads', e));
  // The offscreen document may already be closed, in which case there is nothing left to revoke
  if (p.jobId) chrome.runtime.sendMessage({ target: 'offscreen', type: 'revoke', jobId: p.jobId }).catch(() => {});
  if (st === 'complete') {
    if (p.record) {
      const [d] = await chrome.downloads.search({ id: delta.id });
      const rec = { ...p.record, name: (d?.filename || '').split(/[\\/]/).pop() };
      await addHistory(rec);
      emit({ type: 'dl', id: p.itemId, state: 'done' });
    }
  } else {
    emit({ type: 'dl', id: p.itemId, state: 'error', msg: delta.error?.current || '下载中断' });
  }
}
chrome.downloads.onChanged.addListener(onDownloadChanged);

// ---- History ----
// All writes go through one queue because every write replaces the whole array.
let histLock = Promise.resolve();

/** Tell the user the history could not be kept in full. The side panel shows it now or when it opens. */
async function setHistoryNotice(notice) {
  const n = { ...notice, time: Date.now() };
  try {
    await chrome.storage.session.set({ historyNotice: n });
  } catch (e) {
    console.warn('[VictorLoad] could not store the history notice', e);
  }
  emit({ type: 'history-notice', notice: n });
}

/**
 * Write the history. When the storage quota is exceeded, drop the oldest 10% and try again,
 * so a full history keeps working instead of silently losing every new download.
 * Returns how many records were dropped.
 */
async function writeHistory(history) {
  let dropped = 0;
  for (;;) {
    try {
      await chrome.storage.local.set({ history });
      return dropped;
    } catch (e) {
      if (!isHistoryQuotaError(e) || history.length <= 1) throw e;
      const cut = Math.max(1, Math.ceil(history.length * 0.1));
      history.length -= cut;
      dropped += cut;
    }
  }
}

function queueHistory(task) {
  // A failed write must not poison the queue, otherwise every later write would be skipped
  histLock = histLock.then(task).catch(async (e) => {
    console.warn('[VictorLoad] could not write the history', e);
    await setHistoryNotice({ kind: 'failed', error: String((e && e.message) || e) });
  });
  return histLock;
}

function addHistory(rec) {
  return queueHistory(async () => {
    const { history = [] } = await chrome.storage.local.get('history');
    history.unshift(compactHistoryRecord({ id: uid(), time: Date.now(), ...rec }));
    if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
    const dropped = await writeHistory(history);
    if (dropped) await setHistoryNotice({ kind: 'trimmed', dropped });
  });
}

chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && ch.history) {
    rebuildDk(ch.history.newValue || []);
    broadcastRescan();
  }
  if (area === 'local' && ch.settings) {
    broadcastRescan();
    syncH264();
    syncUiMode();
  }
});

// ---- UI mode: side panel (default) or popup ----
async function syncUiMode() {
  try {
    const S = await getSettings();
    // Some Chromium builds have no side panel API; the popup is the only UI they can show
    const hasSidePanel = Boolean(chrome.sidePanel?.setPanelBehavior);
    const popup = S.uiMode === 'popup' || !hasSidePanel;
    if (hasSidePanel) await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: !popup });
    await chrome.action.setPopup({ popup: popup ? 'src/sidepanel.html?popup=1' : '' });
  } catch (e) {
    console.warn('[VictorLoad] could not apply the display mode', e);
  }
}
chrome.runtime.onInstalled.addListener(syncUiMode);
chrome.runtime.onStartup.addListener(syncUiMode);
syncUiMode();

// ---- YouTube: optional "H.264 only" script registration ----
// Runs are queued: install, startup and a settings change can fire together and would register the script twice
let h264Queue = Promise.resolve();
const syncH264 = () => (h264Queue = h264Queue.then(syncH264Now));
async function syncH264Now() {
  try {
    const S = await getSettings();
    const reg = await chrome.scripting.getRegisteredContentScripts({ ids: ['vl-h264'] });
    if (S.ytH264 && !reg.length) {
      await chrome.scripting.registerContentScripts([
        {
          id: 'vl-h264',
          matches: ['*://*.youtube.com/*'],
          js: ['src/h264.js'],
          runAt: 'document_start',
          world: 'MAIN',
          persistAcrossSessions: true,
        },
      ]);
    } else if (!S.ytH264 && reg.length) {
      await chrome.scripting.unregisterContentScripts({ ids: ['vl-h264'] });
    }
  } catch (e) {
    console.warn('[VictorLoad] could not update the YouTube H.264 script', e);
  }
}
// Tabs that were open before an install or update don't have the content script yet, so add it.
async function injectExisting() {
  try {
    const all = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    for (const tab of all) {
      chrome.scripting
        .executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['src/content.js'] })
        // Pages we may not script (browser pages, the store) reject: expected
        .catch(() => {});
    }
  } catch (e) {
    console.warn('[VictorLoad] could not list tabs to add the content script', e);
  }
}
chrome.runtime.onInstalled.addListener(injectExisting);
chrome.runtime.onInstalled.addListener(syncH264);
chrome.runtime.onStartup.addListener(syncH264);
syncH264();

// ---- HLS (offscreen) ----
const HLS_ALARM = 'victorload-hls-watchdog';
let hlsAlarmScheduled = false;

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Message acknowledgement timed out')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function syncHlsAlarm() {
  if (!jobs.size) {
    await chrome.alarms.clear(HLS_ALARM);
    hlsAlarmScheduled = false;
  } else if (!hlsAlarmScheduled) {
    await chrome.alarms.create(HLS_ALARM, { periodInMinutes: 1 });
    hlsAlarmScheduled = true;
  }
}

async function reconcileHls() {
  await load();
  const first = jobs.entries().next().value;
  if (!first) return syncHlsAlarm();
  const [jobId, j] = first;
  if (j.state === 'queued') return wakeHls();
  if (j.state === 'ready') return onHlsDone({ jobId, blobUrl: j.blobUrl, ext: j.ext });
  try {
    const reply = await withTimeout(
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'hls-status', jobId }),
      10000,
    );
    if (jobs.get(jobId) !== j) return;
    if (reply?.result?.type === 'hls-done') return onHlsDone({ ...reply.result, jobId });
    if (reply?.result?.type === 'hls-error') return failHls(jobId, reply.result.error);
    if (reply?.state !== 'running') throw new Error('Offscreen job is unavailable');
    j.contactMisses = 0;
    await saveHlsJobs();
    emit({ type: 'dl', id: j.itemId, state: 'progress', pct: reply.pct || 0 });
  } catch (e) {
    if (jobs.get(jobId) !== j) return;
    console.warn('[VictorLoad] could not reach the HLS job', jobId, e);
    j.contactMisses = (j.contactMisses || 0) + 1;
    if (j.contactMisses >= 2) return failHls(jobId, '下载任务失去连接，请重试。');
    await saveHlsJobs();
    emit({ type: 'dl', id: j.itemId, state: 'progress', reconnecting: true });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HLS_ALARM) {
    return reconcileHls().catch((e) => console.warn('[VictorLoad] HLS recovery check failed', e));
  }
});

async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (ctx.length) return;
  await chrome.offscreen.createDocument({
    url: 'src/offscreen.html',
    reasons: ['BLOBS'],
    justification: '把 HLS 分片合并为可下载的文件',
  });
}

let hlsWrites = Promise.resolve();
function saveHlsJobs(withPending = false) {
  // Serialize snapshots so an older write cannot resurrect an already completed job.
  const write = hlsWrites.then(() =>
    chrome.storage.session.set({ hlsJobs: Object.fromEntries(jobs), ...(withPending ? { pending } : {}) }),
  );
  hlsWrites = write.catch(() => {}); // allow the next write to recover; the caller handles this failure
  return write;
}

const hlsDispatched = new Set();
const hlsFinalizing = new Set();
let hlsPump = Promise.resolve();
function wakeHls() {
  hlsPump = hlsPump
    .then(async () => {
      await load();
      const first = jobs.entries().next().value;
      if (!first) return syncHlsAlarm();
      const [jobId, j] = first;
      try {
        await syncHlsAlarm();
        if (j.state === 'ready') return onHlsDone({ jobId, blobUrl: j.blobUrl, ext: j.ext });
        if (hlsDispatched.has(jobId)) return;
        hlsDispatched.add(jobId);
        j.state = 'running';
        await saveHlsJobs();
        await ensureOffscreen();
        emit({ type: 'dl', id: j.itemId, state: 'progress', pct: 0 });
        // Idempotent in offscreen.js: reattaches to a running job or replays its completed result.
        await chrome.runtime.sendMessage({ target: 'offscreen', type: 'hls-start', jobId, url: j.url });
      } catch (e) {
        await failHls(jobId, String(e.message || e));
      }
    })
    .catch((e) => console.warn('[VictorLoad] could not resume the HLS queue', e));
  return hlsPump;
}

async function failHls(jobId, error) {
  const j = jobs.get(jobId);
  if (!j) return;
  jobs.delete(jobId);
  hlsDispatched.delete(jobId);
  emit({ type: 'dl', id: j.itemId, state: 'error', msg: error });
  try {
    await saveHlsJobs();
  } finally {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'revoke', jobId }).catch(() => {});
    wakeHls();
  }
}

async function onHlsDone(msg) {
  const j = jobs.get(msg.jobId);
  if (!j) return true;
  if (hlsFinalizing.has(msg.jobId)) return false;
  hlsFinalizing.add(msg.jobId);
  let startingDownload = false;
  try {
    j.state = 'ready';
    j.blobUrl = msg.blobUrl;
    j.ext = msg.ext;
    await saveHlsJobs();
    const filename = j.filename.replace(/\.(ts|mp4)$/i, '.' + (msg.ext || 'ts'));
    // A worker can stop after download() succeeds but before pending is saved. Reuse that
    // browser download on recovery instead of saving the same Blob a second time.
    const [existing] = await chrome.downloads.search({ url: msg.blobUrl });
    startingDownload = !existing;
    const dlId =
      existing?.id ??
      (await chrome.downloads.download({
        url: msg.blobUrl,
        filename,
        conflictAction: 'uniquify',
        saveAs: false,
      }));
    startingDownload = false;
    pending[dlId] = { itemId: j.itemId, record: j.record, jobId: msg.jobId };
    jobs.delete(msg.jobId);
    hlsDispatched.delete(msg.jobId);
    await saveHlsJobs(true);
    emit({ type: 'dl', id: j.itemId, state: 'start' });
    // The terminal event may have arrived before this worker registered the pending record.
    const [current] = await chrome.downloads.search({ id: dlId });
    if (current?.state === 'complete' || current?.state === 'interrupted') {
      await onDownloadChanged({ id: dlId, state: { current: current.state }, error: { current: current.error } });
    }
  } catch (e) {
    if (startingDownload) {
      await failHls(msg.jobId, String(e.message || e));
      return;
    }
    emit({ type: 'dl', id: j.itemId, state: 'error', msg: String(e.message || e) });
    // Keep a durable ready result when a storage/API operation fails; it can be retried on restart.
    if (!jobs.has(msg.jobId) && !Object.values(pending).some((p) => p.jobId === msg.jobId)) jobs.set(msg.jobId, j);
    return false;
  } finally {
    hlsFinalizing.delete(msg.jobId);
  }
  if (!jobs.has(msg.jobId)) wakeHls();
  return true;
}

// Resume queued/running jobs even when the first wake event is unrelated to downloads.
wakeHls();
